import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { diffPlans, diffSessions, progressLine, taskLabel, taskLine, visibleTasks } from "./plan-view.ts";
import type { SessionSnapshot, StatusEvent } from "./plan-view.ts";
import { isActive, loadPlans, partitionPlans } from "./plans.ts";
import type { PlanReadState, PlanSummary } from "./plans.ts";
import { fromMetadata, summarize } from "./review.ts";

/**
 * ARIA in the OpenCode TUI, loaded from the same `plugins` entry as the server part
 * (`exports["./tui"]`). It reads `.aria/plans/*.md` through the confined plan reader and
 * OpenCode's own session data, and stores nothing.
 *
 * 1. Sidebar: the plan owned by this session tree (`session:` = root session id) as a task list
 *    (○ pending, ● in progress, ◐ executed without evidence, ✔ evidence recorded, ✗ blocked),
 *    a count of other active plans, then the session family with agent, state and model.
 * 2. Plan panel (`/aria-plan` or "ARIA: show plan"): all active plans with owner and read time.
 * 3. Toasts for plan task changes and subagent start/finish/failure; OS notifications only for
 *    blocked tasks, failures, finished plans and the root session finishing, and only while the
 *    terminal is unfocused. The first read is a baseline, so nothing old is replayed.
 *
 * Refresh: OpenCode events schedule one debounced refresh (at most every 500 ms); a 5 s timer
 * catches plan edits made outside OpenCode. When plan files cannot be read from this TUI (for
 * example a remote server), the UI says so instead of showing stale data.
 */

const PANEL = "aria.plan";
const SIDEBAR_TASKS = 7;
const SIDEBAR_SESSIONS = 6;
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
    const [state, setState] = createSignal<PlanState>({ read: "not-read", plans: [], problems: [], readAt: undefined, unavailable: "not read yet" });
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

    const announce = (events: readonly StatusEvent[]) => {
      for (const event of events) {
        context.ui.toast.show({ title: "ARIA", message: event.message, variant: event.variant, duration: event.variant === "error" ? 8000 : 4000 });
        if (event.attention) void context.attention.notify({ title: "ARIA", message: event.message, notification: { when: "blurred" }, sound: false }).catch(() => undefined);
      }
    };

    const refresh = () => {
      pending = undefined;
      if (disposed) return;
      const dir = directory();
      let next: PlanState;
      if (!dir) next = { read: "no-directory", plans: [], problems: [], readAt: new Date(), unavailable: "no local project directory for this TUI" };
      else {
        try {
          const load = loadPlans(dir);
          next = {
            read: load.state,
            plans: load.plans,
            problems: load.problems,
            readAt: new Date(),
            unavailable: load.state === "unavailable" ? (load.problems[0] ?? "plan directory unreadable") : undefined,
          };
        } catch (error) {
          next = { read: "unavailable", plans: [], problems: [], readAt: new Date(), unavailable: (error as Error).message };
        }
      }
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
      if (previousSessions && nextSessions) announce(diffSessions(previousSessions, nextSessions));
      if (complete) previousPlans = next.plans;
      if (nextSessions) previousSessions = nextSessions;
      setState(next);
      setSnapshot((n) => n + 1);
    };

    const schedule = () => {
      if (!disposed && pending === undefined) pending = setTimeout(refresh, DEBOUNCE_MS);
    };

    refresh();
    const stop = context.data.listen(schedule);
    const timer = setInterval(schedule, POLL_MS);

    const active = () => state().plans.filter(isActive);

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const root = () => {
          snapshot();
          try {
            return context.data.session.root(sessionID);
          } catch {
            return sessionID;
          }
        };
        const parts = () => partitionPlans(state().plans, root());
        const plan = () => parts().own[0];
        // Review state recorded by the server plugin in the root session's metadata (observed, not self-reported).
        const review = () => {
          snapshot();
          const r = root();
          const info = context.data.session.get(r) as { metadata?: unknown } | undefined;
          const s = summarize(fromMetadata(info?.metadata, r));
          return s.disposition === "none" && s.changedSince === 0 ? undefined : s;
        };
        const window = () => {
          const p = plan();
          return p ? visibleTasks(p, SIDEBAR_TASKS) : undefined;
        };
        const rows = () => {
          snapshot();
          return context.data.session
            .family(sessionID)
            .slice(0, SIDEBAR_SESSIONS)
            .map((id) => {
              const info = context.data.session.get(id);
              const model = info?.model ? `${info.model.providerID}/${info.model.id}${info.model.variant ? `#${info.model.variant}` : ""}` : "model: session default";
              const running = context.data.session.status(id) === "running";
              const status = running ? "running" : info?.outcome === "failed" ? "failed" : "idle";
              return { id, agent: info?.agent ?? "?", title: id === sessionID ? "this session" : (info?.title ?? ""), model, status };
            });
        };
        return (
          <box flexDirection="column">
            <text>ARIA</text>
            <Show when={state().unavailable}>
              <text>  plans: unavailable ({state().unavailable})</text>
            </Show>
            <Show when={plan()}>
              <text>
                {plan()?.title} — {plan() ? progressLine(plan() as PlanSummary) : ""}
              </text>
              <Show when={(window()?.before ?? 0) > 0}>
                <text>  … {window()?.before} earlier</text>
              </Show>
              <For each={window()?.tasks ?? []}>{(task) => <text>  {taskLine(task)}</text>}</For>
              <Show when={(window()?.after ?? 0) > 0}>
                <text>  … {window()?.after} more</text>
              </Show>
            </Show>
            <Show when={review()}>
              <text>
                {"  "}review: {review()?.disposition === "none" ? "not recorded" : review()?.disposition}
                {review()?.disposition === "failed" ? ` (${review()?.unresolvedBlocking} blocking)` : ""}
                {(review()?.changedSince ?? 0) > 0 ? ` · ${review()?.changedSince} change(s) since` : ""}
              </text>
            </Show>
            <Show when={parts().other.length > 0}>
              <text>  {parts().other.length} other active plan(s) — /aria-plan</text>
            </Show>
            <Show when={state().read === "partial"}>
              <text>  plans partly read: {state().problems.length} file(s) skipped — /aria-plan</text>
            </Show>
            <For each={rows()}>
              {(row) => (
                <text>
                  {row.status === "running" ? "●" : row.status === "failed" ? "✗" : "○"} {row.agent} {row.status} — {row.title}
                  {"\n"}  {row.model}
                </text>
              )}
            </For>
          </box>
        );
      },
    });

    context.ui.slot({
      append: "session.panel",
      render: (panel) => {
        const root = () => {
          snapshot();
          try {
            return context.data.session.root(panel.sessionID);
          } catch {
            return panel.sessionID;
          }
        };
        return (
          <Show when={panel.name === PANEL}>
            <box flexDirection="column">
              <text>ARIA plans — read {time(state().readAt)}; checkboxes are plan state, "evidence recorded" is the plan's own claim</text>
              <Show when={state().unavailable}>
                <text>Plan files unavailable: {state().unavailable}. Nothing below is current.</text>
              </Show>
              <Show when={state().read === "absent"}>
                <text>No .aria/plans/ directory in this project.</text>
              </Show>
              <Show when={(state().read === "empty" || state().read === "ok") && active().length === 0}>
                <text>No active plan in .aria/plans/.</text>
              </Show>
              <Show when={state().read === "partial"}>
                <text>Partial read: the files listed at the bottom were skipped; plans shown are current, others may exist.</text>
              </Show>
              <For each={active()}>
                {(plan) => (
                  <box flexDirection="column">
                    <text>
                      {"\n"}
                      {plan.title} {plan.session === root() ? "(this session)" : plan.session ? `(session ${plan.session})` : "(no owner recorded)"}
                    </text>
                    <text>{plan.file}</text>
                    <Show when={plan.objective}>
                      <text>Objective: {plan.objective}</text>
                    </Show>
                    <text>{progressLine(plan)}</text>
                    <For each={plan.tasks}>
                      {(task) => (
                        <text>
                          {taskLine(task)}
                          {"\n"}    {taskLabel(task)}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
              <For each={state().problems}>{(problem) => <text>skipped: {problem}</text>}</For>
            </box>
          </Show>
        );
      },
    });

    // "global": reachable while the prompt has focus, like OpenCode's own slash commands
    // (a default "base" layer is not, which hid /aria-plan in OpenCode 2.3.0).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "aria.plan.toggle",
          title: "ARIA: show plan",
          description: "Open or close the ARIA plan panel",
          group: "ARIA",
          palette: true,
          slash: { name: "aria-plan" },
          run: () => {
            if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close();
            else {
              refresh();
              context.ui.panel.open(PANEL);
            }
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
