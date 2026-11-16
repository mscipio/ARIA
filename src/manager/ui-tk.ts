import termkit, { type ScreenBuffer } from "terminal-kit";
import { ROLE_IDS } from "../roles.ts";
import { configFile, staticLayers } from "./config.ts";
import { dependency } from "./manifest.ts";
import { allDeps, disableDep, enableDep, ensureIntegration, manageDep, probeDep, readiness, removeDep, setupTargets, updateAll, type DepStatus } from "./deps.ts";
import { doctor, type DoctorReport } from "./doctor.ts";
import { ariaHome, globalConfigDir, packageRoot, releasesDir } from "./env.ts";
import { checkUpdate, registrations, repair, rollback, setup, update } from "./install.ts";
import { modelView, restoreModel, setModel, type ModelView } from "./models.ts";
import { listAgents, listModels } from "./opencode.ts";
import { readState } from "./state.ts";
import type { Check, OperationResult, Progress } from "./types.ts";

/**
 * ARIA Manager (Terminal-kit presentation): a keyboard-only terminal UI over the same backend as the
 * CLI. Rendering is one terminal-sized ScreenBuffer on the alternate screen: every frame is composed
 * from scratch, clipped to the physical size, and drawn as a delta; a resize rebuilds the buffer from
 * the current size, clears the screen and repaints everything. ASCII markers sit next to every colour,
 * and nothing mutates without first showing the backend's own preview (a dry run) and asking for "y".
 */

const TABS = ["Install", "Health", "Models", "Deps", "Updates", "Config"] as const;
type Tab = (typeof TABS)[number];

const MARK: Record<Check["status"], { text: string; color: string }> = {
  healthy: { text: "[ok]", color: "green" },
  disabled: { text: "[--]", color: "gray" },
  unverified: { text: "[??]", color: "yellow" },
  missing: { text: "[!!]", color: "red" },
  outdated: { text: "[up]", color: "yellow" },
  incompatible: { text: "[!!]", color: "red" },
  "config-error": { text: "[!!]", color: "red" },
  "runtime-error": { text: "[!!]", color: "red" },
};

/** One mutation flow: run the backend in dry-run mode, show it, then apply on "y". */
interface Pending {
  readonly title: string;
  readonly preview: OperationResult;
  readonly apply: (progress: Progress, signal: AbortSignal) => Promise<OperationResult>;
}

interface Prompt {
  readonly title: string;
  readonly hint: string;
  readonly value: string;
  readonly suggestions?: readonly string[];
  readonly submit: (value: string) => void;
}

interface Action {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
  readonly network?: boolean;
}

/** A styled line of text; `color` is one of the manager colour names. */
interface Styled {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
}
interface Row {
  readonly text: string;
  readonly color?: string;
  readonly sel: boolean;
}

const MIN_COLUMNS = 40;
const MIN_ROWS = 8;

function truncate(text: string, width: number): string {
  if (width <= 1) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}~` : text;
}

/** Hard-wrap lines to `width`; the result is exactly the rows that will be drawn. */
function wrapLines(lines: readonly string[], width: number): string[] {
  const w = Math.max(1, width);
  return lines.flatMap((l) => l.split("\n")).flatMap((l) => {
    if (l.length <= w) return [l];
    const out: string[] = [];
    for (let i = 0; i < l.length; i += w) out.push(l.slice(i, i + w));
    return out;
  });
}

const wrapStyled = (lines: readonly Styled[], width: number): Styled[] =>
  lines.flatMap((l) => wrapLines([l.text], width).map((text) => ({ ...l, text })));

function resultLines(r: OperationResult): Styled[] {
  return [
    ...(r.changes.length === 0 ? [{ text: "No changes.", color: "gray" }] : []),
    ...r.changes.map((c): Styled => ({ text: `${r.dryRun ? "will " : r.ok || r.outcome === "partial" ? "" : "planned, not done: "}[${c.kind}] ${c.summary}${c.network ? "  (network)" : ""}` })),
    ...(r.dryRun ? [] : (r.steps ?? []).map((st): Styled => ({ text: `${st.status === "failed" ? "FAILED" : st.status} ${st.name}${st.detail ? ` — ${st.detail}` : ""}`, color: st.status === "failed" ? "red" : st.status === "done" ? "green" : "gray" }))),
    ...r.messages.map((m): Styled => ({ text: m, color: "gray" })),
    ...(r.blocked ? [{ text: `BLOCKED: ${r.blocked}`, color: "yellow" }] : []),
    ...r.errors.map((e): Styled => ({ text: `error: ${e}`, color: "red" })),
  ];
}

const COLORS: Record<string, string> = { green: "green", red: "red", yellow: "yellow", gray: "brightBlack" };
const attrOf = (s: { color?: string | undefined; bold?: boolean | undefined; inverse?: boolean | undefined }): Record<string, unknown> => ({
  ...(s.color && COLORS[s.color] ? { color: COLORS[s.color] } : { defaultColor: true }),
  bgDefaultColor: true,
  ...(s.bold ? { bold: true } : {}),
  ...(s.inverse ? { inverse: true } : {}),
});

/**
 * Run the manager until the user quits. Resolves with the exit code. The terminal (alternate
 * screen, cursor, autowrap, input mode) is restored on quit, Ctrl-C, SIGTERM/SIGHUP/SIGINT and
 * any handled failure.
 */
export function runUi(project: string): Promise<number> {
  const term = termkit.terminal;
  const stdout = process.stdout;
  const props = { project };

  let columns = 0;
  let rows = 0;
  let sb: ScreenBuffer | undefined;
  let closed = false;
  let scheduled = false;

  let tab: Tab = "Health";
  let index = 0;
  let detail = false;
  let runtime = false;
  let report: DoctorReport | undefined;
  let models: ModelView | undefined;
  let deps: readonly DepStatus[] | undefined;
  let scope: "project" | "global" = "project";
  let loading: string | undefined;
  let pending: Pending | undefined;
  let busy: { title: string; lines: string[] } | undefined;
  let result: { title: string; result: OperationResult } | undefined;
  let prompt: Prompt | undefined;
  let help = false;
  let ovScroll = 0;
  let ovMax = 0;
  let abort: AbortController | undefined;

  // ---------------------------------------------------------------- state setters (each repaints)
  const invalidate = (): void => {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      guarded(() => draw(false));
    });
  };
  const setTab = (v: Tab) => { tab = v; invalidate(); };
  const setIndex = (v: number) => { index = v; invalidate(); };
  const setDetail = (v: boolean) => { detail = v; invalidate(); };
  const setRuntime = (v: boolean) => { runtime = v; invalidate(); };
  const setScope = (v: "project" | "global") => { scope = v; invalidate(); };
  const setLoading = (v: string | undefined) => { loading = v; invalidate(); };
  const setPending = (v: Pending | undefined) => { pending = v; ovScroll = 0; invalidate(); };
  const setBusy = (v: { title: string; lines: string[] } | undefined) => { busy = v; invalidate(); };
  const setResult = (v: { title: string; result: OperationResult } | undefined) => { result = v; ovScroll = 0; invalidate(); };
  const setPrompt = (v: Prompt | undefined) => { prompt = v; invalidate(); };
  const setHelp = (v: boolean) => { help = v; invalidate(); };

  const refresh = async (withRuntime = runtime): Promise<void> => {
    setLoading(withRuntime ? "querying OpenCode (runtime probes)…" : "reading local state…");
    const [r, d] = await Promise.all([doctor({ project: props.project, runtime: withRuntime }), allDeps(props.project)]);
    let view: ModelView;
    if (withRuntime) {
      const [a, m] = await Promise.all([listAgents(props.project), listModels(props.project)]);
      view = modelView(props.project, { ...(a.ok && a.value ? { agents: a.value } : {}), ...(m.ok && m.value ? { models: m.value } : {}), ...(!m.ok ? { error: m.error ?? "unavailable" } : {}) });
    } else view = modelView(props.project);
    if (closed) return;
    report = r;
    deps = d;
    models = view;
    setLoading(undefined);
  };

  /** Preview through the backend (dry run), then hold it for confirmation. */
  const propose = async (title: string, op: (dryRun: boolean, progress: Progress, signal?: AbortSignal) => Promise<OperationResult>): Promise<void> => {
    setLoading(`preparing preview: ${title}`);
    const preview = await op(true, () => undefined);
    setLoading(undefined);
    if (!preview.ok || preview.blocked || preview.changes.length === 0) {
      setResult({ title: `${title} (preview)`, result: preview });
      return;
    }
    setPending({ title, preview, apply: (progress: Progress, signal: AbortSignal) => op(false, progress, signal) });
  };

  const runPending = async (p: Pending): Promise<void> => {
    setPending(undefined);
    const controller = new AbortController();
    abort = controller;
    setBusy({ title: p.title, lines: [] });
    const r = await p.apply((line) => { if (!closed) setBusy(busy ? { ...busy, lines: [...busy.lines, line].slice(-8) } : busy); }, controller.signal).catch((error: Error) => ({ ok: false, dryRun: false, changes: [], messages: [], errors: [error.message] }) as OperationResult);
    abort = undefined;
    if (closed) return;
    setBusy(undefined);
    setResult({ title: p.title, result: r });
    void refresh();
  };

  // ---------------------------------------------------------------- per-tab rows and actions
  const compute = () => {
    const project = props.project;
    const regs = registrations(project);
    const state = readState().state;

    const installRows: { label: string; detail: string[]; actions: Action[] }[] = [
      {
        label: `Registration: ${regs.entries.length === 0 ? "not registered" : regs.entries.length === 1 ? `${regs.entries[0]?.version} (${regs.entries[0]?.owned ? "ARIA-owned" : "user entry"})` : `${regs.entries.length} entries (duplicate)`}`,
        detail: [...regs.entries.map((e) => `${e.file}\n  -> ${e.target}`), ...regs.discovered.map((d) => `auto-loaded: ${d}`), ...regs.other],
        actions: [],
      },
      {
        label: `Development install (${scope} scope) from ${truncate(packageRoot, 40)}`,
        detail: [`Registers this checkout in ${configFile(scope, project)}.`, "Nothing is copied; edits to the checkout take effect in new sessions.", "Press s to switch scope."],
        actions: [{ key: "enter", label: "preview & apply", run: () => void propose(`Development setup (${scope})`, (dryRun, progress) => setup({ scope, project, mode: "dev", dryRun, progress })) }],
      },
      {
        label: `Release install of this package (${scope} scope)`,
        detail: ["Copies the package into ARIA_HOME/releases/<version>, installs its CLI packages (network), verifies it, then registers it.", `ARIA_HOME: ${ariaHome()}`],
        actions: [{ key: "enter", label: "preview & apply", network: true, run: () => void propose(`Release setup (${scope})`, (dryRun: boolean, progress: Progress, signal?: AbortSignal) => setup({ scope, project, mode: "release", dryRun, progress, ...(signal ? { signal } : {}) })) }],
      },
      {
        label: "Repair interrupted or inconsistent installation",
        detail: ["Removes ARIA staging directories, clears interrupted-operation markers and re-records the active release. Never removes config entries or unknown directories."],
        actions: [{ key: "enter", label: "preview & apply", run: () => void propose("Repair", (dryRun) => repair({ project, dryRun })) }],
      },
    ];

    const checks = report?.checks ?? [];
    const modelRows = models ? [{ role: "default", configured: models.defaultModel.value, source: models.defaultModel.source, resolved: undefined, status: models.defaultModel.value ? "ok" : "inherits", note: "OpenCode's top-level default model" }, ...models.rows] : [];
    const depRows = deps ?? [];
    const updateRows: { label: string; detail: string[]; actions: Action[] }[] = [
      {
        label: `Current: ${state.active ? `release ${state.active}` : "development checkout or not installed"}`,
        detail: [`Releases: ${state.releases.map((r) => `${r.version}${r.version === state.active ? " (active)" : r.version === state.previous ? " (previous)" : ""}`).join(", ") || "none"}`, `Directory: ${releasesDir()}`, "Channel: none configured (ARIA is not published). Updates come from a local directory or .tgz."],
        actions: [],
      },
      {
        label: "Preview / apply update from a path…",
        detail: ["Stages, verifies and activates a release from a directory or .tgz (a .tgz.sha256 sidecar is checked if present). The previous release is kept."],
        actions: [{ key: "enter", label: "choose source", network: true, run: () => setPrompt({ title: "Update from (directory or .tgz)", hint: "path, then Enter", value: "", submit: (from) => void (async () => {
          const c = await checkUpdate({ from });
          if (c.error || !c.candidate) return setResult({ title: "Check update", result: { ok: false, dryRun: true, changes: [], messages: [`current: ${c.current ?? "unknown"}`], errors: [c.error ?? "nothing found"] } });
          await propose(`Update to ${c.candidate.version}`, (dryRun, progress, signal) => update({ from, project, dryRun, progress, ...(signal ? { signal } : {}) }));
        })() }) }],
      },
      {
        label: `Roll back${state.previous ? ` to ${state.previous}` : " (no previous release)"}`,
        detail: ["Repoints ARIA's plugin entry at the previous release. Model assignments and MCP entries are not changed."],
        actions: state.previous ? [{ key: "enter", label: "preview & apply", run: () => void propose(`Roll back to ${state.previous}`, (dryRun) => rollback({ project, dryRun })) }] : [],
      },
    ];
    const layers = staticLayers(project);
    const configRows: { label: string; detail: string[] }[] = [
      { label: "Config files (static discovery, lowest to highest)", detail: layers.length ? layers.map((l) => `${l.kind}: ${l.path}`) : ["none found"] },
      { label: "ARIA-owned entries", detail: state.owned.length ? state.owned.map((o) => `${o.kind} in ${o.file}`) : ["none"] },
      { label: "Paths", detail: [`ARIA_HOME: ${ariaHome()}`, `releases: ${releasesDir()}`, `global config: ${globalConfigDir()}`, `plans: ${project}/.aria/plans/*.md`, `scratch: ${project}/.aria/scratch/<root>/<session>/`] },
      { label: "Roles and permissions", detail: [`roles: ${ROLE_IDS.join(", ")}`, "aria/scientist: edit in project, shell (policy only), unknown tools ask", "visualizer: project edits and shell like aria, but no Code Mode, no subagents, browser tools ask", "planner: plan files only · writer: prose files only · scout/reviewer/researcher: read-only, no shell", "WARNING: shell rules are command-text policy, not a sandbox. A broad allow rule in your own `permissions` overrides every ARIA restriction."] },
    ];

    const count = tab === "Install" ? installRows.length : tab === "Health" ? checks.length : tab === "Models" ? modelRows.length : tab === "Deps" ? depRows.length : tab === "Updates" ? updateRows.length : configRows.length;
    const sel = Math.min(index, Math.max(0, count - 1));

    const tabActions = (): Action[] => {
      const common: Action[] = [{ key: "r", label: runtime ? "static only" : "query OpenCode", run: () => { const next = !runtime; setRuntime(next); void refresh(next); } }];
      if (tab === "Install") return [...(installRows[sel]?.actions ?? []), { key: "s", label: `scope: ${scope}`, run: () => setScope(scope === "project" ? "global" : "project") }];
      if (tab === "Updates") return updateRows[sel]?.actions ?? [];
      if (tab === "Health") {
        const c = checks[sel];
        const fix: Action[] = c?.repair?.automatic && c.repair.id === "repair" ? [{ key: "f", label: "repair", run: () => void propose("Repair", (dryRun) => repair({ project, dryRun })) }] : c?.repair?.automatic && c.repair.id === "install" && c.id.startsWith("dep.") ? [{ key: "f", label: c.repair.command?.split(" ")[2] ?? "install", network: true, run: () => void propose(`${c.repair?.command?.split(" ")[2] ?? "install"} ${c.component}`, (dryRun, progress, signal) => manageDep((c.repair?.command?.split(" ")[2] ?? "install") as "install" | "update" | "repair", c.id.replace(/^dep\./, ""), { project, scope: undefined, dryRun, progress, signal })) }] : [];
        return [{ key: "enter", label: "details", run: () => setDetail(!detail) }, ...fix, ...common];
      }
      if (tab === "Models") {
        const row = modelRows[sel];
        if (!row) return common;
        const role = row.role;
        return [
          { key: "enter", label: "change model", run: () => setPrompt({ title: `Model for ${role} (${scope} scope)`, hint: "provider/model[#variant]; Tab cycles listed models", value: row.configured ?? "", ...(models?.available ? { suggestions: models.available } : {}), submit: (spec) => void propose(`Set ${role} = ${spec} (${scope})`, (dryRun) => setModel({ role, spec: spec.trim() || undefined, scope, project, dryRun, ...(models?.available ? { available: models.available } : {}) })) }) },
          { key: "v", label: "change variant", run: () => {
            const base = (row.configured ?? "").split("#")[0] ?? "";
            if (!base) return setResult({ title: "Variant", result: { ok: false, dryRun: true, changes: [], messages: [], errors: ["set a model first; a variant belongs to a model"] } });
            setPrompt({ title: `Variant for ${role} (${base})`, hint: "e.g. high, medium, low; empty removes it", value: (row.configured ?? "").split("#")[1] ?? "", submit: (v) => void propose(`Set ${role} variant`, (dryRun) => setModel({ role, spec: v.trim() ? `${base}#${v.trim()}` : base, scope, project, dryRun, ...(models?.available ? { available: models.available } : {}) })) });
          } },
          { key: "x", label: "remove pin", run: () => void propose(`Remove ${role} pin (${scope})`, (dryRun) => setModel({ role, spec: undefined, scope, project, dryRun })) },
          { key: "u", label: "undo last change", run: () => void propose(`Restore ${role}`, (dryRun) => restoreModel(role, project, dryRun)) },
          { key: "s", label: `scope: ${scope}`, run: () => setScope(scope === "project" ? "global" : "project") },
          ...common,
        ];
      }
      if (tab === "Deps") {
        const d = depRows[sel];
        const updateEverything: Action = { key: "U", label: "update all", network: true, run: () => void propose("Update all managed dependencies", (dryRun, progress, signal) => updateAll({ project, dryRun, progress, signal })) };
        if (!d) return [updateEverything, ...common];
        const acts: Action[] = [{ key: "enter", label: "details", run: () => setDetail(!detail) }, updateEverything];
        for (const [key, intent] of [["i", "install"], ["u", "update"], ["f", "repair"]] as const) {
          if (d.actions.includes(intent)) acts.push({ key, label: intent, network: true, run: () => void propose(`${intent[0]?.toUpperCase()}${intent.slice(1)} ${d.name}`, (dryRun, progress, signal) => manageDep(intent, d.id, { project, scope: undefined, dryRun, progress, signal })) });
        }
        if (d.actions.includes("remove")) acts.push({ key: "d", label: "remove", run: () => void propose(`Remove ${d.name}`, (dryRun) => removeDep(d.id, { project, scope: undefined, dryRun })) });
        if (d.actions.includes("enable")) acts.push({ key: "e", label: `enable (${scope})`, run: () => void propose(`Enable ${d.name} (${scope})`, (dryRun) => enableDep(d.id, { scope, project, dryRun })) });
        if (setupTargets().some((t) => t.id === d.id)) acts.push({ key: "a", label: "set up fully + check", network: true, run: () => void propose(`Set up ${d.name} (${scope})`, (dryRun, progress, signal) => ensureIntegration(d.id, { scope, project, dryRun, progress, ...(signal ? { signal } : {}) })) });
        if (d.actions.includes("disable")) acts.push({ key: "x", label: "disable", run: () => void propose(`Disable ${d.name}`, (dryRun) => disableDep(d.id, { project, dryRun })) });
        if (d.kind === "mcp" && d.enabled) acts.push({ key: "c", label: "check readiness", network: Boolean(dependency(d.id)?.mcp?.remoteUrl), run: () => void (async () => {
          setLoading(`checking ${d.name}…`);
          const r = await readiness(d.id, project);
          setLoading(undefined);
          setResult({ title: `${d.name}: ${r.state}`, result: { ok: r.ok, dryRun: true, changes: [], errors: r.ok ? [] : [r.detail], messages: [`${r.ownership}; ${r.detail}`, ...r.steps.map((st) => `${st.status === "done" ? "ok    " : st.status === "failed" ? "FAILED" : "skip  "} ${st.name}${st.detail ? ` — ${st.detail}` : ""}`)] } });
        })() });
        if (d.actions.includes("probe")) acts.push({ key: "p", label: "probe tools", run: () => void (async () => {
          setLoading(`starting ${d.name} to list its tools…`);
          const r = await probeDep(d.id, false, project);
          setLoading(undefined);
          setResult({ title: `${d.name} tool inventory`, result: { ok: r.ok, dryRun: true, changes: [], errors: r.error ? [r.error] : [], messages: r.ok ? [`server ${r.server?.name ?? "?"} ${r.server?.version ?? ""}: ${r.tools.length} tools`, `read (allowed): ${r.classifiedRead.length}; mutating (ask): ${r.classifiedMutating.length}`, `unclassified (hidden): ${r.unclassified.join(", ") || "none"}`, `in rules but not exposed: ${r.absent.join(", ") || "none"}`] : [] } });
        })() });
        acts.push({ key: "s", label: `scope: ${scope}`, run: () => setScope(scope === "project" ? "global" : "project") });
        return [...acts, ...common];
      }
      return [{ key: "enter", label: "details", run: () => setDetail(!detail) }];
    };
    const actions = tabActions();
    return { installRows, checks, modelRows, depRows, updateRows, configRows, count, sel, actions };
  };

  // ---------------------------------------------------------------- input
  const quit = (code: number): void => {
    cleanup();
    resolveDone(code);
  };

  const onKey = (name: string, _matches: string[], data: { isCharacter?: boolean }): void => {
    const input = data?.isCharacter ? name : "";
    const isEnter = name === "ENTER" || name === "KP_ENTER";
    const isEscape = name === "ESCAPE";
    const isCtrlC = name === "CTRL_C";
    if (name === "CTRL_L") return void guarded(() => rebuild());
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      // Nothing useful is visible, so nothing may be triggered blindly; only quitting is allowed.
      if (input === "q" || isCtrlC) quit(0);
      return;
    }
    if (prompt) {
      if (isEscape) return setPrompt(undefined);
      if (isEnter) {
        const p = prompt;
        setPrompt(undefined);
        return p.submit(p.value);
      }
      if (name === "TAB" && prompt.suggestions?.length) {
        const matches = prompt.suggestions.filter((s) => s.startsWith(prompt!.value.split("#")[0] ?? ""));
        const list = matches.length ? matches : prompt.suggestions;
        const at = list.indexOf(prompt.value);
        return setPrompt({ ...prompt, value: list[(at + 1) % list.length] ?? prompt.value });
      }
      if (name === "BACKSPACE" || name === "DELETE") return setPrompt({ ...prompt, value: prompt.value.slice(0, -1) });
      if (isCtrlC) return quit(0);
      if (input) return setPrompt({ ...prompt, value: prompt.value + input });
      return;
    }
    if (busy) {
      if (isEscape) abort?.abort();
      else if (isCtrlC) { abort?.abort(); quit(0); }
      return;
    }
    const scroll = (): boolean => {
      if (name === "UP") ovScroll = Math.max(0, ovScroll - 1);
      else if (name === "DOWN") ovScroll = Math.min(ovMax, ovScroll + 1);
      else if (name === "PAGE_UP") ovScroll = Math.max(0, ovScroll - 5);
      else if (name === "PAGE_DOWN") ovScroll = Math.min(ovMax, ovScroll + 5);
      else return false;
      invalidate();
      return true;
    };
    if (pending) {
      if (isCtrlC) return quit(0);
      if (input === "y") return void runPending(pending);
      if (input === "n" || isEscape) return setPending(undefined);
      scroll();
      return;
    }
    if (result) {
      if (isCtrlC) return quit(0);
      if (isEnter || isEscape || input === " ") return setResult(undefined);
      scroll();
      return;
    }
    if (isCtrlC) return quit(0);
    if (help) return setHelp(false);
    if (input === "q" || isCtrlC) return quit(0);
    if (input === "?") return setHelp(true);
    const { count, sel, actions } = compute();
    const number = Number(input);
    if (input && number >= 1 && number <= TABS.length) {
      setTab(TABS[number - 1] as Tab);
      setIndex(0);
      setDetail(false);
      return;
    }
    if (name === "RIGHT" || name === "LEFT") {
      const i = TABS.indexOf(tab) + (name === "RIGHT" ? 1 : -1 + TABS.length);
      setTab(TABS[i % TABS.length] as Tab);
      setIndex(0);
      setDetail(false);
      return;
    }
    if (name === "UP" || input === "k") return setIndex(Math.max(0, sel - 1));
    if (name === "DOWN" || input === "j") return setIndex(Math.min(count - 1, sel + 1));
    if (isEscape) return setDetail(false);
    const action = actions.find((a) => (a.key === "enter" ? isEnter : a.key === input));
    if (action && !loading) action.run();
  };

  // ---------------------------------------------------------------- rendering
  /** Write text at (x, y), clipped to the physical screen; never wraps, never goes outside. */
  const put = (x: number, y: number, text: string, attr: Record<string, unknown>): void => {
    if (!sb || y < 0 || y >= rows || x >= columns) return;
    const clean = [...text].map((ch) => { const c = ch.codePointAt(0) ?? 32; return c < 32 || (c >= 127 && c < 160) ? " " : ch; });
    const from = Math.max(0, -x);
    const shown = clean.slice(from, from + (columns - Math.max(0, x))).join("");
    if (shown) sb.put({ x: Math.max(0, x), y, wrap: false, attr }, shown);
  };

  /** A bordered box; `top` and `bottom` lines are pinned, `middle` scrolls. Returns the max scroll. */
  const box = (x: number, y: number, w: number, maxH: number, top: Styled[], middle: Styled[], bottom: Styled[], scrollAt: number): number => {
    if (w < 6 || maxH < 3) return 0;
    const inner = w - 4;
    const t = wrapStyled(top, inner), m = wrapStyled(middle, inner), b = wrapStyled(bottom, inner);
    const innerRows = Math.min(t.length + m.length + b.length, maxH - 2);
    const cap = innerRows - t.length - b.length;
    const fits = t.length + b.length <= maxH - 2 && (cap >= 1 || m.length === 0);
    const maxScroll = fits ? Math.max(0, m.length - cap) : 0;
    const at = Math.min(scrollAt, maxScroll);
    const lines = fits ? [...t, ...m.slice(at, at + Math.max(0, cap)), ...b] : [...(m.length === 0 ? t.slice(-1) : t.slice(0, 1)), ...b].slice(0, innerRows);
    const bar = "─".repeat(w - 2);
    const plain = attrOf({});
    put(x, y, `┌${bar}┐`, plain);
    lines.forEach((l, i) => {
      put(x, y + 1 + i, `│${" ".repeat(w - 2)}│`, plain);
      put(x + 2, y + 1 + i, l.text, attrOf(l));
    });
    put(x, y + 1 + lines.length, `└${bar}┘`, plain);
    return maxScroll;
  };

  const draw = (full: boolean): void => {
    if (closed || !sb) return;
    sb.fill({ char: " ", attr: { defaultColor: true, bgDefaultColor: true } });
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      put(0, 0, `Terminal too small (${columns}x${rows}).`, attrOf({}));
      put(0, 1, `Need ${MIN_COLUMNS}x${MIN_ROWS}; q quits.`, attrOf({}));
      return sb.draw({ delta: !full });
    }
    const narrow = columns < 90;
    const project = props.project;
    const { installRows, checks, modelRows, depRows, updateRows, configRows, count, sel, actions } = compute();
    const width = columns - 1;
    const bodyH = rows - 2; // header + footer
    const showDetail = detail || (!narrow && tab !== "Health" && tab !== "Deps");
    const listWidth = narrow || !showDetail ? width : Math.floor(width * 0.55);
    const line = (i: number, text: string, color?: string): Row => ({ text: truncate(`${i === sel ? ">" : " "} ${text}`, listWidth), ...(color ? { color } : {}), sel: i === sel });

    let list: Row[] = [];
    let detailLines: string[] = [];
    if (tab === "Install") {
      list = installRows.map((r, i) => line(i, r.label));
      detailLines = installRows[sel]?.detail ?? [];
    } else if (tab === "Health") {
      list = checks.map((c, i) => line(i, `${MARK[c.status].text} ${c.component}: ${c.summary}`, MARK[c.status].color));
      const c = checks[sel];
      detailLines = c ? [`${c.component}: ${c.status} (${c.basis === "runtime" ? "observed" : c.basis === "static" ? "static check only" : "not checked"})`, c.summary, ...c.evidence.map((e) => `- ${e}`), ...(c.repair ? [`repair: ${c.repair.automatic ? "automatic" : "manual"}${c.repair.network ? " (network)" : ""}`, ...c.repair.changes.map((x) => `  will: ${x}`)] : ["no repair needed or available"])] : [];
    } else if (tab === "Models") {
      const w = narrow ? [10, Math.max(12, listWidth - 24)] : [11, 34, 9, 30];
      list = modelRows.map((r, i) => {
        const src = r.configured ? (r.source.startsWith("project") ? "project" : r.source.startsWith("global") ? "global" : r.source.split(":")[0] ?? "-") : "-";
        const cells = narrow ? [r.role.padEnd(w[0] as number), truncate(r.configured ?? "(session model)", w[1] as number), r.status] : [r.role.padEnd(w[0] as number), truncate(r.configured ?? "(session model)", (w[1] as number) - 1).padEnd(w[1] as number), src.padEnd(w[2] as number), truncate(r.resolved ?? (models?.runtime.agents ? "(none)" : "-"), (w[3] as number) - 1).padEnd(w[3] as number), r.status];
        return line(i, cells.join(" "), r.status === "invalid" || r.status === "unavailable" ? "red" : undefined);
      });
      const r = modelRows[sel];
      detailLines = r ? [`${r.role}`, `configured: ${r.configured ?? "none (no pin)"}`, `source: ${r.source}`, `resolved by OpenCode: ${r.resolved ?? (models?.runtime.agents ? "(not reported)" : "not probed — press r")}`, `status: ${r.status}${r.note ? ` — ${r.note}` : ""}`, `edits go to: ${configFile(scope, project)}`, "Changes apply to sessions started afterwards, not to running ones.", ...(models?.runtime.error ? [`model list: ${models.runtime.error}`] : [])] : [];
    } else if (tab === "Deps") {
      list = depRows.map((d, i) => line(i, `${MARK[d.health].text} ${d.id.padEnd(15)} ${d.requirement.padEnd(9)} ${(d.kind === "mcp" ? (d.enabled ? "on" : "off") : "").padEnd(4)} ${(d.version ?? "-").padEnd(9)} ${d.ownership}`, MARK[d.health].color));
      const d = depRows[sel];
      detailLines = d ? [d.name, d.purpose, `${d.requirement}${d.roles.length ? `; used by: ${d.roles.join(", ")}` : ""}${d.pinned ? `; pinned ${d.pinned}` : ""}`, `health: ${d.health} (${d.basis})`, ...d.evidence.map((e) => `- ${e}`), `ownership: ${d.ownership}${d.installed === false ? " (not installed yet)" : ""}`, `actions: ${d.actions.join(", ") || (d.ownership === "aria-managed" ? "none needed" : `none: ${d.ownership === "hosted" ? "hosted service" : "you manage it"}`)}`] : [];
    } else if (tab === "Updates") {
      list = updateRows.map((r, i) => line(i, r.label));
      detailLines = updateRows[sel]?.detail ?? [];
    } else {
      list = configRows.map((r, i) => line(i, r.label));
      detailLines = configRows[sel]?.detail ?? [];
    }

    // Header: one row. Full labels, else 4-letter labels, else only the active tab named.
    const status = `${runtime ? "runtime" : "static"}${loading ? ` · ${loading}` : ""}`;
    const labels = (mode: "full" | "short" | "compact") => TABS.map((t, i) => (mode === "compact" && t !== tab ? ` ${i + 1} ` : ` ${i + 1} ${mode === "short" ? t.slice(0, 4) : t} `));
    const mode = (["full", "short", "compact"] as const).find((m) => labels(m).join("").length <= width) ?? "compact";
    let hx = 0;
    labels(mode).forEach((s, i) => {
      put(hx, 0, s, attrOf(TABS[i] === tab ? { inverse: true, bold: true } : {}));
      hx += s.length;
    });
    put(hx, 0, `  ${status}`, attrOf({ color: "gray" }));

    // Footer: one row, clipped.
    put(0, rows - 1, truncate(`${actions.map((a) => `${a.key === "enter" ? "Enter" : a.key}:${a.label}${a.network ? "*" : ""}`).join("  ")}  ↑↓ select  1-6 tabs  ?:help  q:quit${actions.some((a) => a.network) ? "  (*network)" : ""}`, width), attrOf({ color: "gray" }));

    // Overlay or body
    ovMax = 0;
    const overlayBox = (top: Styled[], middle: Styled[], bottom: Styled[], scrollable: boolean) => {
      ovMax = box(0, 1, width, bodyH, top, middle, bottom, scrollable ? ovScroll : 0);
      if (scrollable) ovScroll = Math.min(ovScroll, ovMax);
    };
    if (help) {
      overlayBox([{ text: "ARIA Manager — keys", bold: true }], [
        "1-6 or ←/→  switch section", "↑/↓ or j/k  select a row", "Enter       open details or the row's main action",
        "r           query OpenCode for runtime facts (may start its server)", "s           switch the scope edits go to (project/global)",
        "Every change is previewed first; y applies, n cancels. Esc cancels a running operation where safe.", "q           quit", "Ctrl-L      redraw the screen",
      ].map((text) => ({ text })), [{ text: "Any key closes this help.", color: "gray" }], false);
    } else if (prompt) {
      overlayBox([{ text: prompt.title, bold: true }, { text: prompt.hint, color: "gray" }, { text: `> ${prompt.value}_` }], [], [{ text: "Enter: preview  Esc: cancel", color: "gray" }], false);
    } else if (pending) {
      overlayBox([{ text: `${pending.title} — preview`, bold: true }], resultLines(pending.preview), [{ text: "Apply these changes? y / n  (↑↓ scroll)", bold: true }], true);
    } else if (busy) {
      overlayBox([{ text: `${busy.title} — working…`, bold: true }], busy.lines.map((text) => ({ text, color: "gray" })), [{ text: "Esc: cancel (only where safe)", color: "gray" }], false);
    } else if (result) {
      const r = result.result;
      overlayBox([{ text: `${result.title}: ${r.outcome === "partial" ? "partly done" : r.blocked ? "blocked" : r.ok ? "done" : "failed"}`, bold: true, color: r.outcome === "partial" ? "yellow" : r.ok && !r.blocked ? "green" : "red" }], resultLines(r), [{ text: "Enter: close  (↑↓ scroll)", color: "gray" }], true);
    } else {
      const detailInner = narrow ? width - 4 : width - listWidth - 2 - 4;
      const wrapped = wrapLines(detailLines, detailInner);
      const detailBoxH = narrow ? Math.max(3, Math.min(wrapped.length + 2, Math.floor(bodyH / 2))) : bodyH;
      const detailCap = detailBoxH - 2;
      const shownDetail = showDetail ? (wrapped.length > detailCap ? [...wrapped.slice(0, Math.max(0, detailCap - 1)), "…"] : wrapped) : [];
      const visible = Math.max(1, narrow && showDetail ? bodyH - detailBoxH : bodyH);
      const start = Math.max(0, Math.min(sel - Math.floor(visible / 2), count - visible));
      if (count === 0) put(0, 1, loading ? "loading…" : "nothing to show", attrOf({ color: "gray" }));
      list.slice(start, start + visible).forEach((r, i) => put(0, 1 + i, r.text, attrOf({ ...(r.color ? { color: r.color } : {}), ...(r.sel ? { inverse: true } : {}) })));
      if (showDetail) {
        const lines = shownDetail.map((text): Styled => ({ text }));
        if (narrow) box(0, 1 + visible, width, detailBoxH, [], lines, [], 0);
        else box(listWidth + 2, 1, width - listWidth - 2, bodyH, [], lines, [], 0);
      }
    }
    sb.draw({ delta: !full });
  };

  // ---------------------------------------------------------------- lifecycle
  let cleaned = false;
  let resolveDone: (code: number) => void = () => undefined;
  const onResize = (): void => guarded(() => {
    const w = stdout.columns || term.width || 80, h = stdout.rows || term.height || 24;
    if (w !== columns || h !== rows) rebuild();
  });
  const keyListener = (name: string, matches: string[], data: { isCharacter?: boolean }): void => guarded(() => onKey(name, matches, data));
  const onSignal = (): void => quit(0);
  const onFatal = (error: unknown): void => {
    cleanup();
    console.error(`ARIA Manager failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    resolveDone(1);
  };
  const onExit = (): void => cleanup();

  /** Run a presentation step; a failure restores the terminal and ends the session with code 1. */
  function guarded(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      onFatal(error);
    }
  }

  /** Rebuild the buffer from the CURRENT terminal size, erase the screen and repaint everything. */
  function rebuild(): void {
    if (closed) return;
    columns = stdout.columns || term.width || 80;
    rows = stdout.rows || term.height || 24;
    sb = termkit.ScreenBuffer.create({ dst: term, width: columns, height: rows, noFill: true });
    term.clear();
    draw(true);
  }

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    abort?.abort();
    for (const fn of [
      () => term.removeListener("key", keyListener),
      () => term.removeListener("resize", onResize),
      () => stdout.off("resize", onResize),
      () => process.off("SIGTERM", onSignal),
      () => process.off("SIGHUP", onSignal),
      () => process.off("SIGINT", onSignal),
      () => process.off("uncaughtException", onFatal),
      () => process.off("unhandledRejection", onFatal),
      () => process.off("exit", onExit),
      () => term.grabInput(false),
      () => stdout.write("\u001b[?7h"), // autowrap back on
      () => term.hideCursor(false),
      () => term.fullscreen(false), // leave the alternate screen
      () => term.styleReset(),
    ]) {
      try {
        fn();
      } catch {
        // keep restoring the rest
      }
    }
  }

  return new Promise<number>((resolve) => {
    resolveDone = resolve;
    term.fullscreen(true); // alternate screen
    stdout.write("\u001b[?7l"); // no automatic wrapping
    term.hideCursor();
    term.grabInput({ mouse: false });
    term.on("key", keyListener);
    term.on("resize", onResize);
    stdout.on("resize", onResize);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.on("SIGINT", onSignal);
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    process.on("exit", onExit);
    guarded(() => rebuild());
    void refresh(false).catch(onFatal);
  });
}
