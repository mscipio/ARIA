import type { AriaPluginOptions, AriaProjectOverrides, ResolvedAriaConfig } from "./types.js";
declare class ConfigValidationError extends Error {
    constructor(filePath: string, path: string, got: unknown, want: string);
}
export declare function parseOverrides(raw: unknown, filePath?: string): AriaProjectOverrides;
export declare function resolveAriaConfig(worktree: string, options?: AriaPluginOptions, metaUrl?: string): ResolvedAriaConfig;
export { ConfigValidationError };
//# sourceMappingURL=overrides.d.ts.map