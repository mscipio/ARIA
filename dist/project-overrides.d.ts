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
/**
 * Parse one V2 `agents.<role>.model` value into an ARIA `{model, variant}`
 * pair. The pair is atomic: a model without a variant carries
 * `variant: undefined` so application clears any inherited variant.
 */
export declare function parseProjectModelValue(value: unknown, filePath?: string, path?: string): RoleOverride;
/**
 * Pure resolver: extract the ARIA-role model overlay from an already-parsed
 * project `opencode.json(c)` document. Unrelated top-level keys and unknown
 * agent IDs are ignored; `model` absent retains defaults.
 */
export declare function parseProjectAgentOverrides(raw: unknown, filePath?: string): ProjectModelOverlay;
/** Project config discovery: `opencode.json` preferred, `opencode.jsonc` fallback. */
export declare function projectAgentConfigPath(worktree: string): string | undefined;
/**
 * Validated read of the project model overlay, or `{}` when no project
 * `opencode.json(c)` exists. JSONC comments/trailing commas are tolerated
 * only for `.jsonc`, matching OpenCode's own discovery.
 */
export declare function readProjectAgentModelOverrides(worktree: string): ProjectModelOverlay;
/** Split an overlay `{model: "provider/model", variant?}` for runtime `agent.update`. */
export declare function toRuntimeModelRef(override: RoleOverride): {
    providerID: string;
    id: string;
    variant?: string;
};
/**
 * Pure overlay application: project models replace the resolved route as an
 * atomic pair (model-only clears the inherited variant). Absent roles retain
 * their resolved route; the input is never mutated and no files are written.
 */
export declare function applyProjectModelOverlay(resolved: ResolvedAriaConfig, overlay: ProjectModelOverlay): ResolvedAriaConfig;
/** Minimal editor surface needed for the narrow runtime patch. */
export interface ProjectModelAgentEditor {
    get(id: string): {
        model?: unknown;
    } | undefined;
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
export declare function applyProjectModelTransforms(editor: ProjectModelAgentEditor, overlay: ProjectModelOverlay): RoleName[];
//# sourceMappingURL=project-overrides.d.ts.map