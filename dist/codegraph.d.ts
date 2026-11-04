import { type Executor } from "./deps.js";
import type { DelayFn, ListConvergenceBound } from "./list-convergence.js";
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
    /**
     * Bounded runtime MCP-list window (defaults to the shared 3 polls/100ms).
     * Retries repeat read-only probes only, never another `npm install`.
     */
    convergence?: ListConvergenceBound;
    /** Injectable clock (defaults to real setTimeout; fakes record, never sleep). */
    delay?: DelayFn;
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
export declare const CODEGRAPH_NPM_PACKAGE = "@colbymchenry/codegraph";
/** Latest release reported by `codegraph upgrade --check` (read-only), or null. */
export declare function parseCodegraphLatest(output: string): string | null;
/**
 * Provenance: the active `codegraph` binary resolves into the npm global
 * prefix's CodeGraph package. Anything else (npx, local checkout, unknown)
 * is not eligible for the provider update.
 */
export declare function codegraphProvenance(executor: Executor): Promise<{
    npmGlobal: boolean;
    path: string | null;
    detail: string;
}>;
/** Read-only provider state: installed version, provenance, and the upstream latest. */
export declare function codegraphProviderState(executor: Executor): Promise<{
    installed: string | null;
    latest: string | null;
    npmGlobal: boolean;
    detail: string;
}>;
export type CodegraphExternalUpgradeStatus = "completed" | "skipped" | "unresolved";
/**
 * Apply the upstream `codegraph upgrade <target>` for an npm-global install.
 * Verification: the installed binary must report exactly the target. The
 * upstream update is not reversible by ARIA, so a failed verification is
 * reported as unresolved with the observed version, never claimed as rolled back.
 */
export declare function upgradeCodegraphExternal(executor: Executor, target: string): Promise<{
    status: CodegraphExternalUpgradeStatus;
    mutated: boolean;
    detail: string;
}>;
//# sourceMappingURL=codegraph.d.ts.map