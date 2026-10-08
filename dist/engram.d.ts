import { type DependencyFileOps, type Executor } from "./deps.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";
/** Demonstrated-safe missing-install evidence owning this adapter's path (T016). */
export declare const ENGRAM_BOOTSTRAP_EVIDENCE: import("./bootstrap.js").BootstrapEvidence | undefined;
/** Install channel as detected (`github` updates take the GitHub asset path). */
export type EngramChannel = "homebrew" | "unknown" | "missing";
export type EngramLifecycleStatus = "installed" | "upgraded" | "already-current" | "report-only" | "install-failed" | "update-failed" | "setup-failed" | "validation-failed";
export interface EngramLifecycleResult {
    status: EngramLifecycleStatus;
    /** Version observed before any mutation (null when absent/unknown). */
    installedVersion: string | null;
    /** Version observed after a successful mutation (null unless installed/upgraded/current). */
    resultingVersion: string | null;
    channel: EngramChannel;
    detail: string;
    /** True only when a mutating command ran or a config file changed. */
    mutated: boolean;
    /** True when a config snapshot was restored after a failure. */
    rolledBack?: boolean;
    mcpConnected: boolean;
    statuslineAbsent: boolean;
}
export interface EngramLifecycleOptions {
    /** Explicit global config dir (XDG-contained; omits to the effective root). */
    configDir?: string;
    /** Filesystem seam for channel detection + GitHub-asset verification. */
    fileOps?: DependencyFileOps;
}
export interface EngramState {
    found: boolean;
    version: string | null;
    channel: EngramChannel;
}
/**
 * Read-only installed-state probe: version via `engram version` plus the
 * install channel via Homebrew-cellar ownership. `unknown` covers every
 * non-Homebrew existing install and takes the checksum-verified GitHub asset
 * path on update (per T016); `missing` means no binary was found. Never
 * mutates.
 */
export declare function detectEngramState(executor: Executor, fileOps?: DependencyFileOps): Promise<EngramState>;
/**
 * Shared lifecycle: install-if-missing OR update-if-outdated via the
 * detected channel, then normalize (`engram setup opencode` + T005 cleanup)
 * and validate version + MCP connectivity.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `engramUpgradeComponent`); it takes no handoff payload
 * and performs no ARIA self-replacement.
 */
export declare function ensureEngram(executor: Executor, options?: EngramLifecycleOptions): Promise<EngramLifecycleResult>;
/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.engram` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — Engram versions are
 * discovered at runtime (never a version database).
 */
export declare function engramUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome>;
//# sourceMappingURL=engram.d.ts.map