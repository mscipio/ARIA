import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_IDS } from "../roles.ts";
import { configFile, staticLayers } from "./config.ts";
import { dependency } from "./manifest.ts";
import { allDeps, disableDep, enableDep, ensureIntegration, installDep, probeDep, readiness, type DepStatus } from "./deps.ts";
import { doctor, type DoctorReport } from "./doctor.ts";
import { ariaHome, globalConfigDir, packageRoot, releasesDir } from "./env.ts";
import { checkUpdate, registrations, repair, rollback, setup, update } from "./install.ts";
import { modelView, restoreModel, setModel, type ModelView } from "./models.ts";
import { listAgents, listModels } from "./opencode.ts";
import { readState } from "./state.ts";
import type { Check, OperationResult, Progress } from "./types.ts";

/**
 * ARIA Manager: a keyboard-only terminal UI over the same backend as the CLI. It renders with Ink
 * (React for terminals), uses ASCII markers next to every colour, and never mutates anything
 * without first showing the backend's own preview (a dry run) and asking for "y".
 */

const h = React.createElement;
type Node = React.ReactNode;

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

function truncate(text: string, width: number): string {
  if (width <= 1) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}~` : text;
}

function useColumns(): { columns: number; rows: number } {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

function ResultView(props: { result: OperationResult; width: number }): Node {
  const r = props.result;
  return h(
    Box,
    { flexDirection: "column" },
    r.changes.length === 0 ? h(Text, { color: "gray" }, "No changes.") : null,
    ...r.changes.map((c, i) => h(Text, { key: `c${i}`, wrap: "truncate-end" }, `${r.dryRun ? "will " : r.ok || r.outcome === "partial" ? "" : "planned, not done: "}[${c.kind}] ${truncate(c.summary, props.width - 12)}${c.network ? "  (network)" : ""}`)),
    ...(r.dryRun ? [] : (r.steps ?? []).map((st, i) => h(Text, { key: `s${i}`, color: st.status === "failed" ? "red" : st.status === "done" ? "green" : "gray", wrap: "truncate-end" }, `${st.status === "failed" ? "FAILED" : st.status} ${truncate(`${st.name}${st.detail ? ` — ${st.detail}` : ""}`, props.width - 10)}`))),
    ...r.messages.map((m, i) => h(Text, { key: `m${i}`, color: "gray", wrap: "wrap" }, m)),
    r.blocked ? h(Text, { color: "yellow", wrap: "wrap" }, `BLOCKED: ${r.blocked}`) : null,
    ...r.errors.map((e, i) => h(Text, { key: `e${i}`, color: "red", wrap: "wrap" }, `error: ${e}`)),
  );
}

export function App(props: { project: string }): Node {
  const { exit } = useApp();
  const { columns, rows } = useColumns();
  const narrow = columns < 90;
  const [tab, setTab] = useState<Tab>("Health");
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(false);
  const [runtime, setRuntime] = useState(false);
  const [report, setReport] = useState<DoctorReport>();
  const [models, setModels] = useState<ModelView>();
  const [deps, setDeps] = useState<readonly DepStatus[]>();
  const [scope, setScope] = useState<"project" | "global">("project");
  const [loading, setLoading] = useState<string>();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState<{ title: string; lines: string[] }>();
  const [result, setResult] = useState<{ title: string; result: OperationResult }>();
  const [prompt, setPrompt] = useState<Prompt>();
  const [help, setHelp] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    abort.current?.abort();
  }, []);

  const refresh = useCallback(async (withRuntime = runtime) => {
    setLoading(withRuntime ? "querying OpenCode (runtime probes)…" : "reading local state…");
    const [r, d] = await Promise.all([doctor({ project: props.project, runtime: withRuntime }), allDeps(props.project)]);
    let view: ModelView;
    if (withRuntime) {
      const [a, m] = await Promise.all([listAgents(props.project), listModels(props.project)]);
      view = modelView(props.project, { ...(a.ok && a.value ? { agents: a.value } : {}), ...(m.ok && m.value ? { models: m.value } : {}), ...(!m.ok ? { error: m.error ?? "unavailable" } : {}) });
    } else view = modelView(props.project);
    if (!mounted.current) return;
    setReport(r);
    setDeps(d);
    setModels(view);
    setLoading(undefined);
  }, [props.project, runtime]);

  useEffect(() => {
    void refresh(false);
  }, []);

  /** Preview through the backend (dry run), then hold it for confirmation. */
  const propose = useCallback(async (title: string, op: (dryRun: boolean, progress: Progress, signal?: AbortSignal) => Promise<OperationResult>) => {
    setLoading(`preparing preview: ${title}`);
    const preview = await op(true, () => undefined);
    setLoading(undefined);
    if (!preview.ok || preview.blocked || preview.changes.length === 0) {
      setResult({ title: `${title} (preview)`, result: preview });
      return;
    }
    setPending({ title, preview, apply: (progress: Progress, signal: AbortSignal) => op(false, progress, signal) });
  }, []);

  const runPending = useCallback(async (p: Pending) => {
    setPending(undefined);
    const controller = new AbortController();
    abort.current = controller;
    setBusy({ title: p.title, lines: [] });
    const r = await p.apply((line) => mounted.current && setBusy((b) => (b ? { ...b, lines: [...b.lines, line].slice(-8) } : b)), controller.signal).catch((error: Error) => ({ ok: false, dryRun: false, changes: [], messages: [], errors: [error.message] }) as OperationResult);
    abort.current = undefined;
    if (!mounted.current) return;
    setBusy(undefined);
    setResult({ title: p.title, result: r });
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------- per-tab rows and actions
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
    { label: "Roles and permissions", detail: [`roles: ${ROLE_IDS.join(", ")}`, "aria/scientist: edit in project, shell (policy only), unknown tools ask", "planner: plan files only · writer: prose files only · scout/reviewer/researcher: read-only, no shell", "WARNING: shell rules are command-text policy, not a sandbox. A broad allow rule in your own `permissions` overrides every ARIA restriction."] },
  ];

  const count = tab === "Install" ? installRows.length : tab === "Health" ? checks.length : tab === "Models" ? modelRows.length : tab === "Deps" ? depRows.length : tab === "Updates" ? updateRows.length : configRows.length;
  const sel = Math.min(index, Math.max(0, count - 1));

  const tabActions = (): Action[] => {
    const common: Action[] = [{ key: "r", label: runtime ? "static only" : "query OpenCode", run: () => { const next = !runtime; setRuntime(next); void refresh(next); } }];
    if (tab === "Install") return [...(installRows[sel]?.actions ?? []), { key: "s", label: `scope: ${scope}`, run: () => setScope(scope === "project" ? "global" : "project") }];
    if (tab === "Updates") return updateRows[sel]?.actions ?? [];
    if (tab === "Health") {
      const c = checks[sel];
      const fix: Action[] = c?.repair?.automatic && c.repair.id === "repair" ? [{ key: "f", label: "repair", run: () => void propose("Repair", (dryRun) => repair({ project, dryRun })) }] : c?.repair?.automatic && c.repair.id === "install" ? [{ key: "f", label: "install", network: true, run: () => void propose(`Install ${c.component}`, (dryRun, progress, signal) => installDep(c.id.replace(/^dep\./, ""), { dryRun, progress, ...(signal ? { signal } : {}) })) }] : [];
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
      if (!d) return common;
      const acts: Action[] = [{ key: "enter", label: "details", run: () => setDetail(!detail) }];
      if (d.actions.includes("install") || d.actions.includes("update")) acts.push({ key: "i", label: d.actions.includes("update") ? "reinstall/update" : "install", network: true, run: () => void propose(`Install ${d.name}`, (dryRun, progress, signal) => installDep(d.id, { dryRun, progress, ...(signal ? { signal } : {}) })) });
      if (d.actions.includes("enable")) acts.push({ key: "e", label: `enable (${scope})`, run: () => void propose(`Enable ${d.name} (${scope})`, (dryRun) => enableDep(d.id, { scope, project, dryRun })) });
      if (dependency(d.id)?.mcp?.config) acts.push({ key: "a", label: "set up fully + check", network: true, run: () => void propose(`Set up ${d.name} (${scope})`, (dryRun, progress, signal) => ensureIntegration(d.id, { scope, project, dryRun, progress, ...(signal ? { signal } : {}) })) });
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

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) return setPrompt(undefined);
      if (key.return) {
        const p = prompt;
        setPrompt(undefined);
        return p.submit(p.value);
      }
      if (key.tab && prompt.suggestions?.length) {
        const matches = prompt.suggestions.filter((s) => s.startsWith(prompt.value.split("#")[0] ?? ""));
        const list = matches.length ? matches : prompt.suggestions;
        const at = list.indexOf(prompt.value);
        return setPrompt({ ...prompt, value: list[(at + 1) % list.length] ?? prompt.value });
      }
      if (key.backspace || key.delete) return setPrompt({ ...prompt, value: prompt.value.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) return setPrompt({ ...prompt, value: prompt.value + input });
      return;
    }
    if (busy) {
      if (key.escape) abort.current?.abort();
      return;
    }
    if (pending) {
      if (input === "y") return void runPending(pending);
      if (input === "n" || key.escape) return setPending(undefined);
      return;
    }
    if (result) {
      if (key.return || key.escape || input === " ") setResult(undefined);
      return;
    }
    if (help) return setHelp(false);
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (input === "?") return setHelp(true);
    const number = Number(input);
    if (number >= 1 && number <= TABS.length) {
      setTab(TABS[number - 1] as Tab);
      setIndex(0);
      setDetail(false);
      return;
    }
    if (key.rightArrow || key.leftArrow) {
      const i = TABS.indexOf(tab) + (key.rightArrow ? 1 : -1 + TABS.length);
      setTab(TABS[i % TABS.length] as Tab);
      setIndex(0);
      setDetail(false);
      return;
    }
    if (key.upArrow || input === "k") return setIndex(Math.max(0, sel - 1));
    if (key.downArrow || input === "j") return setIndex(Math.min(count - 1, sel + 1));
    if (key.escape) return setDetail(false);
    const action = actions.find((a) => (a.key === "enter" ? key.return : a.key === input));
    if (action && !loading) action.run();
  });

  // ---------------------------------------------------------------- rendering
  const width = columns - 2;
  const listWidth = narrow || !detail ? width : Math.floor(width * 0.55);
  const visible = Math.max(3, rows - 10);
  const start = Math.max(0, Math.min(sel - Math.floor(visible / 2), count - visible));
  const line = (i: number, text: string, color?: string): Node =>
    i < start || i >= start + visible ? null : h(Text, { key: `r${i}`, ...(i === sel ? { inverse: true } : {}), ...(color ? { color } : {}), wrap: "truncate-end" }, truncate(`${i === sel ? ">" : " "} ${text}`, listWidth));

  let list: Node[] = [];
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
    detailLines = d ? [d.name, d.purpose, `health: ${d.health} (${d.basis})`, ...d.evidence.map((e) => `- ${e}`), `ownership: ${d.ownership}${d.installed === false ? " (not installed yet)" : ""}`, `actions: ${d.actions.join(", ") || (d.ownership === "aria-managed" ? "none needed" : `none: ${d.ownership === "hosted" ? "hosted service" : "you manage it"}`)}`] : [];
  } else if (tab === "Updates") {
    list = updateRows.map((r, i) => line(i, r.label));
    detailLines = updateRows[sel]?.detail ?? [];
  } else {
    list = configRows.map((r, i) => line(i, r.label));
    detailLines = configRows[sel]?.detail ?? [];
  }
  const showDetail = detail || (!narrow && tab !== "Health" && tab !== "Deps");

  const header = h(
    Box,
    { key: "hdr" },
    ...TABS.map((t, i) => h(Text, { key: t, ...(t === tab ? { inverse: true, bold: true } : {}) }, ` ${i + 1} ${narrow ? t.slice(0, 4) : t} `)),
    h(Text, { color: "gray" }, `  ${runtime ? "runtime" : "static"}${loading ? ` · ${loading}` : ""}`),
  );
  const footer = h(Text, { key: "ftr", color: "gray", wrap: "truncate-end" }, truncate(`${actions.map((a) => `${a.key === "enter" ? "Enter" : a.key}:${a.label}${a.network ? "*" : ""}`).join("  ")}  ↑↓ select  1-6 tabs  ?:help  q:quit${actions.some((a) => a.network) ? "  (*network)" : ""}`, width));

  let overlay: Node = null;
  if (help) {
    overlay = h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, ...[
      "ARIA Manager — keys", "1-6 or ←/→  switch section", "↑/↓ or j/k  select a row", "Enter       open details or the row's main action",
      "r           query OpenCode for runtime facts (may start its server)", "s           switch the scope edits go to (project/global)",
      "Every change is previewed first; y applies, n cancels. Esc cancels a running operation where safe.", "q           quit", "", "Any key closes this help.",
    ].map((t, i) => h(Text, { key: i }, t)));
  } else if (prompt) {
    overlay = h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, h(Text, { bold: true }, prompt.title), h(Text, { color: "gray" }, prompt.hint), h(Text, null, `> ${prompt.value}_`), h(Text, { color: "gray" }, "Enter: preview  Esc: cancel"));
  } else if (pending) {
    overlay = h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, h(Text, { bold: true }, `${pending.title} — preview`), h(ResultView, { result: pending.preview, width }), h(Text, { bold: true }, "Apply these changes? y / n"));
  } else if (busy) {
    overlay = h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, h(Text, { bold: true }, `${busy.title} — working…`), ...busy.lines.map((l, i) => h(Text, { key: i, color: "gray", wrap: "truncate-end" }, truncate(l, width - 4))), h(Text, { color: "gray" }, "Esc: cancel (only where safe)"));
  } else if (result) {
    overlay = h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, h(Text, { bold: true, color: result.result.outcome === "partial" ? "yellow" : result.result.ok && !result.result.blocked ? "green" : "red" }, `${result.title}: ${result.result.outcome === "partial" ? "partly done" : result.result.blocked ? "blocked" : result.result.ok ? "done" : "failed"}`), h(ResultView, { result: result.result, width }), h(Text, { color: "gray" }, "Enter: close"));
  }

  const body = h(
    Box,
    { key: "body", flexDirection: narrow ? "column" : "row" },
    h(Box, { flexDirection: "column", width: showDetail && !narrow ? listWidth : width }, ...(count === 0 ? [h(Text, { key: "empty", color: "gray" }, loading ? "loading…" : "nothing to show")] : list)),
    showDetail ? h(Box, { flexDirection: "column", ...(narrow ? {} : { marginLeft: 2, width: width - listWidth - 2 }), borderStyle: narrow ? "single" : undefined }, ...detailLines.map((d, i) => h(Text, { key: i, wrap: "wrap" }, d))) : null,
  );
  return h(Box, { flexDirection: "column", width: columns }, header, overlay ?? body, footer);
}

export async function runUi(project: string): Promise<number> {
  const app = render(h(App, { project }), { exitOnCtrlC: true });
  await app.waitUntilExit();
  return 0;
}
