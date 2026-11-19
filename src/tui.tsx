import { Plugin } from "@opencode/plugin/tui";
import { SyntaxStyle } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { Nudge } from "./plan-view.ts";
import { DEFAULT_REVIEW_NUDGE, diffPlans, diffSessions, progressLine, reviewNudge, taskLine, taskState, visibleTasks } from "./plan-view.ts";
import type { SessionSnapshot, StatusEvent, TaskState } from "./plan-view.ts";
import { PLAN_LIMITS, PLANS_DIR, isPlanFileName, loadPlans, partitionPlans, planFromText, readPlanText } from "./plans.ts";
import type { PlanReadState, PlanSummary } from "./plans.ts";
import { fromMetadata, summarize } from "./review.ts";

/**
 * ARIA in the OpenCode TUI, loaded from the same `plugins` entry as the server part
 * (`exports["./tui"]`). It reads `.aria/plans/*.md` and OpenCode's own session data. The only thing
 * it stores is which plan you picked for a session.
 *
 * 1. Sidebar "ARIA Plan" (collapsible): the plan you selected for this session, else the plan
 *    owned by this session tree (`session:` = root session id), as a task list coloured by state
 *    (○ pending, ● in progress, ◐ executed without evidence, ✔ evidence recorded, ✗ blocked).
 *    `[select]` or `/aria-plan` picks a plan; `/aria-plan-toggle` collapses the task list.
 *    Review reminders and blocker counts remain visible when collapsed. OpenCode's native sidebar owns the session
 *    family list; ARIA does not repeat it here.
 * 2. Plan panel (click the plan title, or `/aria-plan-open`): the selected plan as rendered
 *    Markdown, scrollable, with copy (OSC 52, works over SSH), raw/rendered toggle and fullscreen.
 * 3. Toasts for plan changes. Agent lifecycle is shown by OpenCode's native sidebar, not repeated
 *    as ARIA toasts. Attention-worthy plan changes, agent failures and root-session completion may
 *    produce an OS notification while the terminal is unfocused. The first read is a baseline, so
 *    nothing old is replayed.
 *
 * Plan files are read through the OpenCode server's file API, so this works when the TUI runs
 * somewhere else than the project (SSH); if that API fails, the confined local reader is used.
 * Refresh: OpenCode events schedule one debounced refresh (at most every 500 ms); a 5 s timer
 * catches plan edits made outside OpenCode. When nothing current can be read, the UI says so
 * instead of showing stale data.
 */

const PANEL = "aria.plan";
const REVIEW_NUDGE_EDITS = (() => {
  const n = Number(process.env.ARIA_REVIEW_NUDGE_EDITS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_REVIEW_NUDGE;
})();
const SIDEBAR_TASKS = 7;
const POLL_MS = 5000;
const DEBOUNCE_MS = 500;

interface PlanState {
  readonly read: PlanReadState | "no-directory" | "not-read";
  readonly plans: readonly PlanSummary[];
  readonly problems: readonly string[];
  readonly readAt: Date | undefined;
  /** Set when nothing current can be shown. */
  readonly unavailable: string | undefined;
}

const time = (d: Date | undefined) => (d ? d.toTimeString().slice(0, 8) : "never");

export default Plugin.define({
  id: "aria.tui",
  setup(context) {
    const [state, setState] = createSignal<PlanState>({ read: "not-read", plans: [], problems: [], readAt: undefined, unavailable: undefined });
    const [snapshot, setSnapshot] = createSignal(0);
    let previousPlans: readonly PlanSummary[] | undefined;
    let previousSessions: ReadonlyMap<string, SessionSnapshot> | undefined;
    let disposed = false;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const directory = (): string | undefined => {
      try {
        return (context.data.location.default() as { directory?: string }).directory;
      } catch {
        return undefined;
      }
    };

    const sessions = (): Map<string, SessionSnapshot> => {
      const out = new Map<string, SessionSnapshot>();
      for (const info of context.data.session.list()) {
        const running = context.data.session.status(info.id) === "running";
        out.set(info.id, {
          agent: info.agent ?? "",
          state: running ? "running" : info.outcome === "failed" ? "failed" : "idle",
          isRoot: context.data.session.root(info.id) === info.id,
        });
      }
      return out;
    };

    const notifyIfNeeded = (event: StatusEvent) => {
      if (event.attention) void context.attention.notify({ title: "ARIA", message: event.message, notification: { when: "blurred" }, sound: false }).catch(() => undefined);
    };
    const announce = (events: readonly StatusEvent[]) => {
      for (const event of events) {
        context.ui.toast.show({ title: "ARIA", message: event.message, variant: event.variant, duration: event.variant === "error" ? 8000 : 4000 });
        notifyIfNeeded(event);
      }
    };

    const location = () => context.location ?? context.data.location.default();

    /** Plans through the server's file API (works over SSH); the confined local reader is the fallback. */
    const readPlans = async (dir: string): Promise<PlanState> => {
      const readAt = new Date();
      try {
        const listing = await context.client.file.list({ location: location(), path: PLANS_DIR });
        if (!Array.isArray(listing.data)) throw new Error("no directory listing");
        const names = [
          ...new Set(
            listing.data
              .filter((item: { type?: string }) => item.type === "file" || !item.type)
              .map((item: { name?: unknown; path?: unknown }) => (typeof item.name === "string" ? item.name : String(item.path ?? "").split(/[\\/]/).pop() ?? "")),
          ),
        ]
          .filter((name) => name.endsWith(".md"))
          .sort((x, y) => (x < y ? 1 : -1));
        const plans: PlanSummary[] = [];
        const problems: string[] = [];
        for (const name of names.slice(0, PLAN_LIMITS.maxPlans)) {
          if (!isPlanFileName(name)) {
            problems.push(`skipped ${JSON.stringify(name)}: unexpected file name`);
            continue;
          }
          const bytes = await context.client.file.read({ location: location(), path: `${PLANS_DIR}/${name}` });
          if (bytes.byteLength > PLAN_LIMITS.maxBytes) {
            problems.push(`skipped ${name}: too large`);
            continue;
          }
          const plan = planFromText(name, new TextDecoder("utf-8").decode(bytes));
          if (plan) plans.push(plan);
          else problems.push(`skipped ${name}: no front matter with a status line`);
        }
        return { read: problems.length ? "partial" : plans.length ? "ok" : "empty", plans, problems, readAt, unavailable: undefined };
      } catch {
        const load = loadPlans(dir);
        return { read: load.state, plans: load.plans, problems: load.problems, readAt, unavailable: load.state === "unavailable" ? (load.problems[0] ?? "plan directory unreadable") : undefined };
      }
    };

    let refreshing = false;
    const refresh = async () => {
      pending = undefined;
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const dir = directory();
        let next: PlanState;
        if (!dir) next = { read: "no-directory", plans: [], problems: [], readAt: new Date(), unavailable: "no project directory for this TUI" };
        else {
          try {
            next = await readPlans(dir);
          } catch (error) {
            next = { read: "unavailable", plans: [], problems: [], readAt: new Date(), unavailable: (error as Error).message };
          }
        }
        if (disposed) return;
        let nextSessions: Map<string, SessionSnapshot> | undefined;
        try {
          nextSessions = sessions();
        } catch {
          nextSessions = undefined;
        }
        // Only a complete read can be compared: a partial or failed read must not produce
        // "started"/"done" events for plans that were merely skipped this time.
        const complete = next.read === "ok" || next.read === "empty" || next.read === "absent";
        if (previousPlans && complete) announce(diffPlans(previousPlans, next.plans));
        // The native OpenCode sidebar already shows agent lifecycle. Keep only attention-worthy
        // OS alerts; an in-app toast here duplicates that UI and can cover the plan panel.
        if (previousSessions && nextSessions) for (const event of diffSessions(previousSessions, nextSessions)) notifyIfNeeded(event);
        if (complete) previousPlans = next.plans;
        if (nextSessions) previousSessions = nextSessions;
        setState(next);
        setSnapshot((n) => n + 1);
      } finally {
        refreshing = false;
      }
    };

    const schedule = () => {
      if (!disposed && pending === undefined) pending = setTimeout(() => void refresh(), DEBOUNCE_MS);
    };

    void refresh();
    const stop = context.data.listen(schedule);
    const timer = setInterval(schedule, POLL_MS);

    // Resolved theme: text.feedback.{success,error} and text.muted/faint are colors (checked against
    // OpenCode 2.3's theme at runtime). A missing path leaves the default foreground, never throws.
    // The theme may hand back a store proxy rather than a real RGBA, which the renderer cannot parse
    // as a color. Convert to a plain "#rrggbb" string from the RGBA's float buffer; anything unexpected
    // yields undefined (default foreground) instead of throwing inside render.
    const themeColor = (...path: string[]): string | undefined => {
      try {
        let value: unknown = context.theme;
        for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
        if (typeof value === "string") return value;
        // Feedback colors are { base, muted } pairs: use the base color.
        if (value && typeof value === "object" && !("buffer" in value) && "base" in value) value = (value as { base: unknown }).base;
        const buffer = (value as { buffer?: ArrayLike<number> } | undefined)?.buffer;
        if (!buffer || buffer.length < 3) return undefined;
        // The buffer holds 0-255 channel values (observed in OpenCode 2.3); accept 0-1 floats too.
        const scale = Math.max(Number(buffer[0]), Number(buffer[1]), Number(buffer[2])) > 1 ? 1 : 255;
        const hex = (n: number) => Math.max(0, Math.min(255, Math.round(Number(n) * scale))).toString(16).padStart(2, "0");
        return `#${hex(buffer[0] as number)}${hex(buffer[1] as number)}${hex(buffer[2] as number)}`;
      } catch {
        return undefined;
      }
    };
    const colorOf = (state: TaskState): string | undefined => {
      switch (state) {
        case "verified":
        case "executed":
          return themeColor("text", "feedback", "success") ?? "green";
        case "active":
          return themeColor("text", "feedback", "warning") ?? "yellow";
        case "blocked":
          return themeColor("text", "feedback", "error") ?? "red";
        default:
          return themeColor("text", "muted");
      }
    };
    const toneColor = (tone: "muted" | "warning" | "error") =>
      tone === "error" ? themeColor("text", "feedback", "error") ?? "red" : tone === "warning" ? themeColor("text", "feedback", "warning") ?? "yellow" : themeColor("text", "muted");

    const rootOf = (sessionID: string): string => {
      try {
        return context.data.session.root(sessionID);
      } catch {
        return sessionID;
      }
    };

    // Which plan a session shows: the one picked for its root session; otherwise the one it owns.
    const [picked, updatePicked] = context.storage.store("current-plan", { initial: { sessions: {} } as { sessions: Record<string, string> } });
    const pickKey = (root: string) => `${directory() ?? ""}\u0000${root}`;
    const selectedFile = (sessionID: string) => picked.sessions[pickKey(rootOf(sessionID))];
    const emptyMessage = () => {
      if (state().read === "not-read") return "Loading plans…";
      if (state().unavailable) return "Plans unavailable · aria_status";
      if (state().read === "absent" || state().read === "empty") return `No plan files in ${PLANS_DIR}`;
      if (!state().plans.length) return "No readable plans · aria_status";
      return "No owned active plan · /aria-plan";
    };
    const planFor = (sessionID: string): PlanSummary | undefined => {
      snapshot();
      const root = rootOf(sessionID);
      const file = picked.sessions[pickKey(root)];
      return (file ? state().plans.find((p) => p.file === file) : undefined) ?? partitionPlans(state().plans, root).own[0];
    };

    let activePicker: ((sessionID: string) => Promise<void>) | undefined;
    let activeSession: string | undefined;
    let activeToggle: (() => void) | undefined;

    const pickPlan = async (sessionID: string) => {
      await refresh();
      const root = rootOf(sessionID);
      const current = picked.sessions[pickKey(root)] ?? "";
      const plans = state().plans;
      if (state().read === "not-read" || state().unavailable || (plans.length === 0 && !current)) {
        context.ui.toast.show({ title: "ARIA", message: emptyMessage(), variant: "warning" });
        return;
      }
      const choice = await context.ui.dialog.select({
        title: "Select plan for this session",
        current,
        options: [
          { title: "Automatic", value: "", description: "Active plan owned by this session tree" },
          ...plans.map((p) => ({
            title: p.title,
            value: p.file,
            description: `${p.file === current ? "Selected · " : ""}${p.session === root ? "This session tree" : p.session ? "Other session" : "Unowned"} · ${p.status} · ${progressLine(p)} · ${p.file}`,
          })),
        ],
      });
      if (choice === undefined) return;
      await updatePicked((draft: { sessions: Record<string, string> }) => {
        if (choice) draft.sessions[pickKey(root)] = choice as string;
        else delete draft.sessions[pickKey(root)];
      });
      setSnapshot((n) => n + 1);
    };

    const reviewOf = (sessionID: string) => {
      snapshot();
      const r = rootOf(sessionID);
      const info = context.data.session.get(r) as { metadata?: unknown } | undefined;
      return reviewNudge(summarize(fromMetadata(info?.metadata, r)), REVIEW_NUDGE_EDITS);
    };

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const [open, setOpen] = createSignal(true);
        activePicker = pickPlan;
        activeSession = sessionID;
        const toggle = () => setOpen(!open());
        activeToggle = toggle;
        onCleanup(() => {
          if (activeToggle === toggle) {
            activeToggle = undefined;
            activePicker = undefined;
            activeSession = undefined;
          }
        });
        const plan = () => planFor(sessionID);
        const selected = () => selectedFile(sessionID);
        const missingSelection = () => selected() && state().read !== "not-read" && !state().unavailable && !state().plans.some((p) => p.file === selected());
        const nudge = () => reviewOf(sessionID);
        const window = () => {
          const p = plan();
          return p ? visibleTasks(p, SIDEBAR_TASKS) : undefined;
        };
        return (
          <box flexDirection="column">
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <text wrapMode="none" truncate onMouseDown={toggle}>
                {open() ? "▼" : "▶"} ARIA Plan{plan() ? ` ${plan()?.counts.executed}/${plan()?.tasks.length}` : ""}
              </text>
              <text fg={themeColor("text", "muted")} onMouseDown={() => void pickPlan(sessionID)}>
                [select]
              </text>
            </box>
            <Show when={nudge()}>{(n: () => Nudge) => <text fg={toneColor(n().tone)} wrapMode="none" truncate>  {n().text}</text>}</Show>
            <Show when={(plan()?.counts.blocked ?? 0) > 0}>
              <text fg={colorOf("blocked")} wrapMode="none" truncate>  ✗ {plan()?.counts.blocked} blocked · /aria-plan-open</text>
            </Show>
            <Show when={missingSelection()}>
              <text fg={toneColor("warning")} wrapMode="word">  Selected plan unavailable · {plan() ? "using Automatic" : "no automatic plan"} · /aria-plan</text>
            </Show>
            <Show when={open()}>
              <Show when={!plan()}>
                <text fg={themeColor("text", "muted")} wrapMode="word">  {emptyMessage()}</text>
              </Show>
              <Show when={state().read === "partial"}>
                <text fg={toneColor("warning")} wrapMode="word">  {state().problems.length} read issue(s) · aria_status</text>
              </Show>
              <Show when={plan()}>
                {(p: () => PlanSummary) => (
                  <box flexDirection="column">
                    <text fg={themeColor("text", "action", "secondary", "base")} wrapMode="none" truncate onMouseDown={() => context.ui.panel.open(PANEL)}>
                      {selected() && !missingSelection() ? "Selected" : "Automatic"} · {p().title} ↗
                    </text>
                    <text fg={themeColor("text", "muted")} wrapMode="none" truncate>{progressLine(p())}</text>
                    <Show when={(window()?.before ?? 0) > 0}>
                      <text fg={themeColor("text", "muted")} wrapMode="none" truncate>  … {window()?.before} earlier</text>
                    </Show>
                    <For each={window()?.tasks ?? []}>{(task) => <text fg={colorOf(taskState(task))} wrapMode="none" truncate>  {taskLine(task)}</text>}</For>
                    <Show when={(window()?.after ?? 0) > 0}>
                      <text fg={themeColor("text", "muted")} wrapMode="none" truncate>  … {window()?.after} more</text>
                    </Show>
                  </box>
                )}
              </Show>
            </Show>
          </box>
        );
      },
    });

    // The selected plan as rendered Markdown, scrollable. Reads the file again on open and on `r`.
    function PlanPreview(props: { panel: { sessionID: string; focused: boolean; close: () => void; toggleFullscreen: () => void } }) {
      const [source, setSource] = createSignal("");
      const [error, setError] = createSignal("");
      const [rendered, setRendered] = createSignal(true);
      let scroll: ScrollBoxRenderable | undefined;
      let generation = 0;
      const scrollable = () => (scroll && !scroll.isDestroyed ? scroll : undefined);
      const plan = () => planFor(props.panel.sessionID);
      const accent = themeColor("text", "action", "secondary", "base") ?? "#7aa2f7";
      const base = themeColor("text", "base");
      const muted = themeColor("text", "muted");
      const style = SyntaxStyle.fromStyles(
        {
          default: { fg: base },
          "markup.heading": { fg: accent, bold: true },
          "markup.heading.1": { fg: accent, bold: true, underline: true },
          "markup.bold": { fg: base, bold: true },
          "markup.strong": { fg: base, bold: true },
          "markup.italic": { fg: muted, italic: true },
          "markup.list": { fg: accent },
          "markup.quote": { fg: muted, italic: true },
          "markup.raw": { fg: accent },
          "markup.raw.block": { fg: accent },
          "markup.link": { fg: accent, underline: true },
        },
        context.renderer.nativeScene,
      );

      const load = async () => {
        const file = plan()?.file;
        const request = ++generation;
        if (!file) {
          setSource("");
          setError("No plan selected for this session");
          return;
        }
        try {
          let text: string;
          try {
            text = new TextDecoder("utf-8").decode(await context.client.file.read({ location: location(), path: file }));
          } catch {
            const dir = directory();
            if (!dir) throw new Error("no project directory for this TUI");
            text = readPlanText(dir, file);
          }
          if (request !== generation) return;
          setSource(text);
          setError("");
        } catch (cause) {
          if (request !== generation) return;
          setSource("");
          setError(cause instanceof Error ? cause.message : "Unable to read the plan");
        }
      };
      const copy = () => {
        const text = source();
        if (!text) return context.ui.toast.show({ title: "ARIA", message: "Plan source is not available", variant: "warning" });
        const queued = context.renderer.copyToClipboardOSC52(text);
        context.ui.toast.show({ title: "ARIA", message: queued ? "Plan sent to terminal clipboard (OSC 52)" : "Terminal clipboard is unavailable (OSC 52)", variant: queued ? "success" : "warning" });
      };
      createEffect(() => {
        void plan()?.file;
        void load();
      });
      context.keymap.layer(() => ({
        priority: 100,
        enabled: () => props.panel.focused,
        commands: [
          { id: "aria.plan.preview.close", title: "Close plan", bind: "escape,q", run: props.panel.close },
          { id: "aria.plan.preview.down", title: "Scroll plan down", bind: "down,j", run: () => scrollable()?.scrollBy(1) },
          { id: "aria.plan.preview.up", title: "Scroll plan up", bind: "up,k", run: () => scrollable()?.scrollBy(-1) },
          { id: "aria.plan.preview.page-down", title: "Page down in plan", bind: "pagedown,ctrl+f", run: () => { const box = scrollable(); if (box) box.scrollBy(Math.max(1, Math.floor(box.viewport.height / 2))); } },
          { id: "aria.plan.preview.page-up", title: "Page up in plan", bind: "pageup,ctrl+b", run: () => { const box = scrollable(); if (box) box.scrollBy(-Math.max(1, Math.floor(box.viewport.height / 2))); } },
          { id: "aria.plan.preview.reload", title: "Reload plan", bind: "r", run: () => void load() },
          { id: "aria.plan.preview.copy", title: "Copy plan Markdown", bind: "y", run: copy },
          { id: "aria.plan.preview.source", title: "Toggle Markdown and source", bind: "m", run: () => setRendered(!rendered()) },
          { id: "aria.plan.preview.fullscreen", title: "Toggle plan fullscreen", bind: "f", run: props.panel.toggleFullscreen },
        ],
      }));
      onCleanup(() => {
        ++generation;
        void context.renderer.idle().then(() => style.destroy()).catch(() => {});
      });

      return (
        <box flexDirection="column" width="100%" height="100%">
          <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text fg={base} wrapMode="none" truncate flexGrow={1}>
              {plan()?.title ?? "ARIA Plan"} — read {time(state().readAt)}
            </text>
            <text fg={accent} onMouseDown={copy}>[copy]</text>
            <text fg={muted} onMouseDown={props.panel.close}>[close]</text>
          </box>
          <Show when={error()}>
            <text fg={themeColor("text", "feedback", "error")} wrapMode="word" padding={1}>{error()}</text>
          </Show>
          <Show when={!error()}>
            <scrollbox ref={(item: ScrollBoxRenderable) => { scroll = item; }} flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: true }}>
              <box paddingLeft={1} paddingRight={1} flexShrink={0}>
                <Show when={rendered()} fallback={<text fg={base} wrapMode="word">{source()}</text>}>
                  <markdown
                    content={source().replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n){1,2}/, "")}
                    syntaxStyle={style}
                    conceal
                    fg={base}
                    tableOptions={{ style: "grid", widthMode: "full", wrapMode: "word", cellPaddingX: 1, cellPaddingY: 0 }}
                  />
                </Show>
              </box>
            </scrollbox>
          </Show>
          <text fg={muted} wrapMode="none" truncate paddingLeft={1} flexShrink={0}>
            ↑↓ scroll · y copy · m Markdown/source · r reload · f fullscreen · esc close
          </text>
        </box>
      );
    }

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <PlanPreview panel={panel} />
        </Show>
      ),
    });

    // "global": reachable while the prompt has focus, like OpenCode's own slash commands
    // (a default "base" layer is not, which hid /aria-plan in OpenCode 2.3.0).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "aria.plan.toggle",
          title: "ARIA: expand/collapse sidebar plan",
          description: "Toggle the compact sidebar task list",
          group: "ARIA",
          palette: true,
          slash: { name: "aria-plan-toggle" },
          run: () => {
            if (activeToggle) activeToggle();
            else context.ui.toast.show({ message: "Open a session sidebar to toggle its plan", variant: "warning" });
          },
        },
        {
          id: "aria.plan.select",
          title: "ARIA: select plan",
          description: "Choose which plan this session shows",
          group: "ARIA",
          palette: true,
          slash: { name: "aria-plan" },
          run: () => {
            if (activePicker && activeSession) void activePicker(activeSession);
            else context.ui.toast.show({ message: "Open a session to select its plan", variant: "warning" });
          },
        },
        {
          id: "aria.plan.open",
          title: "ARIA: show plan",
          description: "Open or close the selected plan",
          group: "ARIA",
          palette: true,
          slash: { name: "aria-plan-open" },
          run: () => {
            if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close();
            else if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ message: "Open a session to view its plan", variant: "warning" });
          },
        },
      ],
    }));

    return () => {
      disposed = true;
      if (pending !== undefined) clearTimeout(pending);
      stop();
      clearInterval(timer);
    };
  },
});
