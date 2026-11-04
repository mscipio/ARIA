import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadDefaultConfig } from "./defaults.js";
import { regenerateManagedAgents } from "./model-config.js";
import {
  ROLES,
  globalAriaConfigPath,
  parseOverrides,
  readGlobalAriaOverrides,
  readProjectAriaOverrides,
  roleForConfigKey,
} from "./overrides.js";
import { openCodeGlobalDir } from "./paths.js";
import {
  SCOPES,
  applyPending,
  normalizePending,
  resolveEffective,
  sameEntry,
  type AssignmentSource,
  type ConfigScope,
  type PendingChanges,
  type RoleEntries,
  type ScopedEntries,
} from "./model-manager-state.js";
import type { AriaDefaults, RoleName, RoleOverride } from "./types.js";

// ---------------------------------------------------------------------------
// Snapshot: the layers as they exist on disk, plus where each scope writes.
// ---------------------------------------------------------------------------

export interface ScopePaths {
  /** File written when this scope changes (`aria.json`). */
  target: string;
  /** File currently supplying the scope's overrides, if any (aria.json or legacy). */
  source: string | undefined;
}

export interface ModelManagerSnapshot {
  worktree: string;
  defaults: AriaDefaults;
  saved: ScopedEntries;
  paths: Record<ConfigScope, ScopePaths>;
}

function projectSourcePath(worktree: string): string | undefined {
  const aria = join(worktree, "aria.json");
  if (existsSync(aria)) return aria;
  const legacy = join(worktree, "review-driven-code.json");
  return existsSync(legacy) ? legacy : undefined;
}

/**
 * Load the defaults and both override layers. Throws on malformed config so
 * the caller can stop before presenting or writing anything.
 *
 * Legacy `review-driven-code.json` files are read as fallbacks. The first save
 * of such a scope writes canonical `aria.json`, seeded from the effective
 * legacy layer, so effective routes are preserved; the legacy file itself is
 * never modified.
 */
export function loadModelManagerSnapshot(worktree: string, options: { globalDir?: string } = {}): ModelManagerSnapshot {
  const defaults = loadDefaultConfig();
  const globalOverrides = readGlobalAriaOverrides(options.globalDir);
  const projectOverrides = readProjectAriaOverrides(worktree);
  return {
    worktree,
    defaults,
    saved: {
      global: { ...(globalOverrides.roles ?? {}) },
      project: { ...(projectOverrides.roles ?? {}) },
    },
    paths: {
      global: {
        target: join(openCodeGlobalDir(options.globalDir), "aria.json"),
        source: globalAriaConfigPath(options.globalDir),
      },
      project: {
        target: join(worktree, "aria.json"),
        source: projectSourcePath(worktree),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only table (`aria models --show`)
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<AssignmentSource, string> = {
  default: "default",
  global: "global",
  project: "project",
};

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

/** Read-only table of effective assignments, variants, and configuration sources. */
export function formatModelAssignments(snapshot: ModelManagerSnapshot): string {
  const routes = resolveEffective(snapshot.defaults, snapshot.saved);
  const rows = routes.map((route) => ({
    role: route.role,
    model: route.model,
    variant: route.variant ?? "-",
    source: SOURCE_LABEL[route.source],
  }));
  const modelWidth = Math.max("model".length, ...rows.map((row) => row.model.length));
  const variantWidth = Math.max("variant".length, ...rows.map((row) => row.variant.length));
  const roleWidth = Math.max("role".length, ...rows.map((row) => row.role.length));
  const fileLine = (label: string, scope: ConfigScope): string => {
    const { source, target } = snapshot.paths[scope];
    return `  ${pad(label, 8)} ${source ?? `(none; writes to ${target})`}`;
  };
  const lines = [
    "ARIA model assignments (read-only; no changes made)",
    "",
    "Configuration sources:",
    fileLine("global", "global"),
    fileLine("project", "project"),
    "",
    `${pad("role", roleWidth)}  ${pad("model", modelWidth)}  ${pad("variant", variantWidth)}  source`,
    ...rows.map((row) => `${pad(row.role, roleWidth)}  ${pad(row.model, modelWidth)}  ${pad(row.variant, variantWidth)}  ${row.source}`),
    "",
    "source: default = packaged ARIA default, global = global aria.json, project = project aria.json (overrides global).",
    "Run `aria models` in a terminal to change assignments.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Atomic persistence
// ---------------------------------------------------------------------------

export type PersistOutcome =
  | { status: "unchanged"; message: string }
  | {
      status: "saved";
      message: string;
      changed: Record<ConfigScope, RoleName[]>;
      regenerated: boolean;
      warning?: string;
    }
  | { status: "failed"; error: string };

export interface PersistOptions {
  /** Managed-agent regeneration after a global change (defaults to the existing regeneration). */
  regenerate?: (worktree: string) => Promise<{ legacyArchitectWarning?: string } | void>;
}

interface WritePlan {
  scope: ConfigScope;
  target: string;
  original: string | undefined;
  serialized: string;
  tempPath: string;
  changed: RoleName[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild the `roles` object: unchanged keys (including legacy aliases) keep
 * their exact original values, while every changed role drops its old keys and
 * receives its new canonical entry (if any).
 */
function mergeRoles(raw: unknown, next: RoleEntries, changed: RoleName[]): Record<string, RoleOverride> {
  const changedSet = new Set<RoleName>(changed);
  const out: Record<string, RoleOverride> = {};
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const role = roleForConfigKey(key);
      if (role !== undefined && changedSet.has(role)) continue;
      out[key] = value as RoleOverride;
    }
  }
  for (const role of changed) {
    const entry = next[role];
    if (entry && (entry.model !== undefined || entry.variant !== undefined)) {
      const value: RoleOverride = {};
      if (entry.model !== undefined) value.model = entry.model;
      if (entry.variant !== undefined) value.variant = entry.variant;
      out[role] = value;
    }
  }
  return out;
}

async function buildPlan(
  scope: ConfigScope,
  target: string,
  next: RoleEntries,
  changed: RoleName[],
): Promise<WritePlan> {
  const original = existsSync(target) ? await readFile(target, "utf8") : undefined;
  let raw: Record<string, unknown> = {};
  if (original !== undefined) {
    const parsed: unknown = JSON.parse(original);
    if (!isPlainObject(parsed)) throw new Error(`${target}: expected a JSON object`);
    raw = parsed;
  }
  const document = { ...raw, roles: mergeRoles(raw.roles, next, changed) };
  // Validate exactly what will be persisted, before anything is written.
  parseOverrides(document, target);
  return {
    scope,
    target,
    original,
    serialized: `${JSON.stringify(document, null, 2)}\n`,
    tempPath: `${target}.${process.pid}.${randomUUID()}.tmp`,
    changed,
  };
}

async function writeTemp(plan: WritePlan): Promise<void> {
  await mkdir(dirname(plan.target), { recursive: true });
  await writeFile(plan.tempPath, plan.serialized, { encoding: "utf8", flag: "wx" });
}

async function restore(plan: WritePlan): Promise<void> {
  if (plan.original === undefined) {
    await unlink(plan.target).catch(() => undefined);
    return;
  }
  await writeFile(plan.tempPath, plan.original, { encoding: "utf8", flag: "w" });
  await rename(plan.tempPath, plan.target);
}

async function discardTemps(plans: WritePlan[]): Promise<void> {
  await Promise.all(plans.map((plan) => unlink(plan.tempPath).catch(() => undefined)));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist pending edits atomically. Only the `aria.json` of a scope with real
 * changes is rewritten; unrelated keys, unrelated roles, and legacy alias keys
 * are preserved. Global changes regenerate managed agents from the new global
 * layer; if regeneration fails, both files are restored to their prior bytes.
 */
export async function persistAssignments(
  snapshot: ModelManagerSnapshot,
  pending: PendingChanges,
  options: PersistOptions = {},
): Promise<PersistOutcome> {
  const normalized = normalizePending(snapshot.saved, pending);
  const next = applyPending(snapshot.saved, normalized);

  let plans: WritePlan[];
  try {
    plans = [];
    for (const scope of SCOPES) {
      const changed = ROLES.filter((role) => !sameEntry(snapshot.saved[scope][role], next[scope][role]));
      if (changed.length === 0) continue;
      plans.push(await buildPlan(scope, snapshot.paths[scope].target, next[scope], changed));
    }
  } catch (error) {
    return { status: "failed", error: `could not prepare configuration: ${describeError(error)}. Nothing was written.` };
  }
  if (plans.length === 0) {
    return { status: "unchanged", message: "Selections match the saved assignments; nothing was written." };
  }

  const committed: WritePlan[] = [];
  try {
    for (const plan of plans) await writeTemp(plan);
    for (const plan of plans) {
      await rename(plan.tempPath, plan.target);
      committed.push(plan);
    }
  } catch (error) {
    await rollbackPlans(committed);
    await discardTemps(plans);
    return { status: "failed", error: `could not write configuration: ${describeError(error)}. Previous files were restored.` };
  }
  await discardTemps(plans);

  const globalPlan = plans.find((plan) => plan.scope === "global");
  let regenerated = false;
  let warning: string | undefined;
  if (globalPlan) {
    const regenerate = options.regenerate ?? regenerateManagedAgents;
    try {
      const installed = await regenerate(snapshot.worktree);
      regenerated = true;
      warning = installed?.legacyArchitectWarning;
    } catch (error) {
      await rollbackPlans(committed);
      return {
        status: "failed",
        error: `managed agents could not be regenerated (${describeError(error)}); configuration was restored and nothing changed.`,
      };
    }
  }

  const changed: Record<ConfigScope, RoleName[]> = {
    global: plans.find((plan) => plan.scope === "global")?.changed ?? [],
    project: plans.find((plan) => plan.scope === "project")?.changed ?? [],
  };
  return { status: "saved", message: summarize(changed, regenerated, normalized), changed, regenerated, warning };
}

async function rollbackPlans(committed: WritePlan[]): Promise<void> {
  for (const plan of [...committed].reverse()) {
    await restore(plan).catch(() => undefined);
  }
}

function summarize(changed: Record<ConfigScope, RoleName[]>, regenerated: boolean, normalized: PendingChanges): string {
  const parts: string[] = [];
  if (changed.global.length > 0) parts.push(`global: ${changed.global.join(", ")}`);
  if (changed.project.length > 0) parts.push(`project: ${changed.project.join(", ")}`);
  const edits = Object.values(normalized).reduce((count, scope) => count + Object.keys(scope).length, 0);
  const head = `Saved ${edits} change${edits === 1 ? "" : "s"} (${parts.join("; ")}).`;
  const agents = regenerated
    ? " Managed agents were regenerated from the new global assignments."
    : "";
  return `${head}${agents} Restart OpenCode sessions to load the new assignments.`;
}
