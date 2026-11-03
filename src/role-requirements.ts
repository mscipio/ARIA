import { ROLES } from "./overrides.js";
import { evaluatePermission, getPermissionsForRole, type AgentRule } from "./permissions.js";
import type { RoleName } from "./types.js";

/**
 * Diagnostics for the canonical role contract, evaluated against the live
 * permission rules that generated agents carry (`getPermissionsForRole`).
 * This module describes requirements only; it owns no state and never edits
 * agents or configuration.
 */

/** MCP grants every coding role must carry (Engram, Context7, CodeGraph). */
export const REQUIRED_MCP_ACTIONS: readonly string[] = ["engram_*", "context7_*", "codegraph_*"];

/** Coding roles: must carry every required MCP grant. */
const CODING_ROLE_NAMES: readonly RoleName[] = ["coder", "explorer", "visualizer", "planner", "implementer", "reviewer"];

/**
 * Non-coding roles and the only required MCP grants each may carry. An
 * unlisted action falls back to `ask` (not a grant), so only an explicit
 * `allow` counts as a grant for non-coding roles.
 */
const NON_CODING_ALLOWED: ReadonlyArray<{ role: RoleName; allowed: readonly string[] }> = [
  { role: "researcher", allowed: ["context7_*"] },
  { role: "writer", allowed: [] },
  { role: "archivist", allowed: [] },
  { role: "scientist", allowed: [] },
];

/** Canonical ZotPilot read tools (allow) and mutation tools (ask). */
export const ZOTPILOT_READ_ACTIONS: readonly string[] = [
  "zotpilot_search_papers",
  "zotpilot_search_topic",
  "zotpilot_search_boolean",
  "zotpilot_search_formulas",
  "zotpilot_advanced_search",
  "zotpilot_search_academic_databases",
  "zotpilot_browse_library",
  "zotpilot_get_paper_details",
  "zotpilot_get_notes",
  "zotpilot_get_annotations",
  "zotpilot_get_citations",
  "zotpilot_get_passage_context",
  "zotpilot_get_index_stats",
  "zotpilot_get_paper_for_tutor",
];

export const ZOTPILOT_MUTATION_ACTIONS: readonly string[] = [
  "zotpilot_index_library",
  "zotpilot_index_formulas",
  "zotpilot_ingest_by_identifiers",
  "zotpilot_create_note",
  "zotpilot_manage_tags",
  "zotpilot_manage_collections",
  "zotpilot_annotate_pdf",
  "zotpilot_save_reading_persona",
];

export type RoleRules = Record<RoleName, readonly AgentRule[]>;

/** Live permission rules for every packaged role. */
export function liveRoleRules(): RoleRules {
  const rules = {} as Record<RoleName, AgentRule[]>;
  for (const role of ROLES) rules[role] = getPermissionsForRole(role);
  return rules;
}

function decision(rules: readonly AgentRule[], action: string): "allow" | "deny" | "ask" {
  return evaluatePermission(rules, action, "*");
}

function hasRequiredMcp(rules: readonly AgentRule[]): boolean {
  return REQUIRED_MCP_ACTIONS.every((action) => decision(rules, action) === "allow");
}

/** Roles whose live rules carry every required MCP grant. */
export function codingRoles(rules: RoleRules = liveRoleRules()): RoleName[] {
  return ROLES.filter((role) => hasRequiredMcp(rules[role]));
}

/**
 * Validate the live role requirements: coding roles carry every required MCP
 * grant; researcher carries Context7 only; writer, archivist, and scientist
 * carry none. Returns one human-readable issue per violation; empty when
 * canonical.
 */
export function roleRequirementIssues(rules: RoleRules = liveRoleRules()): string[] {
  const issues: string[] = [];
  const coding = codingRoles(rules);

  for (const role of CODING_ROLE_NAMES) {
    for (const action of REQUIRED_MCP_ACTIONS) {
      if (decision(rules[role], action) !== "allow") {
        issues.push(`${role} permission ${action} is not allow`);
      }
    }
  }
  for (const { role, allowed } of NON_CODING_ALLOWED) {
    if (coding.includes(role)) {
      issues.push(`${role} is treated as a coding role but must not be`);
    }
    for (const action of REQUIRED_MCP_ACTIONS) {
      const value = decision(rules[role], action);
      if (allowed.includes(action)) {
        if (value !== "allow") issues.push(`${role} is missing required ${action} = allow`);
      } else if (value === "allow") {
        issues.push(`${role} unexpectedly grants ${action} = ${value}`);
      }
    }
  }
  return issues;
}

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
export function validateZotPilotPolicy(
  rules: readonly AgentRule[] = getPermissionsForRole("researcher"),
): ZotPilotPolicyValidation {
  const expectedReadIds = [...ZOTPILOT_READ_ACTIONS];
  const expectedMutationIds = [...ZOTPILOT_MUTATION_ACTIONS];
  const expected = new Set([...expectedReadIds, ...expectedMutationIds]);
  const zotpilotGrants = rules.filter((rule) => rule.action.startsWith("zotpilot") && rule.effect !== "deny");
  const wildcards = [...new Set(zotpilotGrants.filter((rule) => rule.action.includes("*")).map((rule) => rule.action))];
  const granted = new Set(zotpilotGrants.filter((rule) => !rule.action.includes("*")).map((rule) => rule.action));
  const present = [...expected].filter((id) => granted.has(id));
  const missing = [...expected].filter((id) => !granted.has(id));
  const unexpected = [...granted].filter((id) => !expected.has(id));

  const issues: string[] = [];
  for (const id of wildcards) issues.push(`ZotPilot wildcard grant ${id} is not allowed`);
  // An absent explicit grant is a violation even though the fallback decision is `ask`.
  for (const id of expectedReadIds) {
    if (!granted.has(id)) {
      issues.push(`ZotPilot read ${id} is missing its explicit allow grant`);
      continue;
    }
    const value = decision(rules, id);
    if (value !== "allow") issues.push(`ZotPilot read ${id} must be allow (got ${value})`);
  }
  for (const id of expectedMutationIds) {
    if (!granted.has(id)) {
      issues.push(`ZotPilot mutation ${id} is missing its explicit ask grant`);
      continue;
    }
    const value = decision(rules, id);
    if (value !== "ask") issues.push(`ZotPilot mutation ${id} must be ask (got ${value})`);
  }
  for (const id of unexpected) issues.push(`ZotPilot grant ${id} is not canonical`);
  return { expectedReadIds, expectedMutationIds, present, missing, unexpected, wildcards, issues };
}
