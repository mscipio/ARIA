import { ROLES } from "./overrides.js";
import type { AgentRule } from "./permissions.js";
import type { ResolvedAriaConfig, ResolvedRoleConfig, RoleName } from "./types.js";
export { ROLES };
export type { AgentRule };
/** V2 model selector: `provider/model` with an optional `#variant`. */
export declare function formatAgentModel(model: string, variant: string | undefined): string;
export declare function agentFileChecksum(description: string, model: string, mode: string, permissions: readonly AgentRule[], body: string): string;
/**
 * Render one deterministic managed agent file. The body is the resolved
 * system prompt verbatim (exactly one trailing newline); frontmatter carries
 * the `agents.<id>` fields plus ARIA ownership comments (comments, never
 * fields, so the V2 schema surface is untouched).
 */
export declare function generateAgentFile(role: RoleName, resolved: ResolvedRoleConfig, version: string): string;
/** Render all eleven managed agent files in canonical role order. */
export declare function generateAgentFiles(resolved: ResolvedAriaConfig, version: string): Record<RoleName, string>;
export declare function agentFileName(role: RoleName): string;
/** Global V2 agent location (`$XDG_CONFIG_HOME/opencode/agents/` or `~/.config/opencode/agents/`). */
export declare function defaultAgentsDir(explicit?: string): string;
export declare function readPackageVersion(metaUrl?: string): string;
export interface ManagedHeader {
    version: string;
    checksum: string;
}
/** Ownership probe: a file we generated carries the managed marker + version + checksum. */
export declare function parseManagedHeader(content: string): ManagedHeader | null;
export declare function isAriaManaged(content: string): boolean;
export interface AgentInstallResult {
    dir: string;
    version: string;
    /** Roles whose file was created or regenerated. */
    written: RoleName[];
    /** Roles whose managed file was already byte-identical (no write). */
    unchanged: RoleName[];
    /** Roles whose managed file was hand-edited after generation (still regenerated). */
    tampered: RoleName[];
    /** Unmanaged pre-existing files moved aside before generation, by role. */
    backups: Partial<Record<RoleName, string>>;
    /**
     * Prior managed contents replaced by this install, by role.
     *
     * Present only when a managed file already existed with different bytes
     * (version upgrade or tampered regeneration). Absence means the file was
     * newly created. Rollback restores these bytes verbatim; it never deletes
     * a replaced managed file.
     */
    previousContents: Partial<Record<RoleName, string>>;
}
/**
 * Partial install state carried on a thrown `installAgentFiles` error so
 * callers (T008 lifecycle) can roll back accumulated agent changes. The
 * install itself already attempts a best-effort rollback before throwing;
 * the partial is exposed for a defensive second pass.
 */
export interface AgentInstallPartialError extends Error {
    partialResult?: AgentInstallResult;
}
/**
 * Install (or regenerate) the eleven managed agent files.
 *
 * Safe regeneration: byte-identical managed files are left untouched;
 * managed files are regenerated in place with their prior bytes retained on
 * the result for rollback; pre-existing files WITHOUT the ownership marker
 * are never overwritten — they are moved to
 * `<role>.md.aria-backup-<stamp>` first so user agents survive with a
 * rollback path. Files with unrelated names are never touched.
 *
 * Atomicity (T008): a mid-install throw rolls back accumulated changes
 * before throwing (including a backup-moved-before-failed-replacement for
 * the current role) and exposes the partial result on the thrown error as
 * `partialResult` for a defensive caller rollback.
 */
export declare function installAgentFiles(resolved: ResolvedAriaConfig, options?: {
    dir?: string;
    version?: string;
}): Promise<AgentInstallResult>;
/**
 * Roll back one `installAgentFiles` result: restore every backup, restore
 * replaced managed contents byte-for-byte, and remove only files that were
 * newly created by that install. Unchanged files are ignored.
 *
 * Retry-safe (T008 transient-rollback): already-restored roles whose backup
 * was consumed (missing backup, live present) are treated as resolved so a
 * defensive second pass is not blocked by consumed entries. Roles with an
 * existing backup are still attempted. Unresolved failures (missing backup
 * with missing live, failed renames/rewrites) are collected across all roles
 * and rethrown at the end — fail-closed, never silently discarded.
 */
export declare function rollbackAgentInstall(dir: string, result: AgentInstallResult): Promise<void>;
//# sourceMappingURL=agents.d.ts.map