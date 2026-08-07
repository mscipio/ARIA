import type { ReviewDrivenCodePluginOptions, ReviewDrivenCodeProjectOverrides, ResolvedReviewDrivenCodeConfig } from "./types.js";
declare class ConfigValidationError extends Error {
    constructor(path: string, got: unknown, want: string);
}
export declare function parseOverrides(raw: unknown): ReviewDrivenCodeProjectOverrides;
export declare function resolveReviewDrivenCodeConfig(worktree: string, options?: ReviewDrivenCodePluginOptions, metaUrl?: string): ResolvedReviewDrivenCodeConfig;
export { ConfigValidationError };
//# sourceMappingURL=overrides.d.ts.map