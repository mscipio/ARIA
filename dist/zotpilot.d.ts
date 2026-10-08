import { type Executor } from "./deps.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";
/** Demonstrated-safe missing-install evidence owning this adapter's install path (T016). */
export declare const ZOTPILOT_BOOTSTRAP_EVIDENCE: import("./bootstrap.js").BootstrapEvidence | undefined;
/** Read-only classification of the local ZotPilot registration surface. */
export type ZotpilotRegistration = "absent" | "v2" | "legacy" | "conflicting" | "ambiguous" | "unparseable";
export interface ZotpilotState {
    found: boolean;
    version: string | null;
    registration: ZotpilotRegistration;
    /** Single config path the registration was read from (undefined when missing/ambiguous). */
    path?: string;
}
/** Install provenance: `user-scoped` ONLY with positive home-contained evidence. */
export type ZotpilotOwnership = "user-scoped" | "shared" | "unknown";
export type ZotpilotLifecycleStatus = "installed" | "updated" | "already-current" | "report-only" | "install-failed" | "update-failed" | "validation-failed";
export interface ZotpilotLifecycleResult {
    status: ZotpilotLifecycleStatus;
    /** Version observed before any mutation (null when absent/unknown). */
    installedVersion: string | null;
    /** Version observed after a successful install/update (null unless installed/updated). */
    resultingVersion: string | null;
    /** Latest upstream release from read-only `pip index` discovery (null when undiscovered). */
    availableVersion: string | null;
    detail: string;
    /** True only when a mutating command ran or a config file was written. */
    mutated: boolean;
    /** True when a config snapshot was restored after a failure. */
    rolledBack?: boolean;
    mcpConnected: boolean;
    ownership: ZotpilotOwnership;
}
export interface ZotpilotLifecycleOptions {
    /** Explicit global config dir (XDG-contained; omits to the effective root). */
    configDir?: string;
    /** Explicit home dir for the user-scoped ownership check (defaults to the invoking user's home). */
    homeDir?: string;
}
/**
 * Positive user-scoped ownership predicate (pure, testable): `user-scoped`
 * ONLY when the `pip show` `Location:` resolves inside the invoking user's
 * home AND carries no shared/conda marker. Shared markers win over the home
 * prefix (a conda env inside the home directory is still a shared env per
 * T006). Anything else is `shared` (positively not user-scoped); probe
 * failures are `unknown` (see `detectZotpilotOwnership`).
 */
export declare function classifyZotpilotOwnership(location: string, homeDir: string): Exclude<ZotpilotOwnership, "unknown">;
/**
 * Read-only ownership probe: `python3 -m pip show zotpilot` `Location:`.
 * `unknown` when the probe fails or no `Location:` is positively parsed
 * (never guessed). Never mutates (no `pip install`, no `zotpilot`/`conda`
 * mutating subcommand).
 */
export declare function detectZotpilotOwnership(executor: Executor, homeDir?: string): Promise<{
    ownership: ZotpilotOwnership;
    location: string | null;
}>;
/**
 * Read-only installed-state probe: binary presence/version via
 * `zotpilot --version` plus the V2/legacy registration surface. Never
 * mutates (no pip/zotpilot mutating command, no file write, no ownership
 * probe — ownership is established only on the update-eligible branch).
 */
export declare function detectZotpilotState(executor: Executor, configDir?: string): Promise<ZotpilotState>;
/**
 * Shared lifecycle: install-if-missing on a clean system via the
 * demonstrated-safe ARIA-controlled path (delegated to the T016 bootstrap
 * mechanism: exact pip `==` spec, user-scoped install, ARIA file-based V2
 * registration, validation with config-snapshot rollback); update-if-outdated
 * ONLY with established user-scoped ownership plus a positively identified
 * newer exact release (user-scoped `pip install --user`, V2 preserved
 * byte-exact, validated); every other installation stays report-only with
 * zero mutation. Mutating `zotpilot` subcommands, `conda` mutations, bare
 * `pip install` without `--user`, and legacy `mcp.zotpilot` writes are never
 * invoked on any path.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `zotpilotUpgradeComponent`); it takes no handoff
 * payload and performs no ARIA self-replacement. ZotPilot's own config
 * (`~/.config/zotpilot/config.json`, API secrets) and ChromaDB state are
 * never ARIA-managed.
 */
export declare function ensureZotpilot(executor: Executor, options?: ZotpilotLifecycleOptions): Promise<ZotpilotLifecycleResult>;
/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.zotpilot` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — ZotPilot releases
 * are discovered at runtime (never a version database).
 */
export declare function zotpilotUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome>;
//# sourceMappingURL=zotpilot.d.ts.map