import { type Executor } from "./deps.js";
export interface BootstrapEvidence {
    component: "engram" | "codegraph" | "zotpilot" | "quota";
    /** `install` = demonstrated-safe missing-install path below; `report-only` = documented fallback. */
    missingPath: "install" | "report-only";
    /** Normal upstream-discovery mechanism (never a version database). */
    discovery: string;
    /** Exact mutating commands the missing-install path runs (probes excluded). */
    installCommands: string[];
    /** Why the missing-install path is safe on a clean system. */
    safety: string;
    /** Existing-install gate (unchanged by T016). */
    existingGate: string;
    /** Explicitly prohibited (never invoked by the missing-install path). */
    prohibitions: string[];
}
export declare const BOOTSTRAP_EVIDENCE: BootstrapEvidence[];
export type BootstrapInstallStatus = "installed" | "already-present" | "report-only" | "install-failed" | "validation-failed";
export interface BootstrapInstallResult {
    status: BootstrapInstallStatus;
    installedVersion: string | null;
    detail: string;
    /** True only when a mutating command ran or a config file was written. */
    mutated: boolean;
    /** True when a config snapshot was restored after a failure. */
    rolledBack?: boolean;
}
export declare const CODEGRAPH_NPM_PACKAGE = "@colbymchenry/codegraph";
export declare const CODEGRAPH_MCP_COMMAND: string[];
/** Discover current CodeGraph upstream via npm's normal mechanism (no database). */
export declare function discoverCodegraphLatest(executor: Executor): Promise<{
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
}>;
export declare function installCodegraphIfMissing(executor: Executor, configDir?: string): Promise<BootstrapInstallResult>;
export declare const ZOTPILOT_PIP_PACKAGE = "zotpilot";
export declare const ZOTPILOT_MCP_COMMAND: string[];
/** Discover current ZotPilot upstream via pip's normal mechanism (no database). */
export declare function discoverZotpilotLatest(executor: Executor): Promise<{
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
}>;
export declare function installZotpilotIfMissing(executor: Executor, configDir?: string): Promise<BootstrapInstallResult>;
/** Discover current Quota upstream via npm's normal mechanism (no database). Only exact Quota 5 proceeds. */
export declare function discoverQuotaLatest(executor: Executor): Promise<{
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
}>;
export interface QuotaInstallOptions {
    /**
     * Explicit global config dir. The native `opencode plugin add` honors only
     * the env-derived global root (the Executor carries no env seam), so a
     * divergent explicit dir fails closed as report-only (same XDG guard as the
     * T007 upgrade adapter). Omit in production to use the effective root.
     */
    configDir?: string;
}
export declare function installQuotaIfMissing(executor: Executor, options?: QuotaInstallOptions): Promise<BootstrapInstallResult>;
//# sourceMappingURL=bootstrap.d.ts.map