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
/**
 * Derive the installed Git spec for guidance from a positively identified
 * bare `X.Y.Z` version (e.g. `1.0.6` → `github:mscipio/ARIA#v1.0.6`).
 * Anything else (null, dev/inexact versions) yields null and guidance
 * fails closed without guessing.
 */
export declare function installedSpecForGuidance(currentVersion: string | null): string | null;
/**
 * Pure npm argv for an approval run against the installed release:
 * `exec --yes --package <spec> -- aria upgrade --yes`. The caller
 * prefixes `npm` (or `npx`) and the approved per-invocation
 * `NPM_CONFIG_ALLOW_GIT=all` env (see `PROCESS_LOCAL_GIT_ENV`, spread
 * per-call via the Executor `env` seam, never global/`.npmrc`); the `--`
 * boundary and `--package` position
 * are part of the contract verified by regression tests.
 */
export declare function buildExactUpgradeApprovalArgv(installedSpec: string): string[];
/** Display form of the exact-package approval invocation (pure). Includes the approved
 * per-invocation `NPM_CONFIG_ALLOW_GIT=all` prefix so the displayed command fetches the
 * exact Git spec without any global npm config or `.npmrc` change. */
export declare function formatExactUpgradeApprovalCommand(installedSpec: string): string;
/**
 * Approval guidance line for `formatUpgradeCheck` / `runUpgrade`
 * blocked-approval (pure, no mutation). Names the exact installed package
 * when it is positively identified; otherwise fails closed with no bare
 * invocation offered.
 */
export declare function formatApprovalGuidance(currentVersion: string | null, targetSpec: string): string;
/**
 * Blocked-approval detail for `runUpgrade` when `--yes` was not given
 * (pure, no mutation). Same exact-package rule as `formatApprovalGuidance`.
 */
export declare function formatBlockedApprovalDetail(currentVersion: string | null, targetSpec: string | null): string;
/** Component inventory scope bound by `--check`, approval, and handoff. */
export declare const UPGRADE_COMPONENTS: readonly ["aria", "engram", "context7", "codegraph", "zotpilot", "quota"];
export type UpgradeComponentName = (typeof UPGRADE_COMPONENTS)[number];
/**
 * Upgrade-action states for the `--check` Component|Installed|Available|
 * Status table (existing vocabulary; T007 semantic categories, no new
 * statuses):
 * - blockers (`unknown-target` on ARIA): the release target is not
 *   positively identified, so self-upgrade cannot run — zero mutation.
 * - action-needed (`upgrade-available`, plus non-ARIA `unknown-target`
 *   where fresh evidence would resolve the row): a newer ARIA target is
 *   positively identified and waits on explicit approval, or a component
 *   row needs fresh evidence before any action.
 * - informational (`current`, `remote-healthy`, `skipped`): nothing to
 *   upgrade — installed already equals the available target, a remote-only
 *   endpoint is configured and connected (no version concept), or nothing
 *   is installed.
 * - intentionally unmanaged/unobservable (`unmanaged-observed`,
 *   `unsupported-ownership`): observed but not version-managed by this
 *   check (user-managed per policy, version currency established
 *   post-handoff by the owning adapter), or positively identified on a
 *   channel this pipeline will not upgrade and leaves untouched.
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
    /**
     * Pin the installed ARIA version (test/operator override for the
     * read-only plugin-registration probe; `undefined` probes `opencode
     * plugin list` for the positively identified registration, `null`
     * forces unknown). This is the installed registration, never the
     * running CLI package version.
     */
    currentVersion?: string | null;
    /**
     * Pin the running CLI version (reporting only; `undefined` reads the
     * package). Never used for guidance, comparison, or mutation.
     */
    cliVersion?: string | null;
    /**
     * Pin the available target (`undefined` discovers via read-only
     * `git ls-remote`; `null` forces unknown for tests/operator override).
     */
    availableOverride?: AriaAvailableTarget | null;
}
export interface UpgradeCheckResult {
    /** Installed ARIA version from the positively identified plugin registration (null when unknown). */
    currentVersion: string | null;
    /** Running CLI package version (reporting only; never used for guidance or comparison). */
    cliVersion: string | null;
    /**
     * Positively identified installed spec for exact-package guidance
     * (e.g. `github:mscipio/ARIA#v1.0.7`; null when the registration is
     * not positively identified, so no invocation can be offered).
     */
    installedSpec: string | null;
    available: AriaTargetDiscovery;
    /** True when self-upgrade must not run (unknown target or version). */
    selfUpgradeBlocked: boolean;
    blockReason: string | null;
    components: UpgradeComponentRow[];
}
/** Installed ARIA version, or null when it cannot be positively read. */
export declare function readCurrentAriaVersion(): string | null;
/**
 * T009 installed ARIA identity: the positively identified OpenCode plugin
 * registration (approved Git source plus exact release tag), never the
 * running CLI package version. Guidance, version comparison, and
 * self-upgrade blocking all derive from this identity; the running CLI
 * version is reported separately and never compared.
 */
export interface InstalledAriaIdentity {
    /** Bare installed version (e.g. `1.0.7`), or null when not positively identified. */
    version: string | null;
    /** Exact installed spec (e.g. `github:mscipio/ARIA#v1.0.7`), or null when not positively identified. */
    spec: string | null;
    /** Provenance for read-only details (never guessed). */
    note: string;
}
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
/** Fully qualified Engram Homebrew formula the preflight and upgrade use. */
export declare const ENGRAM_HOMEBREW_FORMULA = "gentleman-programming/tap/engram";
/** Exact argv for the read-only preflight probe (never mutates). */
export declare function buildEngramPreflightArgv(): string[];
/** Display form of the preflight probe (for errors and reporting). */
export declare function formatEngramPreflightCommand(): string;
/**
 * Per-call environment addition for the preflight probe only. Returned as
 * additions for the Executor `env` seam (the executor merges over a copy of
 * `process.env` for that call); never assigned to `process.env` and never
 * persisted to any file.
 */
export declare function engramPreflightEnv(): NodeJS.ProcessEnv;
export type EngramPreflightResult = {
    ok: true;
    skipped: boolean;
} | {
    ok: false;
    reason: string;
};
/**
 * Formula-scoped prerequisite probe. Skips (ok, no probe) unless the
 * inventoried Engram row shows an installed version AND the install
 * positively resolves to the Homebrew-formula path. On the Homebrew path,
 * runs the exact read-only dry-run probe; any throw (failure or
 * indeterminate) blocks with an actionable error naming the formula, the
 * failed command, and the manual prerequisite. Never grants trust.
 */
export declare function checkEngramHomebrewPreflight(executor: Executor, check: UpgradeCheckResult): Promise<EngramPreflightResult>;
export interface UpgradeApproval {
    /** Explicit operator approval (`upgrade --yes` via the exact-package invocation). No other signal counts. */
    yes: boolean;
}
export type UpgradeRunStage = "already-current" | "blocked-approval" | "blocked-unknown-target" | "preflight-failed" | "self-upgrade-failed" | "handoff-taken";
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
/**
 * T010 already-current CLI/plugin identity gate (pure, no mutation).
 *
 * The already-current dependency path mutates (shared lifecycle) directly
 * under the running release with NO self-replacement/handoff, so the
 * running CLI must positively be the registered installation before the
 * seam runs. The CLI version is positively identified (`cliVersion`) and
 * must exactly equal the positively identified installed registration
 * (`currentVersion` + `installedSpec`); any unknown or differing identity
 * fails closed with zero mutation. The approved exact-target handoff path
 * (upgrade-available, below) is preserved: it remains allowed to replace
 * the positively identified registration with the exact validated target.
 */
export declare function checkAlreadyCurrentCliIdentity(check: UpgradeCheckResult): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
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
/**
 * T007 v1.0.14 post-handoff skills normalize phase (strict refresh).
 *
 * Runs ONLY in the new release as the `normalize` phase (before regen,
 * deps-sync, doctor). Refreshes a single stale positively owned packaged
 * entry (`node_modules/aria/skills`, e.g. the v1.0.7 npx cache) to the
 * current release location via the existing skills-only writer
 * (`ensureAriaSkillsRefreshFile` with backup/atomic/idempotence); current
 * is idempotent, unrelated entries and all other keys are preserved
 * byte-for-byte, ambiguous ownership (missing file/key, non-array, empty,
 * multiple owned, duplicate, non-string) fails closed as a failed phase
 * (`ok: false`, no write). Never deletes old caches; never rewrites
 * unrelated config. Nothing is thrown past the phase boundary.
 */
export declare function runAriaSkillsRefreshPhase(ctx: ComponentContext): Promise<PostUpgradePhaseOutcome>;
/**
 * T002 post-handoff managed-agent regen phase (strict reconciliation).
 *
 * Runs ONLY in the new release after registration/normalization and before
 * deps-sync/doctor (phase order owned by `continueUpgradeInNewRelease` below:
 * normalize → regen → deps-sync → doctor). Uses the strict
 * `reconcileManagedAgents` wrapper (T001: packaged defaults plus the
 * supported global overlay via `resolveSetupAriaConfig`, fail-closed on
 * unowned/ambiguous role paths, unrelated files untouched) — never the
 * tolerant standalone-setup `installAgentFiles` (preserved in
 * `src/lifecycle.ts`). Reconciliation conflicts return a failed phase
 * (`ok: false`) so the continuation stops as `phase-stopped` with the
 * actionable conflict detail; nothing is thrown past the phase boundary.
 */
export declare function runManagedAgentRegenPhase(ctx: ComponentContext): Promise<PostUpgradePhaseOutcome>;
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
/**
 * Validate an explicit `--migrate-from` spec (pure, no mutation): exactly
 * the approved Git namespace plus an exact `vX.Y.Z` release tag. Anything
 * else fails closed (never guessed, never a branch, moving tag, or short
 * SHA).
 */
export declare function parseMigrateFromSpec(spec: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Derive the migrate (to) target from the running release's own packaged
 * version (package.json, never the installed row). Null, dev, or inexact
 * versions fail closed: a release that cannot name its own target cannot
 * own a transition.
 */
export declare function ownReleaseTarget(ownVersion: string | null): {
    ok: true;
    target: AriaAvailableTarget;
} | {
    ok: false;
    reason: string;
};
/**
 * Pure npm argv for an approved migrate run: the NEWER (to) release is
 * selected via `--package`, the installed (from) registration via
 * `--migrate-from`. The caller prefixes `npm` (or `npx`) and the approved
 * per-invocation `NPM_CONFIG_ALLOW_GIT=all` env (process-local, never
 * global/`.npmrc`); the `--` boundary keeps the `aria ...` argv from being
 * parsed as npm options.
 */
export declare function buildMigrateApprovalArgv(fromSpec: string, toSpec: string): string[];
/** Display form of the exact newer-CLI migrate invocation (pure). */
export declare function formatMigrateApprovalCommand(fromSpec: string, toSpec: string): string;
/**
 * Blocked-approval detail for `runMigrateUpgrade` when `--yes` was not
 * given (pure, no mutation). Names the exact newer-CLI invocation when the
 * (to) target is positively identified; otherwise fails closed with no
 * invocation offered.
 */
export declare function formatMigrateBlockedDetail(fromSpec: string, toSpec: string | null): string;
export type MigrateRunStage = "blocked-approval" | "blocked-migrate" | "preflight-failed" | "migrate-failed" | "drift-blocked" | "component-stopped" | "phase-stopped" | "complete";
export interface MigrateRunResult {
    stage: MigrateRunStage;
    ok: boolean;
    check: UpgradeCheckResult;
    /** The newer release's own (to) target (absent when it was never positively identified). */
    ownTarget?: AriaAvailableTarget;
    handoff?: UpgradeHandoff;
    selfUpgrade?: SelfUpgradeOutcome;
    continuation?: UpgradeContinuationResult;
    /** Continuation before/after report (empty unless the post-handoff pipeline ran). */
    report: string;
    detail: string;
}
/** Newer-CLI-owned transition seam (the `aria upgrade` CLI wires the real adapter). */
export type MigrateFn = (fromSpec: string, target: AriaAvailableTarget, handoff: UpgradeHandoff) => Promise<SelfUpgradeOutcome>;
/** Default migrate seam: fail closed (the adapter owns the transition). */
export declare function defaultMigrate(): Promise<SelfUpgradeOutcome>;
export interface MigrateRunOptions extends UpgradeCheckOptions {
    /** Exact installed spec the newer release must replace (operator-approved `--migrate-from`). */
    migrateFrom: string;
    approval: UpgradeApproval;
    /**
     * Pin the running release's packaged version (test/operator override;
     * `undefined` reads package.json, `null` forces unknown). Never the
     * installed row.
     */
    ownVersion?: string | null;
    /** Newer-CLI-owned transition (default: fail closed). */
    migrateFn?: MigrateFn;
    /** Post-handoff pipeline seams (defaults: the real shared lifecycle). */
    continuation?: UpgradeContinuationOptions;
}
/**
 * Newer-CLI migrate pipeline: read-only inventory → explicit approval →
 * validate `--migrate-from` plus the own (to) target from package.json →
 * require the installed registration to exactly equal `--migrate-from` →
 * newer-CLI-owned remove→add→persisted-verify→bounded-list-converge
 * transition (never the old release's mutation logic: no from-release
 * spawn) → in-process post-handoff continuation in the new release.
 */
export declare function runMigrateUpgrade(executor: Executor | undefined, options: MigrateRunOptions): Promise<MigrateRunResult>;
export declare function formatMigrateResult(result: MigrateRunResult): string;
/** CLI exit code: 0 only when the migrate transition plus continuation completed. */
export declare function migrateExitCode(result: MigrateRunResult): number;
//# sourceMappingURL=upgrade.d.ts.map