import type { AriaPluginOptions, AriaProjectOverrides, ResolvedAriaConfig, RoleDefaults, RoleName, RoleOverride } from "./types.js";
export declare const ROLES: RoleName[];
/** Canonical role for a configured `roles` key (canonical name or legacy alias). */
export declare function roleForConfigKey(key: string): RoleName | undefined;
declare class ConfigValidationError extends Error {
    constructor(filePath: string, path: string, got: unknown, want: string);
}
export declare function parseOverrides(raw: unknown, filePath?: string): AriaProjectOverrides;
/**
 * Canonical global config path: `$XDG_CONFIG_HOME/opencode/aria.json` (else
 * `~/.config/opencode/aria.json`) first, with the pre-ARIA legacy filename
 * as a read-only fallback. Returns undefined when neither file exists.
 */
export declare function globalAriaConfigPath(explicit?: string): string | undefined;
/**
 * Validated read of the global overrides, or {} when no global config exists.
 */
export declare function readGlobalAriaOverrides(explicit?: string): AriaProjectOverrides;
/**
 * Validated read of the project-local overrides, or {} when no project config
 * exists. Shared by `resolveAriaConfig` and model configuration so both agree
 * on which project fields are pinned.
 *
 * Path discovery: an explicit `options.configPath` wins; otherwise prefer
 * `aria.json` and fall back to the legacy filename. `options.skipProject`
 * (T008) returns {} without touching the filesystem, for global-only
 * resolution.
 */
export declare function readProjectAriaOverrides(worktree: string, options?: AriaPluginOptions): AriaProjectOverrides;
/**
 * Model-aware resolution of the model/variant pair across override layers
 * (lowest to highest). The pair is owned by the highest layer that specifies
 * `model`: that layer's variant is used when supplied, otherwise the inherited
 * variant is cleared, so a model-only override never keeps a stale variant.
 * A layer that specifies only `variant` inherits the lower model and replaces
 * just the variant.
 */
export declare function resolveRoleRoute(defaults: RoleDefaults, ...layers: (RoleOverride | undefined)[]): {
    model: string;
    variant: string | undefined;
};
export declare function resolveAriaConfig(worktree: string, options?: AriaPluginOptions, metaUrl?: string): ResolvedAriaConfig;
export { ConfigValidationError };
//# sourceMappingURL=overrides.d.ts.map