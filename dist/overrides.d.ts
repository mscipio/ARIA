import type { AriaPluginOptions, AriaProjectOverrides, ResolvedAriaConfig } from "./types.js";
declare class ConfigValidationError extends Error {
    constructor(filePath: string, path: string, got: unknown, want: string);
}
export declare function parseOverrides(raw: unknown, filePath?: string): AriaProjectOverrides;
/**
 * Canonical global config path: ~/.config/opencode/aria.json first, with the
 * pre-ARIA legacy filename as a read-only fallback. Returns undefined when
 * neither file exists.
 */
export declare function globalAriaConfigPath(): string | undefined;
/**
 * Validated read of the global overrides, or {} when no global config exists.
 */
export declare function readGlobalAriaOverrides(): AriaProjectOverrides;
/**
 * Validated read of the project-local overrides, or {} when no project config
 * exists. Shared by `resolveAriaConfig` and model configuration so both agree
 * on which project fields are pinned.
 *
 * Path discovery: an explicit `options.configPath` wins; otherwise prefer
 * `aria.json` and fall back to the legacy filename.
 */
export declare function readProjectAriaOverrides(worktree: string, options?: AriaPluginOptions): AriaProjectOverrides;
export declare function resolveAriaConfig(worktree: string, options?: AriaPluginOptions, metaUrl?: string): ResolvedAriaConfig;
export { ConfigValidationError };
//# sourceMappingURL=overrides.d.ts.map