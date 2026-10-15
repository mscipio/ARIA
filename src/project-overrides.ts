import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripJsoncComments } from "./deps.js";
import { getPackageRoot } from "./defaults.js";
import { ConfigValidationError, ROLES } from "./overrides.js";
import { getArchivistScopedPermissions } from "./permissions.js";
import type { ResolvedAriaConfig, RoleName, RoleOverride } from "./types.js";

/**
 * T005 — Project model overlays from project `opencode.json(c)`.
 *
 * Authority for project-level model selection is the OpenCode-native
 * `agents.<role>.model` field in the project `opencode.json` / `opencode.jsonc`
 * (worktree root, `.json` preferred). The V2 selection is either the short
 * string `provider/model[#variant]` or the explicit object
 * `{providerID, model, variant?}` (`@opencode/schema@2.0.23`
 * `ConfigModel.Selection`). Anything else stops with a validation error —
 * unsupported V2 model schemas are never silently coerced.
 *
 * Pair semantics mirror `resolveRoleRoute` in `src/overrides.ts`: the overlay
 * owns the model+variant pair atomically. A model without a variant clears
 * the inherited variant; there is no variant-only project field. Absent
 * `agents` / absent `model` retains the resolved defaults. Unknown agent IDs
 * (user agents) are ignored; only the eleven canonical ARIA roles overlay.
 *
 * Runtime application is a narrow post-load patch (`agent.update` for
 * model/variant only). Nothing here regenerates or writes global agent files;
 * `defaults/aria.defaults.json` + override machinery remains the single
 * canonical role source.
 */

export type ProjectModelOverlay = Partial<Record<RoleName, RoleOverride>>;

const ROLE_SET = new Set<string>(ROLES);

// V2 `ConfigModel.Selection` short form: `provider/model[#variant]`.
const SHORT_SELECTION_RE = /^[^/#]+\/[^#]+(?:#[^#]+)?$/;
const PROVIDER_ID_RE = /^[^/#]+$/;
const MODEL_ID_RE = /^[^#]+$/;
const VARIANT_ID_RE = /^[^#]+$/;

const MODEL_OBJECT_FIELDS = new Set(["providerID", "model", "variant"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(filePath: string, path: string, got: unknown, want: string): never {
  throw new ConfigValidationError(filePath, path, got, want);
}

/**
 * Parse one V2 `agents.<role>.model` value into an ARIA `{model, variant}`
 * pair. The pair is atomic: a model without a variant carries
 * `variant: undefined` so application clears any inherited variant.
 */
export function parseProjectModelValue(
  value: unknown,
  filePath = "opencode.json",
  path = "agents.<role>.model",
): RoleOverride {
  if (typeof value === "string") {
    if (!SHORT_SELECTION_RE.test(value)) {
      fail(filePath, path, value, 'V2 model selection string "provider/model[#variant]"');
    }
    const providerEnd = value.indexOf("/");
    const variantStart = value.indexOf("#", providerEnd + 1);
    const providerID = value.slice(0, providerEnd);
    const id = value.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
    const variant = variantStart === -1 ? undefined : value.slice(variantStart + 1);
    if (!providerID || !id || (variant !== undefined && !variant)) {
      fail(filePath, path, value, 'V2 model selection string "provider/model[#variant]"');
    }
    const model = variantStart === -1 ? value : value.slice(0, variantStart);
    return variant === undefined ? { model } : { model, variant };
  }
  if (isObject(value)) {
    for (const field of Object.keys(value)) {
      if (!MODEL_OBJECT_FIELDS.has(field)) {
        fail(filePath, `${path}.${field}`, field, "'providerID', 'model', or 'variant'");
      }
    }
    const { providerID, model, variant } = value as {
      providerID?: unknown;
      model?: unknown;
      variant?: unknown;
    };
    if (typeof providerID !== "string" || !PROVIDER_ID_RE.test(providerID)) {
      fail(filePath, `${path}.providerID`, providerID, "non-empty providerID without '/' or '#'");
    }
    if (typeof model !== "string" || !MODEL_ID_RE.test(model)) {
      fail(filePath, `${path}.model`, model, "non-empty model without '#'");
    }
    if (variant !== undefined && (typeof variant !== "string" || !VARIANT_ID_RE.test(variant))) {
      fail(filePath, `${path}.variant`, variant, "non-empty variant without '#'");
    }
    const combined = `${providerID as string}/${model as string}`;
    return variant === undefined
      ? { model: combined }
      : { model: combined, variant: variant as string };
  }
  fail(filePath, path, value, 'V2 model selection (string "provider/model[#variant]" or {providerID, model, variant})');
}

/**
 * Pure resolver: extract the ARIA-role model overlay from an already-parsed
 * project `opencode.json(c)` document. Unrelated top-level keys and unknown
 * agent IDs are ignored; `model` absent retains defaults.
 */
export function parseProjectAgentOverrides(
  raw: unknown,
  filePath = "opencode.json",
): ProjectModelOverlay {
  if (!isObject(raw)) fail(filePath, "(root)", raw, "object");
  const agents = (raw as Record<string, unknown>).agents;
  if (agents === undefined) return {};
  if (!isObject(agents)) fail(filePath, "agents", agents, "object");
  const overlay: ProjectModelOverlay = {};
  for (const [agentId, entry] of Object.entries(agents)) {
    if (!ROLE_SET.has(agentId)) continue;
    const role = agentId as RoleName;
    if (!isObject(entry)) fail(filePath, `agents.${agentId}`, entry, "object");
    if (!("model" in entry) || entry.model === undefined) continue;
    overlay[role] = parseProjectModelValue(entry.model, filePath, `agents.${agentId}.model`);
  }
  return overlay;
}

function parseJSON(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`${filePath}: ${error.message}`);
    }
    throw error;
  }
}

/** Project config discovery: `opencode.json` preferred, `opencode.jsonc` fallback. */
export function projectAgentConfigPath(worktree: string): string | undefined {
  const jsonPath = join(worktree, "opencode.json");
  if (existsSync(jsonPath)) return jsonPath;
  const jsoncPath = join(worktree, "opencode.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  return undefined;
}

/**
 * Validated read of the project model overlay, or `{}` when no project
 * `opencode.json(c)` exists. JSONC comments/trailing commas are tolerated
 * only for `.jsonc`, matching OpenCode's own discovery.
 */
export function readProjectAgentModelOverrides(worktree: string): ProjectModelOverlay {
  const configPath = projectAgentConfigPath(worktree);
  if (!configPath) return {};
  const rawText = readFileSync(configPath, "utf8");
  const text = configPath.endsWith(".jsonc") ? stripJsoncComments(rawText) : rawText;
  return parseProjectAgentOverrides(parseJSON(text, configPath), configPath);
}

/** Split an overlay `{model: "provider/model", variant?}` for runtime `agent.update`. */
export function toRuntimeModelRef(override: RoleOverride): {
  providerID: string;
  id: string;
  variant?: string;
} {
  const providerEnd = override.model?.indexOf("/") ?? -1;
  const providerID = override.model?.slice(0, providerEnd) ?? "";
  const id = override.model?.slice(providerEnd + 1) ?? "";
  return override.variant === undefined
    ? { providerID, id }
    : { providerID, id, variant: override.variant };
}

/**
 * Pure overlay application: project models replace the resolved route as an
 * atomic pair (model-only clears the inherited variant). Absent roles retain
 * their resolved route; the input is never mutated and no files are written.
 */
export function applyProjectModelOverlay(
  resolved: ResolvedAriaConfig,
  overlay: ProjectModelOverlay,
): ResolvedAriaConfig {
  const roles = Object.fromEntries(
    ROLES.map((role) => {
      const base = resolved.roles[role];
      const override = overlay[role];
      if (!override) return [role, base];
      return [role, { ...base, model: override.model ?? base.model, variant: override.variant }];
    }),
  ) as ResolvedAriaConfig["roles"];
  return { roles };
}

/** Minimal editor surface needed for the narrow runtime patch. */
export interface ProjectModelAgentEditor {
  get(id: string): { model?: unknown } | undefined;
  update(id: string, update: (agent: Record<string, unknown>) => void): void;
}

/**
 * Narrow runtime patch: `agent.update` for model/variant only, and only for
 * roles present in the overlay whose agent exists. Roles without an overlay
 * are never touched; missing agents are skipped (never materialized here —
 * managed files remain the creation mechanism).
 *
 * @returns roles whose model was patched, in canonical role order.
 */
export function applyProjectModelTransforms(
  editor: ProjectModelAgentEditor,
  overlay: ProjectModelOverlay,
): RoleName[] {
  const patched: RoleName[] = [];
  for (const role of ROLES) {
    const override = overlay[role];
    if (!override) continue;
    if (!editor.get(role)) continue;
    const ref = toRuntimeModelRef(override);
    const next: Record<string, unknown> = { providerID: ref.providerID, id: ref.id };
    if (ref.variant !== undefined) next.variant = ref.variant;
    editor.update(role, (agent) => {
      agent["model"] = next;
    });
    patched.push(role);
  }
  return patched;
}

/**
 * T006 v1.0.14 — location-independent canonical archivist with runtime binding.
 *
 * Canonical managed files retain `{{packageRoot}}` / `{{WIKI_DIR}}`
 * placeholders so the same version+config is byte-identical from any install
 * root (npx cache, checkout, extracted package). This narrow runtime patch
 * resolves those placeholders in-memory via the existing `agent.transform`
 * path: `system` placeholders become the live package root + `WIKI_DIR`
 * (empty string when unset, matching the archivist prompt's stop-and-explain
 * contract), and `permissions` expand to the scoped archivist Rule[] only
 * when `WIKI_DIR` is set — otherwise the deny-by-default base from the
 * managed file is left untouched. Only `archivist` is ever touched; a missing
 * archivist agent is skipped (never materialized); no files are written.
 */
export function resolveArchivistRuntimeSystem(
  system: string,
  options: { packageRoot?: string; wikiDir?: string } = {},
): string {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const wikiDir = options.wikiDir ?? process.env.WIKI_DIR ?? "";
  return system
    .replaceAll("{{packageRoot}}", packageRoot)
    .replaceAll("{{WIKI_DIR}}", wikiDir);
}

/** Minimal editor surface needed for the narrow archivist runtime patch. */
export interface ArchivistRuntimeAgentEditor {
  get(id: string): { system?: unknown; permissions?: unknown } | undefined;
  update(id: string, update: (agent: Record<string, unknown>) => void): void;
}

/**
 * Narrow runtime patch for the archivist only. Returns true when the
 * archivist agent was patched (system and/or permissions), false when there
 * was nothing to do (missing agent, already resolved, or no WIKI_DIR for
 * permissions). Unrelated agents are never touched.
 */
export function applyArchivistRuntimeTransform(
  editor: ArchivistRuntimeAgentEditor,
  worktree: string,
  options: { packageRoot?: string; wikiDir?: string } = {},
): boolean {
  const current = editor.get("archivist");
  if (!current) return false;
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const wikiDir = options.wikiDir ?? process.env.WIKI_DIR ?? "";
  const originalSystem = current.system;
  const resolvedSystem = typeof originalSystem === "string"
    ? resolveArchivistRuntimeSystem(originalSystem, { packageRoot, wikiDir })
    : undefined;
  const needsSystem = resolvedSystem !== undefined && resolvedSystem !== originalSystem;
  // Scoped permissions only when WIKI_DIR is configured; otherwise the
  // deny-by-default base from the managed file stays (safe).
  const needsPermissions = wikiDir.trim().length > 0;
  if (!needsSystem && !needsPermissions) return false;
  const scoped = needsPermissions ? getArchivistScopedPermissions(worktree) : undefined;
  editor.update("archivist", (agent) => {
    if (needsSystem) agent["system"] = resolvedSystem;
    if (scoped) agent["permissions"] = scoped;
  });
  return true;
}
