import { type Executor } from "./deps.js";
/** npm package providing Quota. */
export declare const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
/** V2 server plugin ID registered by the Quota package. */
export declare const QUOTA_PLUGIN_ID = "@slkiser/opencode-quota.server";
/** Only this major is eligible for a managed Quota upgrade. */
export declare const QUOTA_MAJOR = 5;
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
export interface QuotaCheckResult {
    status: QuotaCheckStatus;
    installedSpec: string | null;
    installedVersion: string | null;
    detail: string;
}
/**
 * Strictly read-only Quota inventory for setup/sync reporting and the
 * future upgrade `--check` table: installed spec/version plus a status.
 * Never invokes the updater and never writes. Identified Quota 5 reports
 * `unmanaged-observed` — observed and user-managed, with setup and sync
 * performing no Quota installation or config mutation.
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
}
/**
 * Gated Quota 5 upgrade for `aria upgrade` (T010 wires this; setup and sync
 * never call it). Inventory first: the installed target must be positively
 * identified as Quota 5. Safety second: OpenCode must be major 2 (on major 1
 * the native updater would pin Quota to `@4`, a downgrade) and the native
 * `opencode-quota update --dry-run` preview must exit cleanly. Only then
 * `opencode-quota update --yes` applies, followed by validation that the
 * TUI and server surfaces survived (plugin list still carries the quota
 * plugin exactly once; the global config still carries a quota entry with
 * unrelated entries preserved). Validation failure rolls the snapshotted
 * global config back where feasible.
 */
export declare function upgradeQuota(executor: Executor, options?: QuotaUpgradeOptions): Promise<QuotaUpgradeResult>;
//# sourceMappingURL=quota.d.ts.map