import { type AgentRule } from "./permissions.js";
import type { RoleName } from "./types.js";
/**
 * Diagnostics for the canonical role contract, evaluated against the live
 * permission rules that generated agents carry (`getPermissionsForRole`).
 * This module describes requirements only; it owns no state and never edits
 * agents or configuration.
 */
/** MCP grants every coding role must carry (Engram, Context7, CodeGraph). */
export declare const REQUIRED_MCP_ACTIONS: readonly string[];
/** Canonical ZotPilot read tools (allow) and mutation tools (ask). */
export declare const ZOTPILOT_READ_ACTIONS: readonly string[];
export declare const ZOTPILOT_MUTATION_ACTIONS: readonly string[];
export type RoleRules = Record<RoleName, readonly AgentRule[]>;
/** Live permission rules for every packaged role. */
export declare function liveRoleRules(): RoleRules;
/** Roles whose live rules carry every required MCP grant. */
export declare function codingRoles(rules?: RoleRules): RoleName[];
/**
 * Validate the live role requirements: coding roles carry every required MCP
 * grant; researcher carries Context7 only; writer, archivist, and scientist
 * carry none. Returns one human-readable issue per violation; empty when
 * canonical.
 */
export declare function roleRequirementIssues(rules?: RoleRules): string[];
export interface ZotPilotPolicyValidation {
    /** Canonical expected read tool IDs (allow). */
    expectedReadIds: string[];
    /** Canonical expected mutation tool IDs (ask). */
    expectedMutationIds: string[];
    /** Canonical IDs granted by a non-deny rule. */
    present: string[];
    /** Canonical IDs missing from the effective grants. */
    missing: string[];
    /** Granted ZotPilot IDs that are not canonical. */
    unexpected: string[];
    /** ZotPilot allow/ask wildcard entries (including `zotpilot_*`). */
    wildcards: string[];
    /** Human-readable policy violations; empty when the policy is canonical. */
    issues: string[];
}
/**
 * Validate the researcher's ZotPilot policy against the live rules: every read
 * tool allow, every mutation tool ask, no ZotPilot wildcard grant, and no
 * non-canonical ZotPilot grant.
 */
export declare function validateZotPilotPolicy(rules?: readonly AgentRule[]): ZotPilotPolicyValidation;
//# sourceMappingURL=role-requirements.d.ts.map