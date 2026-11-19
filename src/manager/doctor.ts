import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROLE_IDS } from "../roles.ts";
import { isAriaPackage, readConfig, samePath, staticLayers } from "./config.ts";
import { allDeps, readiness } from "./deps.ts";
import { packageRoot, releasesDir, satisfies, statePath } from "./env.ts";
import { journals, leftovers, registrations } from "./install.ts";
import { modelView } from "./models.ts";
import { configSources, listAgents, listModels, opencodeVersion } from "./opencode.ts";
import { readState } from "./state.ts";
import { MANIFEST } from "./manifest.ts";
import type { Check, Health } from "./types.ts";

/**
 * Health checks. Every check says how it was established: `static` (files on disk),
 * `runtime` (something was actually executed or queried), or `none`. A component that only
 * passed static checks is reported as `unverified`, never as healthy.
 */

export interface DoctorInput {
  readonly project: string;
  /** Query the OpenCode server (`debug agents`, `models`, `debug config`). Slower; may start a server. */
  readonly runtime: boolean;
}

export interface DoctorReport {
  readonly checks: readonly Check[];
  readonly runtimeProbed: boolean;
  readonly summary: Record<Health, number>;
}

const check = (c: Check) => c;

export async function doctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: Check[] = [];
  const { state, error: stateError } = readState();
  const pkg = isAriaPackage(packageRoot);
  const regs = registrations(input.project);

  // Installation and state
  const mode = state.active ? `release ${state.active}` : "development checkout";
  checks.push(check({
    id: "install.state", component: "ARIA installation", basis: "static",
    status: stateError ? "config-error" : state.pending ? "runtime-error" : "healthy",
    summary: stateError ? stateError : state.pending ? `interrupted ${state.pending.op} at step "${state.pending.step}"` : `${mode}; running from ${packageRoot} (${pkg?.version ?? "unknown"})`,
    evidence: [`state: ${existsSync(statePath()) ? statePath() : "none yet (nothing installed by ARIA)"}`, `releases: ${state.releases.map((r) => r.version).join(", ") || "none"}`, ...(state.pending ? [`started ${state.pending.startedAt}${state.pending.staging ? `, staging ${state.pending.staging}` : ""}`] : [])],
    ...(state.pending || stateError ? { repair: { id: "repair", automatic: true, changes: ["remove ARIA staging directories", "clear the interrupted-operation marker", "re-record the active release from config"], command: "aria repair" } } : {}),
  }));
  for (const j of journals()) {
    checks.push(check({
      id: `install.journal.${j.id}`, component: "Unfinished operation journal", basis: "static",
      status: j.status === "complete" ? "unverified" : "runtime-error",
      summary: j.status === "unreadable" ? `journal ${j.id} cannot be read` : j.status === "complete" ? `${j.op} to ${j.target} completed; only its journal is left` : `${j.op} ${j.from} -> ${j.target} was interrupted; other ARIA changes are refused until repaired`,
      evidence: [
        ...(j.error ? [j.error] : []),
        ...j.files.map((f) => `${f.role}: ${f.path} holds ${f.now === "after" ? "what ARIA wrote" : f.now === "before" ? "its original content" : f.now === "marker" ? "ARIA's interrupted-operation marker" : "content changed by someone else (repair will not overwrite it)"}`),
        ...(j.inflight ? [`in flight: ${j.inflight}`] : []),
      ],
      repair: { id: "repair", automatic: j.status !== "unreadable", changes: j.status === "complete" ? ["remove the journal"] : ["put back every file that still holds what ARIA wrote", "keep files changed by someone else (--keep-changed rebuilds state around them)"], command: "aria repair" },
    }));
  }
  const stale = leftovers();
  const ownedStale = stale.filter((l) => l.owned);
  const foreign = stale.filter((l) => !l.owned && existsSync(l.path));
  if (ownedStale.length) checks.push(check({ id: "install.leftovers", component: "Incomplete install artifacts", status: "runtime-error", basis: "static", summary: `${ownedStale.length} ARIA staging director${ownedStale.length === 1 ? "y" : "ies"} from an interrupted operation`, evidence: ownedStale.map((l) => `${l.path} (${l.reason})`), repair: { id: "repair", automatic: true, changes: ownedStale.map((l) => `remove ${l.path}`), command: "aria repair" } }));
  if (foreign.length) checks.push(check({ id: "install.foreign-staging", component: "Staging-like directories ARIA cannot prove it owns", status: "unverified", basis: "static", summary: "never removed automatically; inspect them yourself", evidence: foreign.map((l) => `${l.path} (${l.reason})`) }));
  const missingReleases = state.releases.filter((r) => !existsSync(r.path));
  if (missingReleases.length) checks.push(check({ id: "install.releases", component: "Recorded releases", status: "config-error", basis: "static", summary: "recorded releases are missing on disk", evidence: missingReleases.map((r) => `${r.version}: ${r.path}`), repair: { id: "repair", automatic: true, changes: ["forget missing releases in state.json"], command: "aria repair" } }));
  if (existsSync(releasesDir())) {
    const unknown = readdirSync(releasesDir()).filter((n) => !n.startsWith(".") && !state.releases.some((r) => samePath(r.path, join(releasesDir(), n))));
    if (unknown.length) checks.push(check({ id: "install.unknown", component: "Unrecorded release directories", status: "unverified", basis: "static", summary: "directories in releases/ that ARIA did not record; never removed automatically", evidence: unknown.map((u) => join(releasesDir(), u)) }));
  }

  // Registration
  const count = regs.entries.length + regs.discovered.length;
  const regEvidence = [...regs.entries.map((e) => `${e.file}: ${e.spec} -> ${e.target} (${e.version}${e.owned ? ", ARIA-owned" : ", user entry"})`), ...regs.discovered.map((d) => `auto-loaded from plugins folder: ${d}`), ...regs.other];
  checks.push(check({
    id: "plugin.registration", component: "Plugin registration", basis: "static",
    status: count === 0 ? "missing" : count > 1 ? "config-error" : regs.other.length ? "config-error" : "unverified",
    summary: count === 0 ? "ARIA is not registered in any OpenCode config" : count > 1 ? `registered ${count} times; OpenCode would load it more than once` : "registered once; loading not yet observed",
    evidence: regEvidence.length ? regEvidence : ["no plugins entry resolves to an ARIA package"],
    ...(count === 0 ? { repair: { id: "setup", automatic: true, changes: ["add one plugins entry for this ARIA package in the chosen scope"], command: "aria setup --scope project" } } : count > 1 ? { repair: { id: "manual", automatic: false, changes: ["remove all but one ARIA entry by hand (ARIA does not delete entries it did not write)"] } } : {}),
  }));
  const one = regs.entries.length === 1 ? regs.entries[0] : undefined;
  if (one) {
    const versionOk = !state.active || one.version === state.active || !one.target.startsWith(releasesDir());
    checks.push(check({
      id: "install.consistency", component: "Version consistency", basis: "static", status: versionOk ? "healthy" : "config-error",
      summary: versionOk ? `config loads ${one.version}` : `config loads ${one.version}, state records ${state.active}`,
      evidence: [`plugin target ${one.target}`, `state.active ${state.active ?? "none"}`],
      ...(versionOk ? {} : { repair: { id: "repair", automatic: true, changes: [`record ${one.version} as active`], command: "aria repair" } }),
    }));
    const required = ["src/index.ts", "src/tui.tsx", ...ROLE_IDS.map((r) => `prompts/${r}.md`)];
    const absent = required.filter((f) => !existsSync(join(one.target, f)));
    checks.push(check({ id: "install.files", component: "Required files", basis: "static", status: absent.length ? "config-error" : "healthy", summary: absent.length ? `missing ${absent.length} file(s)` : "server, TUI and all role prompts present", evidence: absent.length ? absent : [one.target] }));
  }

  // Config syntax
  for (const layer of staticLayers(input.project)) {
    const read = readConfig(layer.path);
    if (read.errors.length) checks.push(check({ id: `config.${layer.path}`, component: "Config file", status: "config-error", basis: "static", summary: `${layer.path} has syntax errors`, evidence: read.errors, repair: { id: "manual", automatic: false, changes: ["fix the file by hand; ARIA will not rewrite a file it cannot parse"] } }));
  }

  // Dependencies (manifest)
  const depStates = await allDeps(input.project);
  for (const d of depStates) {
    const broken = !["healthy", "unverified", "disabled"].includes(d.health);
    const fixCmd = !broken ? undefined : d.health === "outdated" ? "update" : d.actions.includes("install") ? "install" : d.actions.includes("repair") ? "repair" : undefined;
    checks.push(check({
      id: `dep.${d.id}`, component: d.name, status: d.health, basis: d.basis,
      summary: `${d.requirement === "role" ? `required by ${d.roles.length === ROLE_IDS.length ? "all roles" : d.roles.join(", ")}` : d.requirement}${d.kind === "mcp" ? `, ${d.enabled ? "enabled" : "disabled"}` : ""}${d.version ? `, ${d.version}` : ""}${d.health === "outdated" && d.pinned ? ` (pinned ${d.pinned})` : ""}`,
      evidence: d.evidence,
      ...(fixCmd && d.ownership !== "external" && d.ownership !== "reused" ? { repair: { id: "install", automatic: true, changes: [`${fixCmd} ${d.name}`], network: true, command: `aria deps ${fixCmd} ${d.id}` } } : {}),
    }));
  }
  // Role readiness: a role is not fully ready while a dependency it requires is missing or broken.
  // Roles with the same gaps are reported together; other roles are unaffected.
  const groups = new Map<string, { roles: string[]; bad: typeof depStates }>();
  for (const role of ROLE_IDS) {
    const bad = depStates.filter((d) => d.requirement === "role" && d.roles.includes(role) && !["healthy", "unverified"].includes(d.health));
    if (bad.length === 0) continue;
    const key = bad.map((d) => d.id).join(",");
    const g = groups.get(key) ?? { roles: [], bad };
    g.roles.push(role);
    groups.set(key, g);
  }
  const fixable = (d: (typeof depStates)[number]) => d.actions.some((a) => ["install", "update", "repair", "enable"].includes(a));
  const fixVerb = (d: (typeof depStates)[number]) => (d.health === "outdated" ? "update" : d.actions.includes("repair") ? "repair" : d.actions.includes("install") ? "install" : "enable");
  for (const g of groups.values()) {
    const label = g.roles.length === ROLE_IDS.length ? "all roles" : g.roles.join(", ");
    checks.push(check({
      id: `role.${g.roles[0]}`, component: `${label} readiness`, basis: "static",
      status: g.bad.every((d) => d.health === "outdated") ? "outdated" : "config-error",
      summary: `not fully ready: ${g.bad.map((d) => `${d.id} ${d.health}`).join(", ")}. Everything else keeps working`,
      evidence: g.bad.map((d) => `${d.id}: ${d.evidence.at(-1) ?? d.health}`),
      ...(g.bad.some(fixable) ? { repair: { id: "install", automatic: true, changes: g.bad.filter(fixable).map((d) => `${fixVerb(d)} ${d.name}`), network: true, command: g.bad.filter(fixable).map((d) => `aria deps ${fixVerb(d)} ${d.id}`).join(" && ") } } : {}),
    }));
  }

  // Runtime: OpenCode server view
  let runtimeProbed = false;
  const version = await opencodeVersion(input.project);
  if (!version.ok || !version.value?.version || !satisfies(version.value.version, ">=2.3.0 <3.0.0")) {
    checks.push(check({ id: "runtime.server", component: "ARIA server plugin", status: "unverified", basis: "none", summary: "cannot be checked without a compatible OpenCode", evidence: [version.error ?? `OpenCode ${version.value?.text ?? "unknown"}`] }));
    checks.push(check({ id: "runtime.tui", component: "ARIA OpenCode TUI plugin", status: "unverified", basis: "none", summary: "cannot be checked without a compatible OpenCode", evidence: [] }));
  } else if (!input.runtime) {
    checks.push(check({ id: "runtime.server", component: "ARIA server plugin", status: "unverified", basis: "none", summary: "not probed; run doctor with --runtime (queries OpenCode, may start its server)", evidence: [] }));
    checks.push(check({ id: "runtime.tui", component: "ARIA OpenCode TUI plugin", status: "unverified", basis: "none", summary: "only observable inside the OpenCode TUI (sidebar shows an ARIA block; /aria-plan opens the plan panel)", evidence: [] }));
  } else {
    runtimeProbed = true;
    const [agents, models, sources] = await Promise.all([listAgents(input.project), listModels(input.project), configSources(input.project)]);
    if (!agents.ok) {
      checks.push(check({ id: "runtime.server", component: "ARIA server plugin", status: "runtime-error", basis: "runtime", summary: "OpenCode did not return its agents", evidence: [`${agents.command}: ${agents.error}`] }));
    } else {
      const ids = new Set((agents.value ?? []).map((a) => a.id));
      const missing = ROLE_IDS.filter((r) => !ids.has(r));
      checks.push(check({
        id: "runtime.server", component: "ARIA server plugin", basis: "runtime",
        status: missing.length === 0 ? "healthy" : missing.length === ROLE_IDS.length ? "runtime-error" : "config-error",
        summary: missing.length === 0 ? `all ${ROLE_IDS.length} ARIA agents registered in the running server` : `agents not registered: ${missing.join(", ")}`,
        evidence: [`${agents.command}: ${[...ids].sort().join(", ")}`],
      }));
    }
    checks.push(check({ id: "runtime.tui", component: "ARIA OpenCode TUI plugin", status: "unverified", basis: "none", summary: "loaded by the OpenCode TUI from the same entry; not observable from the CLI", evidence: [] }));
    // Enabled integrations: the same readiness check as `aria deps check` and the TUI.
    for (const r of await Promise.all(MANIFEST.filter((d) => d.mcp).map((d) => readiness(d.id, input.project)))) {
      if (r.state === "disabled" || r.state === "not-applicable") continue;
      checks.push(check({
        id: `ready.${r.id}`, component: `${r.name} readiness`, basis: "runtime",
        status: r.state === "ready" ? "healthy" : r.state === "initialized" ? "unverified" : "runtime-error",
        summary: `${r.state} (${r.ownership}): ${r.detail}`,
        evidence: r.steps.map((st) => `${st.status === "done" ? "ok" : st.status}: ${st.name}${st.detail ? ` — ${st.detail}` : ""}`),
      }));
    }
    if (sources.ok) checks.push(check({ id: "runtime.config", component: "Config sources (OpenCode)", status: "healthy", basis: "runtime", summary: `${sources.value?.length ?? 0} sources loaded`, evidence: (sources.value ?? []).map((s) => `${s.type ?? "?"}: ${s.path ?? "(inline)"}`) }));
    const view = modelView(input.project, { ...(agents.value ? { agents: agents.value } : {}), ...(models.value ? { models: models.value } : {}) });
    const bad = view.rows.filter((r) => r.status === "invalid" || r.status === "unavailable");
    checks.push(check({
      id: "runtime.models", component: "Model routing", basis: models.ok ? "runtime" : "static",
      status: bad.length ? "config-error" : models.ok ? "healthy" : "unverified",
      summary: bad.length ? `${bad.length} role(s) pinned to an invalid or unlisted model` : models.ok ? "every pinned model is listed by OpenCode" : "model list unavailable",
      evidence: [...bad.map((r) => `${r.role}: ${r.configured} (${r.note})`), ...(models.ok ? [] : [`${models.command}: ${models.error}`])],
      ...(bad.length ? { repair: { id: "models", automatic: false, changes: ["choose another model with `aria models set` or remove the pin with `aria models reset`"] } } : {}),
    }));
  }
  if (!runtimeProbed) {
    const view = modelView(input.project);
    const invalid = view.rows.filter((r) => r.status === "invalid");
    checks.push(check({ id: "models.static", component: "Model routing", status: invalid.length ? "config-error" : "unverified", basis: "static", summary: invalid.length ? `${invalid.length} malformed model value(s)` : "values well-formed; availability not checked", evidence: invalid.map((r) => `${r.role}: ${r.configured}`) }));
  }
  const summary = Object.fromEntries(["healthy", "missing", "disabled", "outdated", "incompatible", "config-error", "runtime-error", "unverified"].map((h) => [h, checks.filter((c) => c.status === h).length])) as Record<Health, number>;
  return { checks, runtimeProbed, summary };
}

/** Problems that matter for exit codes: anything broken in a required component or configuration. A role companion (e.g. Impeccable for the visualizer) is reported, but does not fail the run: other roles keep working. */
export const failing = (r: DoctorReport) => r.checks.filter((c) => ["missing", "incompatible", "config-error", "runtime-error"].includes(c.status) && !(c.id.startsWith("dep.") && (c.summary.startsWith("optional") || c.summary.startsWith("required by"))) && !c.id.startsWith("role."));
