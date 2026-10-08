import { type DependencyLifecycleResult } from "./dependencies.js";
import { type Executor } from "./deps.js";
/** Git remote ARIA releases are discovered from (read-only `ls-remote`). */
export declare const ARIA_GIT_REMOTE = "https://github.com/mscipio/ARIA.git";
/** Exact Git package spec prefix for ARIA releases (T011 validates identity). */
export declare const ARIA_GIT_SPEC_PREFIX = "github:mscipio/ARIA#";
/**
 * Git environment for any upgrade-owned subprocess. Spread per-call only
 * (e.g. `{ ...process.env, ...PROCESS_LOCAL_GIT_ENV }` at the spawn site);
 * never assign to `process.env` and never persist to any file.
 */
export declare const PROCESS_LOCAL_GIT_ENV: {
    readonly NPM_CONFIG_ALLOW_GIT: "all";
};
/** Component inventory scope bound by `--check`, approval, and handoff. */
export declare const UPGRADE_COMPONENTS: readonly ["aria", "engram", "context7", "codegraph", "zotpilot", "quota"];
export type UpgradeComponentName = (typeof UPGRADE_COMPONENTS)[number];
/**
 * Upgrade-action states for the `--check` Component|Installed|Available|
 * Status table:
 * - `current`: installed equals the positively identified available target.
 * - `upgrade-available`: a newer available target is positively identified.
 * - `remote-healthy`: remote-only endpoint configured and connected (no
 *   version concept; nothing to upgrade).
 * - `unmanaged-observed`: observed but not version-managed by this check
 *   (user-managed per policy, or currency established post-handoff).
 * - `unsupported-ownership`: positively identified on a channel this
 *   pipeline will not upgrade (left untouched).
 * - `skipped`: absent (nothing to upgrade).
 * - `unknown-target`: installed or available not positively identified;
 *   for ARIA this blocks self-upgrade with zero mutation.
 */
export type UpgradeComponentStatus = "current" | "upgrade-available" | "remote-healthy" | "unmanaged-observed" | "unsupported-ownership" | "skipped" | "unknown-target";
export interface UpgradeComponentRow {
    component: UpgradeComponentName;
    installed: string | null;
    available: string | null;
    status: UpgradeComponentStatus;
    detail: string;
}
/** Positively identified ARIA release target (exact Git identity). */
export interface AriaAvailableTarget {
    /** Release tag, e.g. `v1.0.7`. */
    tag: string;
    /** Bare version, e.g. `1.0.7`. */
    version: string;
    /** Exact install spec, e.g. `github:mscipio/ARIA#v1.0.7`. */
    spec: string;
}
export type AriaTargetDiscovery = {
    kind: "known";
    target: AriaAvailableTarget;
} | {
    kind: "unknown";
    reason: string;
};
export interface UpgradeCheckOptions {
    /** Explicit global config dir (XDG-contained; defaults via env). */
    configDir?: string;
    /** Pin the installed version (`undefined` reads the package). */
    currentVersion?: string | null;
    /**
     * Pin the available target (`undefined` discovers via read-only
     * `git ls-remote`; `null` forces unknown for tests/operator override).
     */
    availableOverride?: AriaAvailableTarget | null;
}
export interface UpgradeCheckResult {
    currentVersion: string | null;
    available: AriaTargetDiscovery;
    /** True when self-upgrade must not run (unknown target or version). */
    selfUpgradeBlocked: boolean;
    blockReason: string | null;
    components: UpgradeComponentRow[];
}
/** Installed ARIA version, or null when it cannot be positively read. */
export declare function readCurrentAriaVersion(): string | null;
/**
 * Exact `vX.Y.Z` release-tag predicate. Single source of truth shared by
 * release discovery/validation (T010) and the self-upgrade adapter (T011);
 * never duplicated.
 */
export declare function isExactReleaseTag(tag: string): boolean;
/**
 * Parse read-only `git ls-remote` output into the newest exact `vX.Y.Z`
 * release tag. Dereferenced `^{[1]}` lines, non-tag refs, and non-exact
 * tags (prereleases, moving tags) never identify a target. Returns null
 * when no exact release tag is observed (never guessed).
 *
 * [1]: `^{}` suffix lines repeat the tag's object; the suffix is stripped
 * before matching, so annotated and lightweight tags behave identically.
 */
export declare function parseAriaRemoteRefs(lsRemoteOutput: string): AriaAvailableTarget | null;
/** Read-only available-release probe (`git ls-remote`; never mutates). */
export declare function discoverAvailableAriaTarget(executor?: Executor): Promise<AriaTargetDiscovery>;
/**
 * Pre-removal gate: the requested target must be positively identified and
 * exactly shaped BEFORE the current registration is touched. Unknown or
 * misshapen targets fail closed with zero mutation.
 */
export declare function validateAriaTargetForRemoval(target: AriaAvailableTarget | null): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Strictly read-only inventory: current AND available ARIA releases plus
 * one row per component. Probes are `git ls-remote`, `opencode plugin
 * list`, `opencode mcp list`, `engram version`, `codegraph --version`,
 * and XDG-contained config file reads — no installer, updater, writer,
 * or mutating CLI is ever invoked here.
 */
export declare function checkUpgradeInventory(executor?: Executor, options?: UpgradeCheckOptions): Promise<UpgradeCheckResult>;
export declare function formatUpgradeCheck(result: UpgradeCheckResult): string;
export interface UpgradeApproval {
    /** Explicit operator approval (`aria upgrade --yes`). No other signal counts. */
    yes: boolean;
}
export type UpgradeRunStage = "already-current" | "blocked-approval" | "blocked-unknown-target" | "self-upgrade-failed" | "handoff-taken";
export interface SelfUpgradeOutcome {
    ok: boolean;
    detail: string;
    /** New-release entry note for reporting (set on success). */
    handoffNote?: string;
    /** Registration restoration state on failure (reported, T011-owned). */
    registration?: string;
}
export type SelfUpgradeFn = (target: AriaAvailableTarget, handoff: UpgradeHandoff) => Promise<SelfUpgradeOutcome>;
/**
 * Default self-upgrade seam: fail closed. T011 owns exact-ref
 * remove/replace/re-register plus the one-shot handoff spawn; until it
 * lands, approval never causes a mutation here.
 */
export declare function defaultSelfUpgrade(): Promise<SelfUpgradeOutcome>;
export interface UpgradeRunOptions extends UpgradeCheckOptions {
    approval: UpgradeApproval;
    selfUpgradeFn?: SelfUpgradeFn;
    /**
     * Shared dependency lifecycle for the already-current path (T017). When
     * ARIA is already current and approval is present, the approved dependency
     * updates run directly under the current release with NO
     * self-replacement/handoff. The `aria upgrade` CLI always provides the
     * real `runUpgradeDependencies`; omitted preserves the pre-T017
     * zero-mutation already-current report for existing callers/tests.
     */
    dependenciesFn?: UpgradeAlreadyCurrentDependenciesFn;
}
/**
 * Already-current dependencies seam signature (shared lifecycle result).
 */
export type UpgradeAlreadyCurrentDependenciesFn = (executor: Executor, configDir?: string) => Promise<DependencyLifecycleResult>;
export interface UpgradeRunResult {
    stage: UpgradeRunStage;
    ok: boolean;
    check: UpgradeCheckResult;
    handoff?: UpgradeHandoff;
    selfUpgrade?: SelfUpgradeOutcome;
    /**
     * Approved dependency outcomes for the already-current path (T017).
     * Present only when a `dependenciesFn` ran; absent otherwise (including
     * every handoff/blocked path, which never runs dependencies in the old
     * release).
     */
    dependencies?: {
        outcomes: ComponentUpgradeOutcome[];
        report: string;
    };
    detail: string;
}
/**
 * Old-release upgrade pipeline: inventory → explicit approval → validate
 * the ARIA target BEFORE removal → T011 self-upgrade + bounded handoff.
 * On handoff success this function returns WITHOUT running any further
 * normalization, regen, sync, doctor, or reporting — the new release owns
 * the remainder via `continueUpgradeInNewRelease`.
 */
export declare function runUpgrade(executor: Executor | undefined, options: UpgradeRunOptions): Promise<UpgradeRunResult>;
export declare function formatUpgradeResult(result: UpgradeRunResult): string;
/** CLI exit code: 0 only for already-current or a taken handoff. */
export declare function upgradeExitCode(result: UpgradeRunResult): number;
export interface UpgradeHandoff {
    kind: "aria-upgrade-handoff";
    handoffVersion: 1;
    /** Exact validated ARIA target the new release must install. */
    target: AriaAvailableTarget;
    /** Exact approved component scope (names from `UPGRADE_COMPONENTS`). */
    approvedComponents: string[];
    /** Before-inventory for the before/after report. */
    before: UpgradeCheckResult;
}
/** Bind the exact validated target plus the approved inventory scope. */
export declare function buildUpgradeHandoff(target: AriaAvailableTarget, check: UpgradeCheckResult): UpgradeHandoff;
/**
 * New-release gate: continue without re-asking ONLY on an exact match of
 * the validated target spec plus the approved component scope. Any
 * target/scope drift stops for fresh approval with zero mutation.
 */
export declare function isHandoffMatch(handoff: UpgradeHandoff, actualTarget: AriaAvailableTarget, actualComponents: readonly string[]): {
    match: true;
} | {
    match: false;
    reason: string;
};
export type ComponentUpgradeStatus = "completed" | "rolled-back" | "unresolved" | "skipped";
export interface ComponentUpgradeOutcome {
    component: string;
    status: ComponentUpgradeStatus;
    detail: string;
    mutated: boolean;
}
export interface ComponentContext {
    target: AriaAvailableTarget;
    executor: Executor;
    configDir?: string;
}
export type ComponentUpgradeFn = (ctx: ComponentContext) => Promise<ComponentUpgradeOutcome>;
export interface PostUpgradePhaseOutcome {
    ok: boolean;
    detail: string;
    mutated: boolean;
}
export type PostUpgradePhaseFn = (ctx: ComponentContext) => Promise<PostUpgradePhaseOutcome>;
export interface UpgradeContinuationOptions {
    configDir?: string;
    executor?: Executor;
    /** Per-component upgrades (defaults: real shared lifecycle T012–T014 + T017 Quota/Context7). */
    components?: Partial<Record<UpgradeComponentName, ComponentUpgradeFn>>;
    /** Target-version normalization/registration (default: report-only). */
    normalizeFn?: PostUpgradePhaseFn;
    /** Agent regen when required (default: report-only). */
    regenFn?: PostUpgradePhaseFn;
    /** Deps sync (default: real `depsSync`). */
    depsSyncFn?: PostUpgradePhaseFn;
    /** Doctor (default: real `runDoctor`). */
    doctorFn?: PostUpgradePhaseFn;
}
export type ContinuationStage = "complete" | "drift-blocked" | "component-stopped" | "phase-stopped";
export interface UpgradeContinuationResult {
    stage: ContinuationStage;
    ok: boolean;
    outcomes: ComponentUpgradeOutcome[];
    /** Before/after report (empty when drift-blocked before any work). */
    report: string;
    detail: string;
}
/**
 * Continue an approved upgrade ONLY in the new release. The handoff match
 * is checked before any mutation; component failures stop the pipeline
 * with per-component states and no global transactionality (completed work
 * stays, unattempted work reports `skipped`).
 */
export declare function continueUpgradeInNewRelease(handoff: UpgradeHandoff, actualTarget: AriaAvailableTarget, actualComponents: readonly string[], options?: UpgradeContinuationOptions): Promise<UpgradeContinuationResult>;
/** Before/after report: the bound before-inventory plus per-component after states. */
export declare function formatUpgradeReport(before: UpgradeCheckResult, outcomes: ComponentUpgradeOutcome[], extra?: {
    phase?: string;
}): string;
/**
 * The one sync-vs-upgrade definition: `deps sync` normalizes CURRENT
 * installs (idempotent, unapproved, Quota excluded); `aria upgrade` moves
 * to a NEW release through inventory, explicit approval, pre-removal
 * validation, self-upgrade plus a bounded handoff, and new-release-only
 * completion with a before/after report.
 */
export declare function describeSyncVsUpgrade(): {
    sync: {
        normalizeCurrent: true;
        idempotent: true;
        approvalRequired: false;
        quotaExcluded: true;
        phases: string[];
    };
    upgrade: {
        approvalRequired: true;
        phases: string[];
    };
};
//# sourceMappingURL=upgrade.d.ts.map