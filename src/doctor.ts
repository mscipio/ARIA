import { constants as fsConstants } from "node:fs";
import { access as fsAccess, readFile, stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";

import { getPackageRoot } from "./defaults.js";
import {
  defaultExecutor,
  doctor as dependencyDoctor,
  extractVersion,
  probeSubagentDepth,
  type DepsStatus,
  type Executor,
  type SubagentDepthProbe,
} from "./deps.js";
import { discoverAvailableModels, type AvailableModel, type ModelDiscoverFn, type ModelDiscovery } from "./model-config.js";
import {
  agentFileName,
  defaultAgentsDir,
  generateAgentFiles,
  parseManagedHeader,
  readPackageVersion,
} from "./agents.js";
import { PLAN_TOOL_NAME } from "./plan-tool.js";
import {
  CODING_ROLES,
  PACKAGE_SKILL_NAMES,
  roleRequirementIssues,
  validateZotPilotPolicy,
} from "./register.js";
import { deriveRoutes, ROLES, type ResolvedRoute } from "./routes.js";
import { resolveSetupAriaConfig } from "./setup-config.js";
import { ARIA_SKILL_NAMES } from "./skills.js";
import type { AriaDefaults, RoleDefaults } from "./types.js";

/**
 * Read-only ARIA doctor: aggregates package, config, routes/models, skills,
 * required integrations, and optional ZotPilot/Wiki probes into
 * PASS/WARN/FAIL/SKIP findings. Probe and config errors are aggregated into
 * findings rather than thrown, and nothing is written, installed, or
 * repaired.
 */

export type DoctorFindingSeverity = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface DoctorFinding {
  severity: DoctorFindingSeverity;
  /** Finding group: "package", "config", "routes/models", "dependencies", "skills", "zotpilot", "wiki". */
  area: string;
  title: string;
  detail?: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
}

/** Read-only stat result used for non-mutating metadata checks. */
export interface DoctorFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Read-only filesystem seam used for package/skill/wiki validation. */
export interface DoctorFileOps {
  readText(path: string): Promise<string>;
  /** Non-mutating metadata check (defaults to node:fs stat). */
  stat?(path: string): Promise<DoctorFileStat>;
  /** Non-mutating accessibility check (defaults to node:fs access). */
  access?(path: string, mode: number): Promise<void>;
}

const defaultFileOps: DoctorFileOps = {
  readText: (path) => readFile(path, "utf8"),
  stat: (path) => fsStat(path),
  access: (path, mode) => fsAccess(path, mode),
};

export interface DoctorOptions {
  /** Command execution seam for the composed dependency doctor. */
  executor?: Executor;
  /** Model discovery seam (defaults to `discoverAvailableModels`). */
  discovery?: ModelDiscoverFn;
  /** Worktree whose config and resolved routes are inspected. */
  worktree?: string;
  /** Read-only filesystem seam for package validation (defaults to node:fs). */
  fileOps?: DoctorFileOps;
  /**
   * T008 V2 runtime snapshot (plugin/agent/skill/tool lists, session count).
   * Built from a live plugin `Context` via `snapshotFromContext`; absent
   * outside a live 2.0.23 session, where runtime findings report SKIP with
   * the documented gap (the standalone CLI never guesses live state).
   */
  v2?: DoctorV2Snapshot;
  /** Managed agent directory verified by the file finding (defaults to global). */
  agentsDir?: string;
}

/**
 * ANSI escape sequences (SGR color codes and friends) that upstream CLIs can
 * emit even on non-TTY stderr. Embedded probe error text is stripped so the
 * rendered report stays plain in every environment.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function describeError(error: unknown): string {
  let text: string;
  if (error instanceof Error && error.message) {
    text = error.message;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return text.replace(ANSI_ESCAPE_RE, "");
}

// ---------------------------------------------------------------------------
// Package validation: package.json version, defaults, and packaged prompts
// ---------------------------------------------------------------------------

/** The current packaged-role mode contract (mirrors `RoleDefaults["mode"]`). */
const ROLE_MODES = new Set<RoleDefaults["mode"]>(["primary", "subagent", "all"]);

/**
 * Bounded validation of the current `AriaDefaults` shape that role resolution
 * and registration actually consume: every canonical role must be a plain
 * object with a non-empty `model` and `promptFile`, a `mode` from the current
 * contract, and, when present, a non-empty string `variant`. Malformed
 * defaults FAIL instead of silently reaching resolution.
 */
function validateDefaults(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "defaults root is not an object" };
  }
  const roles = (raw as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    return { ok: false, reason: "defaults.roles missing or not an object" };
  }
  const roleEntries = roles as Record<string, unknown>;
  for (const role of ROLES) {
    const entry = roleEntries[role];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `defaults.roles.${role} missing or invalid` };
    }
    const roleEntry = entry as Partial<Record<keyof RoleDefaults, unknown>>;
    const model = roleEntry.model;
    if (typeof model !== "string" || model.trim().length === 0) {
      return { ok: false, reason: `defaults.roles.${role}.model missing or empty` };
    }
    const mode = roleEntry.mode;
    if (typeof mode !== "string" || !ROLE_MODES.has(mode as RoleDefaults["mode"])) {
      return { ok: false, reason: `defaults.roles.${role}.mode missing or invalid (expected "primary", "subagent", or "all")` };
    }
    const variant = roleEntry.variant;
    if (variant !== undefined && (typeof variant !== "string" || variant.trim().length === 0)) {
      return { ok: false, reason: `defaults.roles.${role}.variant invalid (expected a non-empty string when present)` };
    }
    const promptFile = roleEntry.promptFile;
    if (typeof promptFile !== "string" || promptFile.trim().length === 0) {
      return { ok: false, reason: `defaults.roles.${role}.promptFile missing or empty` };
    }
  }
  return { ok: true };
}

async function collectPackageFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  // package.json version (required).
  try {
    const raw = await fileOps.readText(resolve(packageRoot, "package.json"));
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      findings.push({
        severity: "PASS",
        area: "package",
        title: "package.json version",
        detail: parsed.version,
      });
    } else {
      findings.push({
        severity: "FAIL",
        area: "package",
        title: "package.json version",
        detail: "missing or empty version",
      });
    }
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "package",
      title: "package.json version",
      detail: describeError(error),
    });
  }

  // Packaged defaults (required).
  let defaults: AriaDefaults | undefined;
  try {
    const raw = await fileOps.readText(resolve(packageRoot, "defaults", "aria.defaults.json"));
    const parsed = JSON.parse(raw) as unknown;
    const valid = validateDefaults(parsed);
    if (valid.ok) {
      defaults = parsed as AriaDefaults;
      findings.push({ severity: "PASS", area: "package", title: "defaults" });
    } else {
      findings.push({ severity: "FAIL", area: "package", title: "defaults", detail: valid.reason });
    }
  } catch (error) {
    findings.push({ severity: "FAIL", area: "package", title: "defaults", detail: describeError(error) });
  }

  // Each defaults-referenced prompt (required).
  if (defaults) {
    for (const role of ROLES) {
      const promptFile = defaults.roles[role].promptFile;
      try {
        const text = await fileOps.readText(resolve(packageRoot, "defaults", promptFile));
        if (text.trim().length === 0) {
          findings.push({
            severity: "FAIL",
            area: "package",
            title: `prompt ${role}`,
            detail: `defaults/${promptFile} is empty`,
          });
        } else {
          findings.push({ severity: "PASS", area: "package", title: `prompt ${role}` });
        }
      } catch (error) {
        findings.push({
          severity: "FAIL",
          area: "package",
          title: `prompt ${role}`,
          detail: `defaults/${promptFile}: ${describeError(error)}`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Route/model cross-check
// ---------------------------------------------------------------------------

function routeFinding(route: ResolvedRoute, discovered: Map<string, AvailableModel>): DoctorFinding[] {
  const model = discovered.get(route.model);
  const routeText = route.variant ? `${route.model} (${route.variant})` : route.model;
  if (!model) {
    return [{
      severity: "FAIL",
      area: "routes/models",
      title: route.role,
      detail: `configured model ${route.model} is not listed by opencode models`,
    }];
  }
  if (!route.variant) {
    return [{ severity: "PASS", area: "routes/models", title: route.role, detail: route.model }];
  }
  if (model.variantsObservable !== true) {
    // Variant capability unknown: plain `opencode models` (pinned 2.0.23)
    // reports no variant metadata, so a configured variant is never guessed
    // and never failed — it is reported as unknown.
    return [{
      severity: "WARN",
      area: "routes/models",
      title: route.role,
      detail: `${routeText}: variant support unknown (variant metadata not observable; configured variant not verified)`,
    }];
  }
  if (model.variants.includes(route.variant)) {
    return [{ severity: "PASS", area: "routes/models", title: route.role, detail: routeText }];
  }
  const reported = model.variants.length > 0
    ? ` (reported: ${model.variants.join(", ")})`
    : " (no reported variants)";
  return [{
    severity: "FAIL",
    area: "routes/models",
    title: route.role,
    detail: `${routeText}: configured variant not supported${reported}`,
  }];
}

// ---------------------------------------------------------------------------
// Config: effective subagent depth (read-only `opencode debug config`)
// ---------------------------------------------------------------------------

/**
 * Advisory finding for the effective merged top-level `subagent_depth`
 * reported by the read-only `opencode debug config` probe. An absent field is
 * PASS (ARIA supplies the runtime default/recommendation 3); a finite numeric
 * value >= 3 is PASS with the effective value; a finite numeric value < 3 is
 * a nonfatal WARN with the effective value and possible degraded nested
 * cooperation; unavailable/malformed output is a nonfatal WARN. This finding
 * never FAILs and never attributes the value to user configuration or ARIA.
 */
function subagentDepthFinding(probe: SubagentDepthProbe): DoctorFinding {
  if (probe.status === "absent") {
    return {
      severity: "PASS",
      area: "config",
      title: "subagent depth",
      detail: "absent from merged debug config; ARIA supplies runtime default/recommendation 3",
    };
  }
  if (probe.status === "value") {
    return probe.depth >= 3
      ? {
          severity: "PASS",
          area: "config",
          title: "subagent depth",
          detail: `effective value ${probe.depth} is sufficient for nested ARIA cooperation`,
        }
      : {
          severity: "WARN",
          area: "config",
          title: "subagent depth",
          detail: `effective value ${probe.depth}; nested ARIA cooperation may be degraded`,
        };
  }
  return {
    severity: "WARN",
    area: "config",
    title: "subagent depth",
    detail: `effective value not identified: ${probe.reason}`,
  };
}

// ---------------------------------------------------------------------------
// T008 V2 runtime truth: plugin/agent/skill/tool lists + session inventory
// ---------------------------------------------------------------------------

/**
 * Pinned `@opencode/plugin@2.0.23` Context domain inspection
 * (`dist/promise/plugin.d.ts`):
 * - `plugin: Pick<PluginApi, "list">` — V2 plugin inventory (used).
 * - `agent: AgentDomain extends AgentApi` — `list()` carries full
 *   `Agent.Info` (id/mode/model/permissions); per-agent `get()` adds
 *   nothing, so only `list()` is used.
 * - `skill: SkillDomain extends SkillApi` — `list()` carries `Skill.Info`
 *   (id/name); used. `ctx.skill.transform` stays unused (T007 single
 *   source is config discovery).
 * - `tool: ToolDomain` — `list()` returns the effective post-transform
 *   tools (plugin-local); used for the plan-tool-once check. There is no
 *   `tool` HTTP client API, so this list is runtime-only.
 * - `session: SessionDomain extends SessionApi` — `list()` observes live
 *   sessions; informational only (sessions carry no ARIA registration
 *   state), best-effort.
 *
 * Documented gaps (no guessing): Context has no `config` domain
 * (`config.get` is unavailable to plugins), so merged-config state is
 * verified through the global files setup wrote plus the advisory
 * read-only `debug config` probe — never as authoritative truth. There is
 * no `debug` domain. Permission saved/request lists add nothing beyond the
 * agent permissions observed directly. `ctx.*.list` is unreachable from the
 * standalone CLI, which reports SKIP (never FAIL) for runtime findings.
 */

/** Pinned OpenCode runtime target (plan T001 audit gate + exact dep pin). */
export const SUPPORTED_OPENCODE_VERSION = "2.0.23";

/** Structural V2 agent entry (only the fields findings inspect). */
export interface DoctorV2AgentEntry {
  id: string;
  mode?: unknown;
  model?: unknown;
  permissions?: unknown;
}

/** Structural V2 plugin entry (`PluginInfo.id` is optional upstream). */
export interface DoctorV2PluginEntry {
  id?: unknown;
  state?: unknown;
}

/** Structural V2 skill entry (`Skill.Info` id/name). */
export interface DoctorV2SkillEntry {
  id?: unknown;
  name?: unknown;
}

/** Structural V2 tool entry (effective name plus id). */
export interface DoctorV2ToolEntry {
  id?: unknown;
  name?: unknown;
}

/**
 * V2 runtime snapshot: the primary truth for setup verification. Every
 * field is optional; absent fields mean "unobserved" (SKIP), never healthy
 * or broken.
 */
export interface DoctorV2Snapshot {
  plugins?: DoctorV2PluginEntry[] | undefined;
  agents?: DoctorV2AgentEntry[] | undefined;
  skills?: DoctorV2SkillEntry[] | undefined;
  tools?: DoctorV2ToolEntry[] | undefined;
  /** Live session count when a runtime session list was observed. */
  sessionsObserved?: number | undefined;
}

/** Shared gap wording when no live V2 list is available to the CLI. */
const RUNTIME_LIST_GAP =
  "V2 runtime list unavailable outside a live OpenCode 2.0.23 session (ctx.*.list is runtime-only; the standalone CLI has no live-session access)";

/** Quota v5 + Engram3 stay UNKNOWN until the T010 runtime gate tests them. */
const COEXISTENCE_UNKNOWN =
  "quota v5 + Engram3 coexistence UNKNOWN until runtime-tested (T010); no plugin ordering assumed";

function pluginRuntimeFinding(plugins: DoctorV2PluginEntry[] | undefined): DoctorFinding {
  if (plugins === undefined) {
    return { severity: "SKIP", area: "runtime", title: "plugin aria", detail: RUNTIME_LIST_GAP };
  }
  const aria = plugins.filter((plugin) => plugin.id === "aria");
  if (aria.length === 0) {
    return { severity: "FAIL", area: "runtime", title: "plugin aria", detail: "aria is not in the V2 plugin list" };
  }
  if (aria.length > 1) {
    return { severity: "FAIL", area: "runtime", title: "plugin aria", detail: "aria is listed more than once (duplicate registration)" };
  }
  const state = aria[0]?.state;
  const status = state && typeof state === "object" ? (state as { status?: unknown }).status : undefined;
  if (status !== undefined && status !== "active") {
    return {
      severity: "FAIL",
      area: "runtime",
      title: "plugin aria",
      detail: `aria plugin state is ${JSON.stringify(status) ?? typeof status} (expected "active")`,
    };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "plugin aria",
    detail: status === "active" ? "aria is listed and active" : "aria is listed (plugin state not reported)",
  };
}

/** Legacy V2 permission actions that ARIA roles must never carry (T004). */
const LEGACY_AGENT_ACTIONS = new Set(["bash", "task", "plan", "todowrite", "list", "lsp", "doom_loop"]);

const AGENT_MODES = new Set(["primary", "subagent", "all"]);

function agentEntryIssues(role: string, entry: DoctorV2AgentEntry): string[] {
  const issues: string[] = [];
  if (typeof entry.mode !== "string" || !AGENT_MODES.has(entry.mode)) {
    issues.push(`${role}: mode is ${JSON.stringify(entry.mode) ?? typeof entry.mode} (expected "primary", "subagent", or "all")`);
  }
  const model = entry.model;
  const modelPresent = typeof model === "string"
    ? model.length > 0
    : !!model && typeof model === "object";
  if (!modelPresent) issues.push(`${role}: model is missing (expected an explicit V2 model selector)`);
  if (!Array.isArray(entry.permissions) || entry.permissions.length === 0) {
    issues.push(`${role}: permissions are missing or empty (expected explicit V2 Rule[])`);
    return issues;
  }
  const actions: string[] = [];
  for (const rule of entry.permissions) {
    if (!rule || typeof rule !== "object") continue;
    const action = (rule as { action?: unknown }).action;
    if (typeof action === "string") actions.push(action);
  }
  const legacy = actions.filter((action) => LEGACY_AGENT_ACTIONS.has(action));
  if (legacy.length > 0) issues.push(`${role}: legacy permission actions ${[...new Set(legacy)].join(", ")} (use V2 shell/subagent names)`);
  const blanket = (entry.permissions as Array<unknown>).some((rule) => {
    if (!rule || typeof rule !== "object") return false;
    const record = rule as { action?: unknown; resource?: unknown; effect?: unknown };
    return record.action === "*" && record.resource === "*" && record.effect === "allow";
  });
  if (blanket) issues.push(`${role}: blanket allow {action:"*",resource:"*",effect:"allow"} overrides the native default unexpectedly`);
  return issues;
}

function agentsRuntimeFinding(agents: DoctorV2AgentEntry[] | undefined): DoctorFinding {
  if (agents === undefined) {
    return { severity: "SKIP", area: "runtime", title: "agents (11)", detail: RUNTIME_LIST_GAP };
  }
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
  const problems: string[] = [];
  const missing = ROLES.filter((role) => !counts.has(role));
  if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
  const duplicated = ROLES.filter((role) => (counts.get(role) ?? 0) > 1);
  if (duplicated.length > 0) problems.push(`listed more than once: ${duplicated.join(", ")}`);
  // Live models are intentionally NOT compared to resolved routes: T005
  // project overlays patch models at runtime via `agent.update`, so a
  // difference is a legitimate overlay, not drift. Only presence,
  // uniqueness, and explicit V2 shape are verified here.
  for (const role of ROLES) {
    if (!counts.has(role)) continue;
    const entry = agents.find((agent) => agent.id === role);
    if (entry) problems.push(...agentEntryIssues(role, entry));
  }
  if (problems.length > 0) {
    return { severity: "FAIL", area: "runtime", title: "agents (11)", detail: problems.join("; ") };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "agents (11)",
    detail: "11 of 11 roles listed exactly once with explicit mode/model/permissions (V2 shell/subagent names)",
  };
}

function skillsRuntimeFinding(skills: DoctorV2SkillEntry[] | undefined): DoctorFinding {
  if (skills === undefined) {
    return { severity: "SKIP", area: "runtime", title: "skills (21 live)", detail: RUNTIME_LIST_GAP };
  }
  const names = skills
    .map((skill) => (typeof skill.name === "string" && skill.name.length > 0 ? skill.name : skill.id))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const problems: string[] = [];
  const missing = ARIA_SKILL_NAMES.filter((name) => !names.includes(name));
  if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
  const duplicated = ARIA_SKILL_NAMES.filter((name) => names.filter((seen) => seen === name).length > 1);
  if (duplicated.length > 0) problems.push(`listed more than once: ${duplicated.join(", ")}`);
  if (problems.length > 0) {
    return { severity: "FAIL", area: "runtime", title: "skills (21 live)", detail: problems.join("; ") };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "skills (21 live)",
    detail: "21 of 21 packaged skills listed exactly once",
  };
}

function planToolRuntimeFinding(tools: DoctorV2ToolEntry[] | undefined): DoctorFinding {
  if (tools === undefined) {
    return { severity: "SKIP", area: "runtime", title: "plan tool", detail: RUNTIME_LIST_GAP };
  }
  const matches = tools.filter((tool) => tool.name === PLAN_TOOL_NAME || tool.id === PLAN_TOOL_NAME);
  if (matches.length === 0) {
    return {
      severity: "FAIL",
      area: "runtime",
      title: "plan tool",
      detail: `plan tool "${PLAN_TOOL_NAME}" is not in the V2 tool list`,
    };
  }
  if (matches.length > 1) {
    return {
      severity: "FAIL",
      area: "runtime",
      title: "plan tool",
      detail: `plan tool "${PLAN_TOOL_NAME}" is listed more than once (conflicting registration)`,
    };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "plan tool",
    detail: `plan tool "${PLAN_TOOL_NAME}" present exactly once`,
  };
}

/**
 * Coexistence by generic rules only: duplicate IDs anywhere in the observed
 * lists are collisions regardless of owner (no ordering assumed, no owner
 * attributed), and observed ARIA agent permissions must stay explicit.
 * Cleanup (setup cleanup + transform `Registration.dispose`) and transform
 * ordering are code-owned and list-unobservable, so they are documented
 * here, not asserted.
 */
function coexistenceFinding(snapshot: DoctorV2Snapshot): DoctorFinding {
  const { plugins, agents, skills, tools } = snapshot;
  if (plugins === undefined && agents === undefined && skills === undefined && tools === undefined) {
    return {
      severity: "SKIP",
      area: "runtime",
      title: "coexistence",
      detail: `${COEXISTENCE_UNKNOWN} (no V2 lists observed; CLI has no live-session access)`,
    };
  }
  const problems: string[] = [];
  const duplicates = (kind: string, ids: Array<string | undefined>): void => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) problems.push(`duplicate ${kind} id: ${id}`);
    }
  };
  if (plugins !== undefined) duplicates("plugin", plugins.map((plugin) => typeof plugin.id === "string" ? plugin.id : undefined));
  if (agents !== undefined) duplicates("agent", agents.map((agent) => agent.id));
  if (skills !== undefined) {
    duplicates("skill", skills.map((skill) =>
      typeof skill.name === "string" && skill.name.length > 0 ? skill.name
      : typeof skill.id === "string" ? skill.id : undefined));
  }
  if (tools !== undefined) {
    duplicates("tool", tools.map((tool) =>
      typeof tool.name === "string" && tool.name.length > 0 ? tool.name
      : typeof tool.id === "string" ? tool.id : undefined));
  }
  if (agents !== undefined) {
    for (const agent of agents) {
      if (!(ROLES as readonly string[]).includes(agent.id)) continue;
      problems.push(...agentEntryIssues(agent.id, agent));
    }
  }
  const evaluated = [
    plugins !== undefined ? "plugins" : "",
    agents !== undefined ? "agents" : "",
    skills !== undefined ? "skills" : "",
    tools !== undefined ? "tools" : "",
  ].filter(Boolean).join("/");
  if (problems.length > 0) {
    return {
      severity: "FAIL",
      area: "runtime",
      title: "coexistence",
      detail: `${COEXISTENCE_UNKNOWN}. Observed ${evaluated}: ${problems.join("; ")}`,
    };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "coexistence",
    detail: `${COEXISTENCE_UNKNOWN}. Observed ${evaluated}: no ID collisions and ARIA permissions stay explicit (cleanup/ordering are code-owned, list-unobservable)`,
  };
}

function sessionRuntimeFinding(sessionsObserved: number | undefined): DoctorFinding {
  if (sessionsObserved === undefined) {
    return {
      severity: "SKIP",
      area: "runtime",
      title: "session/runtime inventory",
      detail: "ctx.session.list/active is runtime-only; the standalone CLI has no live-session access; sessions carry no ARIA registration state",
    };
  }
  return {
    severity: "PASS",
    area: "runtime",
    title: "session/runtime inventory",
    detail: `${sessionsObserved} live session(s) observed (informational; not setup truth)`,
  };
}

function collectRuntimeFindings(snapshot: DoctorV2Snapshot | undefined): DoctorFinding[] {
  return [
    pluginRuntimeFinding(snapshot?.plugins),
    agentsRuntimeFinding(snapshot?.agents),
    skillsRuntimeFinding(snapshot?.skills),
    planToolRuntimeFinding(snapshot?.tools),
    coexistenceFinding(snapshot ?? {}),
    sessionRuntimeFinding(snapshot?.sessionsObserved),
  ];
}

/**
 * Build a V2 snapshot from a live plugin `Context`. Every domain list is
 * attempted independently and defensively: a missing domain or a throwing
 * list degrades that field to unobserved (SKIP downstream), never to a
 * failure. Client lists return `{data: [...]}` while `ctx.tool.list()`
 * returns the entry array directly; both shapes are accepted.
 */
export async function snapshotFromContext(ctx: unknown): Promise<DoctorV2Snapshot> {
  const snapshot: DoctorV2Snapshot = {};
  if (!ctx || typeof ctx !== "object") return snapshot;
  const domains = ctx as {
    plugin?: { list?: unknown };
    agent?: { list?: unknown };
    skill?: { list?: unknown };
    tool?: { list?: unknown };
    session?: { list?: unknown };
  };

  const tryList = async (list: unknown): Promise<unknown> => {
    if (typeof list !== "function") return undefined;
    try {
      return await (list as () => unknown)();
    } catch {
      return undefined;
    }
  };
  const asEntries = (result: unknown): Array<Record<string, unknown>> | undefined => {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === "object") {
      const data = (result as { data?: unknown }).data;
      if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
      const sessions = (result as { sessions?: unknown }).sessions;
      if (Array.isArray(sessions)) return sessions as Array<Record<string, unknown>>;
    }
    return undefined;
  };

  const pluginEntries = asEntries(await tryList(domains.plugin?.list));
  if (pluginEntries) {
    snapshot.plugins = pluginEntries.map((entry) => ({ id: entry["id"], state: entry["state"] }));
  }
  const agentEntries = asEntries(await tryList(domains.agent?.list));
  if (agentEntries) {
    snapshot.agents = agentEntries
      .filter((entry) => typeof entry["id"] === "string")
      .map((entry) => ({
        id: entry["id"] as string,
        mode: entry["mode"],
        model: entry["model"],
        permissions: entry["permissions"],
      }));
  }
  const skillEntries = asEntries(await tryList(domains.skill?.list));
  if (skillEntries) {
    snapshot.skills = skillEntries.map((entry) => ({ id: entry["id"], name: entry["name"] }));
  }
  const toolEntries = asEntries(await tryList(domains.tool?.list));
  if (toolEntries) {
    snapshot.tools = toolEntries.map((entry) => ({ id: entry["id"], name: entry["name"] }));
  }
  const sessionEntries = asEntries(await tryList(domains.session?.list));
  if (sessionEntries) {
    snapshot.sessionsObserved = sessionEntries.length;
  }
  return snapshot;
}

/** Wording marking fresh CLI observations as distinct from live-session inventory. */
const FRESH_CLI_OBSERVATION = "fresh standalone `opencode mcp list` CLI observation (not live-session inventory)";

// ---------------------------------------------------------------------------
// Composed dependency doctor (legacy deps.ts health probes)
// ---------------------------------------------------------------------------

function openCodeFinding(opencode: DepsStatus["opencode"]): DoctorFinding {
  if (!opencode.found) {
    return { severity: "FAIL", area: "dependencies", title: "OpenCode", detail: "not found" };
  }
  if (opencode.version === SUPPORTED_OPENCODE_VERSION) {
    return { severity: "PASS", area: "dependencies", title: "OpenCode", detail: opencode.version };
  }
  return {
    severity: "FAIL",
    area: "dependencies",
    title: "OpenCode",
    detail: `expected OpenCode ${SUPPORTED_OPENCODE_VERSION}, found ${opencode.version ?? "unknown version"}`,
  };
}

function dependencyFindings(deps: DepsStatus): DoctorFinding[] {
  return [
    openCodeFinding(deps.opencode),
    {
      severity: deps.engram.found && deps.engram.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "Engram",
      detail: !deps.engram.found
        ? "not found"
        : !deps.engram.connected
          ? "not connected"
          : `${deps.engram.version ?? "version unknown"} (${FRESH_CLI_OBSERVATION})`,
    },
    {
      severity: deps.context7.configured && deps.context7.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "Context7",
      detail: !deps.context7.configured
        ? "not configured"
        : !deps.context7.connected
          ? "not connected"
          : `configured (${FRESH_CLI_OBSERVATION})`,
    },
    {
      severity: deps.codegraph.found && deps.codegraph.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "CodeGraph",
      detail: !deps.codegraph.found
        ? "not found"
        : !deps.codegraph.connected
          ? "not connected"
          : `${deps.codegraph.version ?? "version unknown"} (${FRESH_CLI_OBSERVATION})`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Optional ZotPilot: CLI availability/version, MCP connectivity, limitation
// ---------------------------------------------------------------------------

/**
 * Smallest safe ZotPilot CLI probe: `zotpilot --version` only. Never runs
 * `mcp serve`, doctor/setup/upgrade/index, or anything touching Zotero or
 * configuration.
 */
async function probeZotPilotCli(executor: Executor): Promise<{ found: boolean; version: string | null; reason?: string }> {
  try {
    const result = await executor("zotpilot", ["--version"]);
    const version = extractVersion(result.stdout);
    if (!version) return { found: false, version: null, reason: "probe output not parseable" };
    return { found: true, version };
  } catch (error) {
    return { found: false, version: null, reason: describeError(error) };
  }
}

function zotPilotCliFinding(probe: { found: boolean; version: string | null; reason?: string }): DoctorFinding {
  if (probe.found && probe.version) {
    return {
      severity: "PASS",
      area: "zotpilot",
      title: "ZotPilot CLI",
      detail: `available (${probe.version}) via zotpilot --version`,
    };
  }
  return {
    severity: "WARN",
    area: "zotpilot",
    title: "ZotPilot CLI",
    detail: probe.reason
      ? `availability/version not identified: ${probe.reason} (ZotPilot MCP may still work)`
      : "availability/version not identified (ZotPilot MCP may still work)",
  };
}

/**
 * ZotPilot MCP connectivity, kept clearly separate from CLI availability.
 * Optional at runtime but expected for the advertised researcher capability,
 * so degraded states are WARN, never FAIL.
 */
function zotPilotMcpFindings(deps: DepsStatus | undefined): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (!deps || deps.mcpListFailed) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: deps?.mcpListFailed
        ? "opencode mcp list failed; server presence unknown"
        : "dependency probes failed; server presence unknown",
    });
  } else if (!deps.zotpilot) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: "not listed by opencode mcp list",
    });
  } else if (!deps.zotpilot.connected) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: "listed by opencode mcp list but not connected",
    });
  } else {
    findings.push({
      severity: "PASS",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: `connected (${FRESH_CLI_OBSERVATION})`,
    });
  }
  findings.push({
    severity: "SKIP",
    area: "zotpilot",
    title: "live tool inventory",
    detail: "standalone aria doctor cannot compare expected/present/missing/unexpected live ZotPilot tool IDs or OpenCode session permissions; no safe supported tools/list mechanism exists",
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Package skills and canonical role/ZotPilot policy validation
// ---------------------------------------------------------------------------

/** Minimal YAML-frontmatter extraction for packaged SKILL.md validation. */
function parseSkillFrontmatter(text: string): { name?: string; owner?: string; error?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return { error: "frontmatter missing" };
  const block = match[1];
  const nameMatch = block.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  const metadataMatch = block.match(/^metadata:\s*\r?\n((?:\s+[^\r\n]*\r?\n?)*)/m);
  const ownerMatch = metadataMatch?.[1]?.match(/^\s+owner:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return {
    name: nameMatch?.[1]?.trim(),
    owner: ownerMatch?.[1]?.trim(),
  };
}

/**
 * Validate every exact `<package skill root>/<name>/SKILL.md` referenced by
 * the derived packaged-skill inventory, with matching frontmatter `name` and
 * `metadata.owner: aria`. Only the exact derived paths are read; the skills
 * directory is never scanned, so user skills are never touched.
 */
async function collectSkillFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const failures: string[] = [];

  for (const name of PACKAGE_SKILL_NAMES) {
    const skillPath = resolve(packageRoot, "skills", name, "SKILL.md");
    try {
      const text = await fileOps.readText(skillPath);
      const meta = parseSkillFrontmatter(text);
      if (meta.error) {
        failures.push(`${name}: ${meta.error}`);
      } else if (meta.name !== name) {
        failures.push(`${name}: frontmatter name mismatch (got ${meta.name ?? "none"})`);
      } else if (meta.owner !== "aria") {
        failures.push(`${name}: metadata.owner is ${meta.owner ?? "missing"}, expected aria`);
      }
    } catch (error) {
      failures.push(`${name}: ${describeError(error)}`);
    }
  }

  if (failures.length === 0) {
    findings.push({
      severity: "PASS",
      area: "skills",
      title: "packaged skills",
      detail: `${PACKAGE_SKILL_NAMES.length} of ${PACKAGE_SKILL_NAMES.length} validated (matching name, metadata.owner: aria)`,
    });
  } else {
    findings.push({
      severity: "FAIL",
      area: "skills",
      title: "packaged skills",
      detail: failures.join("; "),
    });
  }
  return findings;
}

/**
 * Canonical role policy findings. The ZotPilot policy finding compares the
 * canonical expected IDs with the effective researcher entries and truthfully
 * reports present/missing/unexpected package-policy IDs; this is internal
 * policy validation, not a live tool inventory.
 */
function rolePolicyFindings(): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const roleIssues = roleRequirementIssues();
  findings.push(roleIssues.length === 0
    ? {
        severity: "PASS",
        area: "skills",
        title: "role permission requirements",
        detail: `coding roles (${CODING_ROLES.join(", ")}) have Engram/Context7/CodeGraph; researcher has Context7 + exact ZotPilot policy; writer/archivist are non-coding`,
      }
    : {
        severity: "FAIL",
        area: "skills",
        title: "role permission requirements",
        detail: roleIssues.join("; "),
      });

  const policy = validateZotPilotPolicy();
  if (policy.issues.length === 0) {
    findings.push({
      severity: "PASS",
      area: "skills",
      title: "ZotPilot policy",
      detail: `${policy.expectedReadIds.length} read allow + ${policy.expectedMutationIds.length} mutation ask, disjoint, no wildcards`,
    });
  } else {
    const parts = [
      ...policy.issues,
      policy.missing.length > 0 ? `missing: ${policy.missing.join(", ")}` : "",
      policy.unexpected.length > 0 ? `unexpected: ${policy.unexpected.join(", ")}` : "",
      policy.wildcards.length > 0 ? `wildcards: ${policy.wildcards.join(", ")}` : "",
    ].filter(Boolean);
    findings.push({
      severity: "FAIL",
      area: "skills",
      title: "ZotPilot policy",
      detail: parts.join("; "),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Managed agent files: installed bytes match version + resolved config
// ---------------------------------------------------------------------------

/**
 * Read-only verification that the eleven managed agent files setup installs
 * match what the current install would generate (package version plus
 * project-neutral resolved config: defaults + global overrides). A fully
 * absent install is SKIP (setup has not run; `aria setup` generates them);
 * any other mismatch is FAIL with the affected roles. Only the exact
 * managed paths are read; unrelated user agents are never touched.
 */
async function collectAgentFileFindings(
  worktree: string,
  agentsDir: string,
  fileOps: DoctorFileOps,
): Promise<DoctorFinding[]> {
  let expected: Record<string, string>;
  let version: string;
  try {
    version = readPackageVersion();
    expected = generateAgentFiles(resolveSetupAriaConfig(worktree), version) as Record<string, string>;
  } catch (error) {
    return [{
      severity: "FAIL",
      area: "config",
      title: "managed agent files",
      detail: describeError(error),
    }];
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const role of ROLES) {
    const skillPath = resolve(agentsDir, agentFileName(role));
    let text: string;
    try {
      text = await fileOps.readText(skillPath);
    } catch {
      missing.push(role);
      continue;
    }
    if (text === expected[role]) continue;
    const header = parseManagedHeader(text);
    if (!header) {
      mismatched.push(`${role} (unmanaged content; setup backs it up before regenerating)`);
    } else if (header.version !== version) {
      mismatched.push(`${role} (version ${header.version}, expected ${version}; re-run setup)`);
    } else {
      mismatched.push(`${role} (differs from resolved config; re-run setup)`);
    }
  }

  if (missing.length === ROLES.length) {
    return [{
      severity: "SKIP",
      area: "config",
      title: "managed agent files",
      detail: `not installed in ${agentsDir}; run aria setup to generate the 11 managed files`,
    }];
  }
  const problems = [
    ...missing.map((role) => `${role} (missing)`),
    ...mismatched,
  ];
  if (problems.length > 0) {
    return [{
      severity: "FAIL",
      area: "config",
      title: "managed agent files",
      detail: problems.join("; "),
    }];
  }
  return [{
    severity: "PASS",
    area: "config",
    title: "managed agent files",
    detail: `11 of 11 match version ${version} and resolved config`,
  }];
}

// ---------------------------------------------------------------------------
// Wiki: packaged pipeline assets and optional WIKI_DIR accessibility
// ---------------------------------------------------------------------------

/** Packaged wiki-pipeline assets referenced by the archivist/package contract. */
const WIKI_PIPELINE_ASSETS = [
  "__init__.py",
  "run.py",
  "compiler.py",
  "search.py",
  "docs/instructions.md",
  "docs/compile-workflow.md",
] as const;

/**
 * Non-mutating Wiki checks: packaged pipeline assets must exist; WIKI_DIR
 * unset is SKIP, while a configured path that does not exist, is not a
 * directory, or lacks read/write accessibility is FAIL. No archival,
 * compilation, lint, installation, or other integration action is run.
 */
async function collectWikiFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const stat = fileOps.stat ?? ((path: string) => fsStat(path));
  const access = fileOps.access ?? ((path: string, mode: number) => fsAccess(path, mode));

  const missingAssets: string[] = [];
  for (const asset of WIKI_PIPELINE_ASSETS) {
    const assetPath = resolve(packageRoot, "wiki-pipeline", asset);
    try {
      const info = await stat(assetPath);
      if (!info.isFile()) missingAssets.push(`${asset} (not a file)`);
    } catch (error) {
      missingAssets.push(`${asset} (${describeError(error)})`);
    }
  }
  findings.push(missingAssets.length === 0
    ? {
        severity: "PASS",
        area: "wiki",
        title: "wiki pipeline assets",
        detail: `${WIKI_PIPELINE_ASSETS.length} of ${WIKI_PIPELINE_ASSETS.length} packaged assets present`,
      }
    : {
        severity: "FAIL",
        area: "wiki",
        title: "wiki pipeline assets",
        detail: `missing or invalid: ${missingAssets.join("; ")}`,
      });

  const wikiDir = process.env.WIKI_DIR;
  if (!wikiDir || wikiDir.trim().length === 0) {
    findings.push({
      severity: "SKIP",
      area: "wiki",
      title: "WIKI_DIR",
      detail: "unset; wiki archival/compile capability degraded",
    });
    return findings;
  }

  let info;
  try {
    info = await stat(wikiDir);
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} does not exist (${describeError(error)})`,
    });
    return findings;
  }
  if (!info.isDirectory()) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} is not a directory`,
    });
    return findings;
  }
  try {
    await access(wikiDir, fsConstants.R_OK | fsConstants.W_OK);
    findings.push({
      severity: "PASS",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} is an accessible directory (read/write)`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} lacks required read/write accessibility (${describeError(error)})`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Runner / formatter / exit code
// ---------------------------------------------------------------------------

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const worktree = options.worktree ?? process.cwd();
  const executor = options.executor ?? defaultExecutor;
  const discovery = options.discovery ?? ((worktreePath: string) => discoverAvailableModels(worktreePath));
  const fileOps = options.fileOps ?? defaultFileOps;
  const findings: DoctorFinding[] = [];

  // Package: version, defaults, prompts (independent of worktree config).
  findings.push(...await collectPackageFindings(getPackageRoot(), fileOps));

  // Config: resolved role routes (invalid global/project config is FAIL).
  let routes: ResolvedRoute[] | undefined;
  try {
    routes = deriveRoutes(worktree);
    findings.push({
      severity: "PASS",
      area: "config",
      title: "role route resolution",
      detail: `defaults, global, and project overrides applied for ${worktree}`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "config",
      title: "role route resolution",
      detail: describeError(error),
    });
  }

  // Effective cooperation depth: read-only `opencode debug config` probe of
  // the merged config's own top-level subagent_depth (advisory, never FAIL
  // and never authoritative: V2 list truth above owns setup verification).
  findings.push(subagentDepthFinding(await probeSubagentDepth(executor, worktree)));

  // Installed managed agent files match the current version + resolved
  // config (read-only; unrelated user agents never touched).
  findings.push(...await collectAgentFileFindings(worktree, options.agentsDir ?? defaultAgentsDir(), fileOps));

  // Model discovery (failure is FAIL; nothing is guessed).
  let discovered: ModelDiscovery | undefined;
  try {
    discovered = await discovery(worktree);
    findings.push({
      severity: "PASS",
      area: "routes/models",
      title: "model discovery",
      detail: `${discovered.models.length} model${discovered.models.length === 1 ? "" : "s"} reported`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "routes/models",
      title: "model discovery",
      detail: describeError(error),
    });
  }

  // Cross-check each resolved route against the discovered models.
  if (routes && discovered) {
    const byId = new Map(discovered.models.map((model) => [model.id, model]));
    for (const route of routes) findings.push(...routeFinding(route, byId));
  } else {
    findings.push({
      severity: "SKIP",
      area: "routes/models",
      title: "route/model validation",
      detail: "skipped because role route resolution or model discovery failed",
    });
  }

  // Compose the existing dependency doctor and derive the optional ZotPilot
  // MCP state from the same fresh `opencode mcp list` observation.
  let deps: DepsStatus | undefined;
  try {
    deps = await dependencyDoctor(executor);
    findings.push(...dependencyFindings(deps));
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "dependencies",
      title: "dependency probes",
      detail: describeError(error),
    });
  }
  findings.push(...zotPilotMcpFindings(deps));

  // Optional ZotPilot CLI availability/version (separate from MCP connectivity).
  findings.push(zotPilotCliFinding(await probeZotPilotCli(executor)));

  // T008 V2 runtime truth (primary for setup verification): plugin, agents,
  // skills, plan tool, coexistence, and session inventory from live lists.
  // Absent outside a live session (SKIP with documented gaps, never FAIL).
  findings.push(...collectRuntimeFindings(options.v2));

  // Packaged skills and canonical role/ZotPilot policy validation.
  findings.push(...await collectSkillFindings(getPackageRoot(), fileOps));
  findings.push(...rolePolicyFindings());

  // Wiki: packaged pipeline assets and optional WIKI_DIR accessibility.
  findings.push(...await collectWikiFindings(getPackageRoot(), fileOps));

  return { findings };
}

/**
 * Expanded-report exit code: exactly 0 when no finding is FAIL, otherwise 1.
 */
export function doctorExitCode(findings: readonly DoctorFinding[]): number {
  return findings.some((finding) => finding.severity === "FAIL") ? 1 : 0;
}

/** Compact plain-text rendering with literal PASS/WARN/FAIL/SKIP labels. */
export function formatDoctorReport(report: DoctorReport): string {
  const sections: Array<{ area: string; lines: string[] }> = [];
  let current: { area: string; lines: string[] } | undefined;
  for (const finding of report.findings) {
    if (!current || current.area !== finding.area) {
      current = { area: finding.area, lines: [] };
      sections.push(current);
    }
    current.lines.push(`  [${finding.severity}] ${finding.title}${finding.detail ? `: ${finding.detail}` : ""}`);
  }
  const body = sections
    .map((section) => [`${section.area}:`, ...section.lines].join("\n"))
    .join("\n\n");
  return `ARIA doctor\n\n${body}`;
}
