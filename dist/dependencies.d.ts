import { type DependencyFileOps, type Executor } from "./deps.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";
/** Bootstrap-stack component names (ARIA self-upgrade is separate, T011). */
export declare const DEPENDENCY_COMPONENTS: readonly ["engram", "codegraph", "zotpilot", "quota", "context7"];
export type DependencyComponentName = (typeof DEPENDENCY_COMPONENTS)[number];
export type DependencyStatus = "completed" | "rolled-back" | "unresolved" | "skipped";
export interface DependencyOutcome {
    component: string;
    status: DependencyStatus;
    detail: string;
    mutated: boolean;
}
export interface DependencyLifecycleOptions {
    /** Explicit global config dir (XDG-contained; omits to the effective root). */
    configDir?: string;
    /** Explicit home dir for the ZotPilot user-scoped ownership check. */
    homeDir?: string;
    /** Filesystem seam for Engram channel detection + asset verification. */
    fileOps?: DependencyFileOps;
}
export interface DependencyLifecycleResult {
    ok: boolean;
    outcomes: DependencyOutcome[];
    report: string;
}
/**
 * Quota bootstrap lifecycle for the setup/upgrade shared path.
 *
 * - Absent (`checkQuotaUpgrade` skipped) → install-if-missing via the T016
 *   demonstrated-safe native `opencode plugin add <exact 5.x>` after `npm
 *   view` discovery (XDG-guarded, validated, snapshot rollback).
 * - Positively identified Quota 5 (`unmanaged-observed`) → gated native
 *   update via the T007 adapter (owned-outdated → update, current →
 *   normalize/validate as `already-current`).
 * - Ambiguous/unsupported (`unknown-target`/`unsupported-ownership`) →
 *   fail-closed report-only with zero mutation (never guessed).
 *
 * This supersedes T007's setup-exclusion wording ONLY for this bootstrap
 * path; `depsSync` keeps its exclusion unchanged (no Quota call there).
 */
export declare function ensureQuotaForLifecycle(executor: Executor, options?: {
    configDir?: string;
}): Promise<DependencyOutcome>;
/**
 * Context7 remote-only lifecycle (T009, reused without duplication).
 *
 * - Missing/wrong URL → normalize to the canonical
 *   `mcp.servers.context7 = { type: "remote", url }` entry (file-based,
 *   preserves unrelated servers/keys).
 * - Canonical → already-current (completed, no mutation).
 * - Conflicting/ambiguous/invalid → fail-closed report-only (skipped, zero
 *   mutation, never guessed). No local package is ever installed or upgraded
 *   on this path.
 */
export declare function ensureContext7ForLifecycle(executor: Executor, options?: {
    configDir?: string;
}): Promise<DependencyOutcome>;
/** Human-readable before/after-style report for the setup/upgrade lifecycle. */
export declare function formatDependenciesReport(outcomes: DependencyOutcome[]): string;
/**
 * Shared lifecycle: detect → discover latest upstream → install if missing
 * OR update if safely owned/outdated → normalize/configure → validate.
 *
 * Runs the five bootstrap-stack adapters directly (no ARIA self-upgrade,
 * no handoff, no version database). Each adapter owns its validation and
 * snapshot rollback; this orchestration serializes config mutations (like
 * `depsSync`) and continues through failures so the report carries every
 * component state (upgrade continuation instead stops on the first failure
 * with no global transactionality — see `continueUpgradeInNewRelease`).
 *
 * - Setup calls this directly on clean/existing OC2+ installs.
 * - Post-handoff upgrade calls the SAME adapters in update/normalize mode
 *   through the component seams below (plus `runUpgradeDependencies`).
 */
export declare function runSetupDependencies(executor: Executor, options?: DependencyLifecycleOptions): Promise<DependencyLifecycleResult>;
/**
 * Upgrade-mode entry for the already-current path and post-handoff docs.
 * The adapters already branch on missing vs outdated internally, so the
 * update/normalize/validate mode IS the same shared lifecycle (no separate
 * version-chasing path, no database).
 */
export declare function runUpgradeDependencies(executor: Executor, options?: DependencyLifecycleOptions): Promise<DependencyLifecycleResult>;
/**
 * Quota post-handoff seam: missing → install, owned-outdated → update,
 * current → completed, ambiguous → skipped. Maps lifecycle outcomes to
 * component states with no global transactionality.
 */
export declare function quotaLifecycleUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome>;
/**
 * Context7 post-handoff seam: remote-only normalize (no version upgrade).
 * Completed work stays completed; ambiguous stays skipped with zero
 * mutation.
 */
export declare function context7UpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome>;
//# sourceMappingURL=dependencies.d.ts.map