import { type Plugin } from "@opencode-ai/plugin";
import type { RoleName } from "./types.js";
type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type AgentPermission = Record<string, PermissionRule>;
/**
 * De-duplicated names of the package-owned skills that the packaged roles
 * actually allow, in canonical role order (coder grants none; the
 * WIKI_DIR-expanded archivist allows the same three wiki skills as the
 * unexpanded role). Derived from `ROLE_PERMISSIONS` rather than copied, so a
 * role permission change is reflected here automatically.
 */
export declare const PACKAGE_SKILL_NAMES: readonly string[];
/**
 * Roles that carry every canonical required MCP grant (Engram/Context7/
 * CodeGraph): the coder plus the six RDC coding roles. Derived from the
 * coder permission construction and `ROLE_PERMISSIONS`; researcher, writer,
 * archivist, and scientist are intentionally not included.
 */
export declare const CODING_ROLES: readonly RoleName[];
/** Effective permissions of every packaged role (coder + non-coder roles). */
export declare function effectiveRolePermissions(): Record<RoleName, AgentPermission>;
/**
 * Validate effective role requirements against the canonical contract:
 * coding roles carry every `REQUIRED_MCP_PERMISSION` grant, the researcher
 * carries Context7 plus the exact ZotPilot policy, and writer/archivist/
 * scientist are not treated as coding roles (no required-MCP grants).
 *
 * Returns a human-readable issue per violation; empty when canonical.
 */
export declare function roleRequirementIssues(permissions?: Record<RoleName, AgentPermission>): string[];
export interface ZotPilotPolicyValidation {
    /** Canonical expected read tool IDs (allow). */
    expectedReadIds: string[];
    /** Canonical expected mutation tool IDs (ask). */
    expectedMutationIds: string[];
    /** Effective non-wildcard ZotPilot entries present in the researcher permission. */
    present: string[];
    /** Canonical IDs missing from the effective entries. */
    missing: string[];
    /** Effective IDs that are not canonical. */
    unexpected: string[];
    /** ZotPilot allow/ask wildcard entries (including `zotpilot_*`). */
    wildcards: string[];
    /** Human-readable policy violations; empty when the policy is canonical. */
    issues: string[];
}
/**
 * Internal ZotPilot policy validation (not a live tool inventory): compares
 * the canonical expected read/mutation IDs with the effective researcher
 * permission entries. Requires every read ID = `allow` and every mutation
 * ID = `ask`, requires the read/mutation sets to be disjoint, and rejects any
 * ZotPilot allow/ask wildcard (including `zotpilot_*`).
 */
export declare function validateZotPilotPolicy(permission?: AgentPermission): ZotPilotPolicyValidation;
export declare const ariaPlugin: Plugin;
export {};
//# sourceMappingURL=register.d.ts.map