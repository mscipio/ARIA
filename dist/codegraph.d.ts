import { type Executor } from "./deps.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";
/** Demonstrated-safe missing-install evidence owning this adapter's install path (T016). */
export declare const CODEGRAPH_BOOTSTRAP_EVIDENCE: import("./bootstrap.js").BootstrapEvidence | undefined;
/** Read-only classification of the local CodeGraph registration surface. */
export type CodegraphRegistration = "absent" | "v2" | "legacy" | "conflicting" | "ambiguous" | "unparseable";
export interface CodegraphState {
    found: boolean;
    version: string | null;
    registration: CodegraphRegistration;
    /** Single config path the registration was read from (undefined when missing/ambiguous). */
    path?: string;
}
export type CodegraphLifecycleStatus = "installed" | "report-only" | "install-failed" | "validation-failed";
export interface CodegraphLifecycleResult {
    status: CodegraphLifecycleStatus;
    /** Version observed before any mutation (null when absent/unknown). */
    installedVersion: string | null;
    /** Version observed after a successful install (null unless installed). */
    resultingVersion: string | null;
    /** Latest upstream release from read-only `npm view` discovery (null when undiscovered). */
    availableVersion: string | null;
    detail: string;
    /** True only when a mutating command ran or a config file was written. */
    mutated: boolean;
    /** True when a config snapshot was restored after a failure. */
    rolledBack?: boolean;
    mcpConnected: boolean;
}
export interface CodegraphLifecycleOptions {
    /** Explicit global config dir (XDG-contained; omits to the effective root). */
    configDir?: string;
}
/**
 * Read-only installed-state probe: binary presence/version via
 * `codegraph --version` plus the V2/legacy registration surface. Never
 * mutates (no npm/codegraph mutating command, no file write).
 */
export declare function detectCodegraphState(executor: Executor, configDir?: string): Promise<CodegraphState>;
/**
 * Shared lifecycle: install-if-missing on a clean system via the
 * demonstrated-safe ARIA-controlled path (delegated to the T016 bootstrap
 * mechanism: exact npm spec, binary-only install, ARIA file-based V2
 * registration, validation + rollback); every existing, ambiguous, or
 * otherwise unidentifiable installation stays report-only with zero
 * mutation. The upstream `codegraph install --target` legacy writer is never
 * invoked on any path.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `codegraphUpgradeComponent`); it takes no handoff
 * payload and performs no ARIA self-replacement.
 */
export declare function ensureCodegraph(executor: Executor, options?: CodegraphLifecycleOptions): Promise<CodegraphLifecycleResult>;
/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.codegraph` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — CodeGraph releases
 * are discovered at runtime (never a version database).
 */
export declare function codegraphUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome>;
//# sourceMappingURL=codegraph.d.ts.map