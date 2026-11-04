import { type Executor } from "./deps.js";
import { type DelayFn, type ListConvergenceBound } from "./list-convergence.js";
/** npm package providing Quota. */
export declare const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
/** V2 server plugin ID registered by the Quota package. */
export declare const QUOTA_PLUGIN_ID = "@slkiser/opencode-quota.server";
/** Only this major is eligible for a managed Quota install or update. */
export declare const QUOTA_MAJOR = 6;
/** OpenCode release the Quota 6 plugin documents as its minimum. */
export declare const QUOTA_MIN_OPENCODE = "2.0.26";
/**
 * Node.js floor for Quota's terminal commands (`engines` of the published
 * package). ARIA declares Node >=20.19, so this is detected at runtime and
 * refused with an explanation, never assumed.
 */
export declare const QUOTA_MIN_NODE = "22.13.0";
/** Compare dotted numeric versions (`a.b.c`); negative when a < b. */
export declare function compareDotted(a: string, b: string): number;
/** Runtime gate: the Node.js on PATH must meet the Quota terminal-command floor. */
export declare function quotaNodeGate(executor: Executor): Promise<{
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
}>;
/** Runtime gate: the OpenCode release must meet Quota's documented minimum. */
export declare function quotaOpenCodeGate(executor: Executor): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
/**
 * Latest exact Quota release on npm, restricted to the supported major. Read
 * with `npm view <pkg> dist-tags --json` (no install, no registry write).
 */
export declare function discoverQuotaTarget(executor: Executor): Promise<{
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
}>;
/**
 * Observed Quota specs. The plugin list's SOURCE column is unversioned for
 * npm packages while its VERSION column is the runtime identity; an
 * unversioned package spec is therefore pinned to the listed version so the
 * runtime identity is positively used. A config spec pinned to a different
 * version stays distinct and fails closed as ambiguous.
 */
export declare function observedQuotaSpecs(listEntries: QuotaListEntry[] | null, configSpecs: string[]): {
    listSpecs: string[];
    configSpecs: string[];
};
/**
 * True when the text names exactly the Quota package (npm spec, plugin ID,
 * or config entry). A fork such as `@slkiser/opencode-quota-extra` does not
 * match: the character after the package name must end the name or start a
 * version/namespace suffix (`@`, `.`, `/`, `:`).
 */
export declare function mentionsQuotaPackage(text: unknown): boolean;
export type QuotaChannel = "npm" | "foreign";
export interface QuotaSpecInfo {
    /** Raw spec text as found (config entry or plugin-list SOURCE). */
    spec: string;
    /** `npm` for exactly the Quota package; `foreign` for quota-related names on another channel. */
    channel: QuotaChannel;
    /** Pinned version or tag when the npm spec carries one; null when bare. */
    version: string | null;
}
/**
 * Classify a plugin spec string. Returns null when the spec is not
 * quota-related at all (unrelated entries are ignored, never upgraded).
 * Quota-related names that are not plain npm specs for exactly this package
 * (Git specs, file paths, local directories, similarly named forks that
 * passed the caller pre-filter) report the `foreign` channel so the adapter
 * fails closed with `unsupported-ownership` instead of guessing.
 */
export declare function describeQuotaSpec(spec: string): QuotaSpecInfo | null;
/** Leading major of a dotted version; null when absent or unparseable. */
export declare function quotaMajor(version: string | null): number | null;
/** V2 `opencode plugin list` row that names the Quota package. */
export interface QuotaListEntry {
    id: string;
    version: string;
    /** SOURCE column: the installed target. */
    target: string;
}
/**
 * Extract quota rows from `opencode plugin list` output. Returns null when
 * the output shape is unrecognized (never guessed); an empty array when the
 * list is recognized and carries no quota rows.
 */
export declare function quotaEntriesFromPluginList(stdout: string): QuotaListEntry[] | null;
/** Quota plugin specs in the parsed global config (string/tuple/object forms). */
export declare function quotaSpecsFromConfig(parsed: unknown): string[];
export type QuotaIdentification = {
    kind: "absent";
} | {
    kind: "identified";
    spec: string;
    version: string;
} | {
    kind: "unknown-target";
    reason: string;
} | {
    kind: "unsupported-ownership";
    reason: string;
};
/**
 * Positively identify the installed Quota target from the union of
 * plugin-list SOURCE values and global-config specs. Exactly one distinct
 * exact-semver `5.x` npm spec identifies; anything else fails closed:
 * absent (nothing installed), unknown-target (ambiguous or not positively
 * versioned — never guessed), or unsupported-ownership (foreign channel or
 * a major this policy does not upgrade).
 */
export declare function identifyQuotaTarget(listSpecs: string[], configSpecs: string[]): QuotaIdentification;
export type QuotaCheckStatus = "skipped" | "unmanaged-observed" | "unknown-target" | "unsupported-ownership";
/**
 * T007 inventory semantics (existing vocabulary, no new statuses):
 * - `skipped` — informational: no Quota installation observed, nothing to do.
 * - `unmanaged-observed` — informational observation: a positively
 *   identified Quota 6 is present. This inventory never versions it;
 *   version action is owned exclusively by the gated `upgradeQuota` /
 *   bootstrap lifecycle below, never by `deps sync`.
 * - `unknown-target` — blocker/action-needed: the installed target is not
 *   positively identified (ambiguous sources, an unversioned spec, or a
 *   moving tag such as `@latest`). Fail-closed: no updater invocation and
 *   no mutation.
 * - `unsupported-ownership` — intentionally unmanaged: a foreign channel
 *   or a major outside the Quota 6 policy. Left untouched, never upgraded.
 */
export interface QuotaCheckResult {
    status: QuotaCheckStatus;
    installedSpec: string | null;
    installedVersion: string | null;
    detail: string;
}
/**
 * Strictly read-only Quota inventory for setup/sync reporting and the
 * future upgrade `--check` table: installed spec/version plus a status.
 * Never invokes the updater and never writes. Identified Quota 6 reports
 * `unmanaged-observed`: observed by this inventory while version action is
 * owned exclusively by the gated `upgradeQuota`/bootstrap lifecycle below,
 * and the legacy `deps sync` path performs no Quota installation or config
 * mutation. A moving tag such as `@latest` is never a positively
 * identified target: it reports `unknown-target` (fail-closed) and is
 * never upgraded, installed, or otherwise taken ownership of here.
 */
export declare function checkQuotaUpgrade(executor: Executor, configDir?: string): Promise<QuotaCheckResult>;
export type QuotaUpgradeStatus = "upgraded" | "already-current" | "unmanaged-observed" | "unknown-target" | "unsupported-ownership" | "skipped" | "update-failed" | "validation-failed";
export interface QuotaUpgradeResult {
    status: QuotaUpgradeStatus;
    installedSpec: string | null;
    installedVersion: string | null;
    /** Quota spec after a successful upgrade; null unless `upgraded`. */
    resultingSpec: string | null;
    detail: string;
    /** True only when the native apply ran (config may have changed). */
    mutated: boolean;
    /** True when a config snapshot was restored after a failure. */
    rolledBack?: boolean;
}
export interface QuotaUpgradeOptions {
    /**
     * Explicit global config dir. The native updater honors only the
     * env-derived global root (the Executor carries no env seam), so a
     * divergent explicit dir fails closed as unmanaged-observed. Omit in
     * production to use the effective global dir.
     */
    configDir?: string;
    /**
     * Bounded runtime plugin-list window (defaults to the shared 3
     * polls/100ms). Retries repeat `opencode plugin list` observation only,
     * never another `update --yes`.
     */
    convergence?: ListConvergenceBound;
    /** Injectable clock (defaults to real setTimeout; fakes record, never sleep). */
    delay?: DelayFn;
}
/**
 * Native Quota 6 update: `opencode plugin update @slkiser/opencode-quota`
 * (targeted; never the bare form, which updates every plugin). Preconditions:
 * supported OpenCode and Node runtimes, an exact identified Quota 6 install,
 * and a discovered target that is newer (never a downgrade). Afterwards the
 * persisted config must keep every unrelated plugin entry byte-for-byte and
 * the runtime list must converge on exactly one Quota entry at the target.
 */
export declare function upgradeQuota(executor: Executor, options?: QuotaUpgradeOptions): Promise<QuotaUpgradeResult>;
//# sourceMappingURL=quota.d.ts.map