import { ROLE_IDS } from "../roles.ts";
import { applyEdit, configFile, getPath, planEdits, readConfig, staticLayers, type Scope } from "./config.ts";
import type { RuntimeAgent } from "./opencode.ts";
import { readState, withLock, writeState, interruptedResult } from "./state.ts";
import type { OperationResult } from "./types.ts";

/**
 * Model routing. Three different things are kept apart:
 *   configured  what a config file says (`agents.<role>.model`, or the top-level `model` default)
 *   resolved    what OpenCode's server reports for the agent (`opencode debug agents`), when probed
 *   available   whether `opencode models` lists the provider/model, when probed
 * Nothing here can see which model an already running session is using; changes affect sessions
 * started after the change (subagents launched later in an open session pick up the new agent
 * config only if OpenCode reloads configuration, which ARIA does not trigger).
 */

/** OpenCode v2.3.0 ConfigModel short form: provider/model[#variant]. */
const SHORT = /^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/;

export const validModelSpec = (spec: string) => SHORT.test(spec);

export function formatModel(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as { providerID?: string; model?: string; variant?: string };
    if (v.providerID && v.model) return `${v.providerID}/${v.model}${v.variant ? `#${v.variant}` : ""}`;
  }
  return undefined;
}

const split = (spec: string | undefined) => {
  if (!spec) return { model: undefined, variant: undefined };
  const i = spec.indexOf("#", spec.indexOf("/") + 1);
  return i === -1 ? { model: spec, variant: undefined } : { model: spec.slice(0, i), variant: spec.slice(i + 1) };
};

export interface ModelRow {
  readonly role: string;
  /** Highest-priority configured value and the file it comes from (static view). */
  readonly configured: string | undefined;
  readonly source: string;
  readonly model: string | undefined;
  readonly variant: string | undefined;
  readonly global: string | undefined;
  readonly project: string | undefined;
  /** As OpenCode resolved it, when probed. */
  readonly resolved: string | undefined;
  readonly available: boolean | undefined;
  readonly status: "ok" | "invalid" | "unavailable" | "unknown" | "inherits";
  readonly note: string;
}

export interface ModelView {
  readonly rows: readonly ModelRow[];
  /** OpenCode's top-level default (`model`), the model every unpinned role starts from. */
  readonly defaultModel: { value: string | undefined; source: string };
  readonly runtime: { agents: boolean; models: boolean; error?: string };
  readonly available: readonly string[] | undefined;
}

export function modelView(project: string, runtime: { agents?: readonly RuntimeAgent[]; models?: readonly string[]; error?: string } = {}): ModelView {
  const layers = staticLayers(project).map((l) => ({ ...l, read: readConfig(l.path) }));
  const globalFile = configFile("global", project);
  const projectFile = configFile("project", project);
  const lastValue = (path: (string | number)[]) => {
    let found: { value: string; source: string } | undefined;
    for (const l of layers) {
      const v = formatModel(getPath(l.read.value, path));
      if (v) found = { value: v, source: `${l.kind}: ${l.path}` };
    }
    return found;
  };
  const at = (file: string, path: (string | number)[]) => formatModel(getPath(readConfig(file).value, path));
  const available = runtime.models ? new Set(runtime.models) : undefined;
  const def = lastValue(["model"]);
  const rows = ROLE_IDS.map((role): ModelRow => {
    const found = lastValue(["agents", role, "model"]);
    const agent = runtime.agents?.find((a) => a.id === role);
    const resolved = agent?.model ? `${agent.model.providerID}/${agent.model.id}${agent.model.variant ? `#${agent.model.variant}` : ""}` : undefined;
    const { model, variant } = split(found?.value);
    let status: ModelRow["status"] = "unknown";
    let note = "";
    if (!found) {
      status = "inherits";
      note = def ? `no pin: uses the selected model (default ${def.value})` : "no pin: uses the selected/launching session's model";
    } else if (!validModelSpec(found.value)) {
      status = "invalid";
      note = "not provider/model[#variant]; OpenCode will reject this config";
    } else if (available) {
      status = model && available.has(model) ? "ok" : "unavailable";
      note = status === "ok" ? (variant ? "model listed by OpenCode; variant not checkable from the CLI" : "listed by OpenCode") : "not listed by `opencode models` for this project";
    } else note = "availability not checked (run with runtime probes)";
    if (runtime.agents && !agent) note += `${note ? "; " : ""}agent not registered at runtime`;
    return {
      role,
      configured: found?.value,
      source: found ? `${found.source} (static)` : "none",
      model,
      variant,
      global: at(globalFile, ["agents", role, "model"]),
      project: at(projectFile, ["agents", role, "model"]),
      resolved,
      available: model && available ? available.has(model) : undefined,
      status,
      note,
    };
  });
  return {
    rows,
    defaultModel: { value: def?.value, source: def ? `${def.source} (static)` : "none (OpenCode picks; set one with `aria models default`)" },
    runtime: { agents: Boolean(runtime.agents), models: Boolean(runtime.models), ...(runtime.error ? { error: runtime.error } : {}) },
    available: runtime.models,
  };
}

export interface SetModelInput {
  readonly role: string;
  /** provider/model[#variant]; undefined removes the pin (restore ARIA default = no pin). */
  readonly spec: string | undefined;
  readonly scope: Scope;
  readonly project: string;
  readonly dryRun: boolean;
  /** When known, refuse a model OpenCode does not list (unless force). */
  readonly available?: readonly string[];
  readonly force?: boolean;
}

/** Set, change or remove a role's model pin, or the top-level default when role is "default". */
export async function setModel(input: SetModelInput): Promise<OperationResult> {
  const interruptedGate = interruptedResult(input.dryRun);
  if (interruptedGate) return interruptedGate;
  const isDefault = input.role === "default";
  if (!isDefault && !(ROLE_IDS as readonly string[]).includes(input.role)) {
    return { ok: false, dryRun: input.dryRun, changes: [], messages: [], errors: [`unknown role ${input.role}; roles: ${ROLE_IDS.join(", ")}, or "default"`] };
  }
  if (input.spec !== undefined) {
    if (!validModelSpec(input.spec)) return { ok: false, dryRun: input.dryRun, changes: [], messages: [], errors: [`${input.spec} is not provider/model[#variant]`] };
    const model = split(input.spec).model as string;
    if (input.available && !input.available.includes(model) && !input.force) {
      return { ok: false, dryRun: input.dryRun, changes: [], messages: [], errors: [`${model} is not listed by \`opencode models\` for this project (use --force to save it anyway)`] };
    }
  }
  const file = configFile(input.scope, input.project);
  const path = isDefault ? ["model"] : ["agents", input.role, "model"];
  // Removing the last key of agents.<role> removes the empty object too (and an empty `agents`).
  const edits: { path: (string | number)[]; value: unknown }[] = [{ path, value: input.spec }];
  if (input.spec === undefined && !isDefault) {
    const current = readConfig(file).value;
    const roleObj = getPath(current, ["agents", input.role]) as Record<string, unknown> | undefined;
    if (roleObj && typeof roleObj === "object" && Object.keys(roleObj).every((k) => k === "model")) {
      const agents = getPath(current, ["agents"]) as Record<string, unknown>;
      edits.push({ path: Object.keys(agents).length === 1 ? ["agents"] : ["agents", input.role], value: undefined });
    }
  }
  let plan;
  try {
    plan = planEdits(file, edits);
  } catch (error) {
    return { ok: false, dryRun: input.dryRun, changes: [], messages: [], errors: [(error as Error).message] };
  }
  const previous = formatModel(getPath(readConfig(file).value, path)) ?? null;
  const changes = plan.changed ? [{ kind: "config" as const, target: file, summary: plan.summary.join("; ") }] : [];
  const messages = [
    plan.changed ? `${file}: ${plan.summary.join("; ")}` : "No change: the config already has this value.",
    "Applies to sessions started after the change; a running session keeps the model it started with.",
  ];
  if (input.spec?.includes("#")) messages.push("The variant is saved as given; OpenCode's CLI cannot list variants, so it is checked only when a session starts.");
  if (input.dryRun || !plan.changed) return { ok: true, dryRun: input.dryRun, changes, messages, errors: [] };
  await withLock(async () => {
    applyEdit(plan);
    const { state } = readState();
    state.models.push({ role: input.role, scope: input.scope, file, previous, next: input.spec ?? null, at: new Date().toISOString() });
    state.models = state.models.slice(-50);
    writeState(state);
  });
  return { ok: true, dryRun: false, changes, messages, errors: [] };
}

/** Undo the most recent ARIA model change for a role (in the scope it was made). */
export async function restoreModel(role: string, project: string, dryRun: boolean): Promise<OperationResult> {
  const interruptedGate = interruptedResult(dryRun);
  if (interruptedGate) return interruptedGate;
  const { state } = readState();
  const last = [...state.models].reverse().find((c) => c.role === role);
  if (!last) return { ok: false, dryRun, changes: [], messages: [], errors: [`no recorded model change for ${role}`] };
  const current = formatModel(getPath(readConfig(last.file).value, role === "default" ? ["model"] : ["agents", role, "model"])) ?? null;
  if (current !== last.next) {
    return { ok: false, dryRun, changes: [], messages: [], errors: [`${last.file} no longer holds the value ARIA set (${last.next ?? "none"} -> now ${current ?? "none"}); not changing a value someone else edited`] };
  }
  const result = await setModel({ role, spec: last.previous ?? undefined, scope: last.scope, project, dryRun });
  if (result.ok && !dryRun) {
    await withLock(async () => {
      const fresh = readState().state;
      // Drop the original change and the record the restore itself produced, so history steps back.
      const restoreRecord = fresh.models.findLastIndex((c) => c.role === role);
      if (restoreRecord >= 0) fresh.models.splice(restoreRecord, 1);
      const original = fresh.models.findLastIndex((c) => c.role === role && c.at === last.at);
      if (original >= 0) fresh.models.splice(original, 1);
      writeState(fresh);
    });
  }
  return result;
}
