import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyExperimentalSubagentDepthDefault,
  evaluatePermission,
  getArchivistScopedPermissions,
  getPermissionsForRole,
} from "../src/permissions";
import { getPackageRoot } from "../src/defaults";
import type { RoleName } from "../src/types";
import { Agent } from "@opencode/schema";

/**
 * T004 parity acceptance: ordering is demonstrated through the
 * 2.0.23-style evaluator (`findLast` + fallback `ask`), not by inspecting
 * `Rule[]` order alone. Each case below asserts the *evaluated* effect for
 * a representative operation where last-match-wins decides the outcome.
 */

const LEGACY_ACTIONS = ["bash", "task", "plan", "todowrite", "list", "lsp", "doom_loop"];

function actionsFor(role: RoleName): string[] {
  return getPermissionsForRole(role).map((rule) => rule.action);
}

describe("T004 permission/model/delegation parity", () => {
  it("never emits legacy V1 actions as V2 rules", () => {
    const roles: RoleName[] = [
      "coder",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
      "writer",
      "scientist",
    ];
    for (const role of roles) {
      const actions = actionsFor(role);
      for (const legacy of LEGACY_ACTIONS) {
        expect(actions, `${role} emits legacy ${legacy}`).not.toContain(legacy);
      }
      // V2 renames are present where delegation/shell apply.
      if (role === "coder" || role === "researcher" || role === "writer" || role === "scientist") {
        expect(actions, `${role} uses V2 subagent`).toContain("subagent");
      }
    }
    // Shell appears for roles with explicit shell posture (deny or allow).
    expect(actionsFor("implementer")).toContain("shell");
    expect(actionsFor("reviewer")).toContain("shell");
    expect(actionsFor("researcher")).toContain("shell");
  });

  it("evaluates protected .env with example-allow prevailing over ask (last-match)", () => {
    for (const role of ["coder", "explorer", "implementer", "researcher", "writer", "scientist"] as const) {
      const rules = getPermissionsForRole(role);
      // Broad allow, then ask gates, then example exception: the final
      // matching rule decides, so the example allow must be last.
      expect(evaluatePermission(rules, "read", "src/app.ts")).toBe("allow");
      expect(evaluatePermission(rules, "read", ".env")).toBe("ask");
      expect(evaluatePermission(rules, "read", "config.env")).toBe("ask");
      expect(evaluatePermission(rules, "read", "a.env.bak")).toBe("ask");
      expect(evaluatePermission(rules, "read", ".env.example")).toBe("allow");
      expect(evaluatePermission(rules, "read", "config.env.example")).toBe("allow");
    }
    // Implementer edit mirrors the same ordering for writes.
    const impl = getPermissionsForRole("implementer");
    expect(evaluatePermission(impl, "edit", "src/app.ts")).toBe("allow");
    expect(evaluatePermission(impl, "edit", ".env")).toBe("ask");
    expect(evaluatePermission(impl, "edit", "a.env.bak")).toBe("ask");
    expect(evaluatePermission(impl, "edit", ".env.example")).toBe("allow");
    // Non-implementers deny edits outright (explicit, not fallback).
    expect(evaluatePermission(getPermissionsForRole("explorer"), "edit", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("coder"), "edit", "src/app.ts")).toBe("deny");
  });

  it("evaluates implementer shell deny-list after broad allow (deny prevails)", () => {
    const rules = getPermissionsForRole("implementer");
    expect(evaluatePermission(rules, "shell", "git status")).toBe("allow");
    // Representative destructive/publishing gates: last-match deny after allow.
    expect(evaluatePermission(rules, "shell", "rm foo")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "rm")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "npm publish foo")).toBe("deny");
    // Reviewer stays unrestricted for inspection; others deny.
    expect(evaluatePermission(getPermissionsForRole("reviewer"), "shell", "rm foo")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "shell", "git status")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("coder"), "shell", "git status")).toBe("deny");
  });

  it("evaluates coder delegation: 9 subagent allows, deny for others, ask fallback", () => {
    const rules = getPermissionsForRole("coder");
    for (const target of [
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
      "scientist",
    ]) {
      expect(evaluatePermission(rules, "subagent", target)).toBe("allow");
    }
    // Writer is intentionally excluded from coder delegation (as in V1).
    expect(evaluatePermission(rules, "subagent", "writer")).toBe("deny");
    expect(evaluatePermission(rules, "subagent", "unknown-agent")).toBe("deny");
    // Researcher delegates only to scientist; scientist to 3; writer to 3.
    expect(evaluatePermission(getPermissionsForRole("researcher"), "subagent", "scientist")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("researcher"), "subagent", "coder")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("scientist"), "subagent", "researcher")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("scientist"), "subagent", "writer")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("scientist"), "subagent", "coder")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("scientist"), "subagent", "explorer")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("writer"), "subagent", "archivist")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("writer"), "subagent", "coder")).toBe("deny");
    // Non-delegating specialists deny all subagents explicitly.
    expect(evaluatePermission(getPermissionsForRole("explorer"), "subagent", "reviewer")).toBe("deny");
  });

  it("evaluates coder adversarial-review deny prevailing over broad skill allow", () => {
    const coder = getPermissionsForRole("coder");
    // Broad allow first, exact deny after: last-match denies the one mode.
    expect(evaluatePermission(coder, "skill", "rdc-adversarial-review")).toBe("deny");
    expect(evaluatePermission(coder, "skill", "rdc-code-implementation")).toBe("allow");
    expect(evaluatePermission(coder, "skill", "aria-research-evidence")).toBe("allow");
    // Reviewer is the only allow for the adversarial mode; others deny.
    expect(evaluatePermission(getPermissionsForRole("reviewer"), "skill", "rdc-adversarial-review")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "skill", "rdc-adversarial-review")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "skill", "rdc-code-exploration")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "skill", "unknown-skill")).toBe("deny");
  });

  it("evaluates researcher/scientist distinctions with MCP allow/ask boundaries", () => {
    const researcher = getPermissionsForRole("researcher");
    // Context7 only; no Engram/CodeGraph wildcard authority.
    expect(evaluatePermission(researcher, "context7_*", "*")).toBe("allow");
    expect(evaluatePermission(researcher, "engram_*", "*")).toBe("ask");
    expect(evaluatePermission(researcher, "codegraph_*", "*")).toBe("ask");
    // Representative ZotPilot read (allow) vs mutation (ask); unlisted falls back to ask.
    expect(evaluatePermission(researcher, "zotpilot_search_papers", "*")).toBe("allow");
    expect(evaluatePermission(researcher, "zotpilot_get_notes", "*")).toBe("allow");
    expect(evaluatePermission(researcher, "zotpilot_create_note", "*")).toBe("ask");
    expect(evaluatePermission(researcher, "zotpilot_manage_tags", "*")).toBe("ask");
    expect(evaluatePermission(researcher, "zotpilot_search_tables", "*")).toBe("ask");
    expect(researcher.some((rule) => rule.action === "zotpilot_*")).toBe(false);
    // Researcher shell: deny-by-default, zotpilot family ask-gated, nothing allowed.
    expect(evaluatePermission(researcher, "shell", "ls")).toBe("deny");
    expect(evaluatePermission(researcher, "shell", "zotpilot")).toBe("ask");
    expect(evaluatePermission(researcher, "shell", "zotpilot sync")).toBe("ask");
    // Scientist has no MCP authority and denies shell outright.
    const scientist = getPermissionsForRole("scientist");
    expect(evaluatePermission(scientist, "context7_*", "*")).toBe("ask");
    expect(evaluatePermission(scientist, "zotpilot_search_papers", "*")).toBe("ask");
    expect(evaluatePermission(scientist, "shell", "zotpilot")).toBe("deny");
    // Coding roles carry all three MCP grants; writer/scientist/archivist carry none.
    for (const role of ["coder", "explorer", "planner", "implementer", "reviewer"] as const) {
      const rules = getPermissionsForRole(role);
      expect(evaluatePermission(rules, "engram_*", "*")).toBe("allow");
      expect(evaluatePermission(rules, "context7_*", "*")).toBe("allow");
      expect(evaluatePermission(rules, "codegraph_*", "*")).toBe("allow");
    }
    expect(evaluatePermission(getPermissionsForRole("writer"), "engram_*", "*")).toBe("ask");
    expect(evaluatePermission(getPermissionsForRole("archivist"), "context7_*", "*")).toBe("ask");
  });

  it("evaluates external-directory deny with archivist scoping and fallback ask", () => {
    // Most roles deny external directories explicitly.
    expect(evaluatePermission(getPermissionsForRole("coder"), "external_directory", "/tmp/x")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "external_directory", "/tmp/x")).toBe("deny");
    // Managed-file archivist is deny-by-default (safe without worktree).
    expect(evaluatePermission(getPermissionsForRole("archivist"), "external_directory", "/tmp/x")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("archivist"), "read", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("archivist"), "shell", "ls")).toBe("deny");
  });

  it("falls back to ask when no rule matches (2.0.23 default)", () => {
    const rules = getPermissionsForRole("explorer");
    // Unknown future action with no matching rule prompts instead of allowing.
    expect(evaluatePermission(rules, "execute", "*")).toBe("ask");
    expect(evaluatePermission(rules, "totally_unknown_action", "whatever")).toBe("ask");
  });

  it("emits explicit first-position ask fallback overriding native allow-all", () => {
    const roles: RoleName[] = [
      "coder",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
      "writer",
      "scientist",
    ];
    for (const role of roles) {
      const rules = getPermissionsForRole(role);
      // First position overrides the native builtin allow-all; later
      // specific rules still prevail under last-match-wins.
      expect(rules[0], `${role} first rule is fallback ask`).toEqual({
        action: "*",
        resource: "*",
        effect: "ask",
      });
      const laterBlanketAllow = rules
        .slice(1)
        .some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow");
      expect(laterBlanketAllow, `${role} has no later blanket allow`).toBe(false);
    }
    // Ordering preserved: fallback does not shadow intended allows/denies.
    const impl = getPermissionsForRole("implementer");
    expect(evaluatePermission(impl, "read", "src/app.ts")).toBe("allow");
    expect(evaluatePermission(impl, "shell", "git status")).toBe("allow");
    expect(evaluatePermission(impl, "shell", "rm foo")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "edit", "src/app.ts")).toBe("deny");
  });

  it("evaluates native merged builtin+generated rules with fallback ask effective", () => {
    const builtin = Agent.Info.default(Agent.ID.make("scientist")).permissions;
    expect(builtin.some((rule) => rule.action === "*" && rule.effect === "allow")).toBe(true);
    for (const role of ["scientist", "researcher", "explorer"] as const) {
      const generated = getPermissionsForRole(role);
      const merged = [...builtin, ...generated];
      // Unknown future actions must ask merged (builtin allow-all overridden
      // by the first-position fallback), never allow.
      expect(evaluatePermission(merged, "totally_unknown_action", "whatever")).toBe("ask");
      expect(evaluatePermission(merged, "execute", "*")).toBe("ask");
    }
    // Repro from the finding: scientist `engram_mem_save` is ask isolated
    // but inherited builtin allow-all merged before the fix; the fallback
    // must keep the merged result at ask.
    expect(evaluatePermission(getPermissionsForRole("scientist"), "engram_mem_save", "*")).toBe("ask");
    expect(
      evaluatePermission(
        [...Agent.Info.default(Agent.ID.make("scientist")).permissions, ...getPermissionsForRole("scientist")],
        "engram_mem_save",
        "*",
      ),
    ).toBe("ask");
    expect(
      evaluatePermission(
        [...Agent.Info.default(Agent.ID.make("researcher")).permissions, ...getPermissionsForRole("researcher")],
        "engram_mem_save",
        "*",
      ),
    ).toBe("ask");
    // Intended coding-role MCP grants still allow merged (no over-denial).
    expect(
      evaluatePermission(
        [...Agent.Info.default(Agent.ID.make("explorer")).permissions, ...getPermissionsForRole("explorer")],
        "engram_mem_save",
        "*",
      ),
    ).toBe("allow");
    // Denied specialist MCP boundaries stay denied/ask, intended allows stay allowed.
    const scientistMerged = [
      ...Agent.Info.default(Agent.ID.make("scientist")).permissions,
      ...getPermissionsForRole("scientist"),
    ];
    expect(evaluatePermission(scientistMerged, "read", "src/app.ts")).toBe("allow");
    expect(evaluatePermission(scientistMerged, "edit", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(scientistMerged, "shell", "zotpilot")).toBe("deny");
    expect(evaluatePermission(scientistMerged, "context7_*", "*")).toBe("ask");
    const researcherMerged = [
      ...Agent.Info.default(Agent.ID.make("researcher")).permissions,
      ...getPermissionsForRole("researcher"),
    ];
    expect(evaluatePermission(researcherMerged, "context7_*", "*")).toBe("allow");
    expect(evaluatePermission(researcherMerged, "engram_*", "*")).toBe("ask");
    expect(evaluatePermission(researcherMerged, "zotpilot_search_papers", "*")).toBe("allow");
  });

  it("applies experimental.subagent_depth:3 only when absent and never emits top-level", () => {
    expect(applyExperimentalSubagentDepthDefault({})).toEqual({ experimental: { subagent_depth: 3 } });
    expect(applyExperimentalSubagentDepthDefault({ experimental: {} })).toEqual({
      experimental: { subagent_depth: 3 },
    });
    expect(
      applyExperimentalSubagentDepthDefault({ experimental: { subagent_depth: null } }),
    ).toEqual({ experimental: { subagent_depth: 3 } });
    for (const depth of [0, 1, 2, 3, 5]) {
      expect(applyExperimentalSubagentDepthDefault({ experimental: { subagent_depth: depth } })).toEqual({
        experimental: { subagent_depth: depth },
      });
    }
    // Never emits the V1 top-level key.
    const configured: { experimental?: { subagent_depth?: number }; subagent_depth?: number } = {};
    applyExperimentalSubagentDepthDefault(configured);
    expect(configured).not.toHaveProperty("subagent_depth");
    expect(configured.experimental?.subagent_depth).toBe(3);
  });
});

describe("T004 archivist WIKI scoping (runtime, WIKI_DIR set)", () => {
  const priorWikiDir = process.env.WIKI_DIR;
  afterEach(() => {
    if (priorWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = priorWikiDir;
  });

  it("evaluates scoped read/edit/external allows with python allowlist ordering", () => {
    process.env.WIKI_DIR = "/tmp/aria-wiki";
    const rules = getArchivistScopedPermissions("/repo");
    // V2 path semantics: external wiki scopes as canonical absolute paths
    // (repro `/tmp/aria-wiki/page.md` denied under worktree-relative scope).
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(evaluatePermission(rules, "read", "/tmp/aria-wiki/page.md")).toBe("allow");
    expect(evaluatePermission(rules, "edit", "/tmp/aria-wiki/page.md")).toBe("allow");
    expect(evaluatePermission(rules, "read", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "src/app.ts")).toBe("deny");
    // Package pipeline is external to the worktree: absolute reads allow,
    // edits stay denied (pipeline read-only).
    const pipelineRoot = join(getPackageRoot(), "wiki-pipeline");
    expect(evaluatePermission(rules, "read", join(pipelineRoot, "run.py"))).toBe("allow");
    expect(evaluatePermission(rules, "read", join(pipelineRoot, "docs/guide.md"))).toBe("allow");
    expect(evaluatePermission(rules, "edit", join(pipelineRoot, "run.py"))).toBe("deny");
    expect(evaluatePermission(rules, "read", "/other/file.md")).toBe("deny");
    // Shell: deny first, then exact python allowlist after (never `python *`).
    expect(evaluatePermission(rules, "shell", "ls")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "python *")).toBe("deny");
    expect(rules.some((rule) => rule.action === "shell" && rule.resource === "python *")).toBe(false);
    const pipelineRun = rules.find((rule) => rule.resource.includes("archive-opencode"))?.resource;
    expect(pipelineRun).toMatch(/python .*run\.py archive-opencode/);
    expect(evaluatePermission(rules, "shell", pipelineRun!)).toBe("allow");
    // External directories stay absolute with scoped allows after deny.
    expect(evaluatePermission(rules, "external_directory", "/tmp/aria-wiki/**")).toBe("allow");
    expect(evaluatePermission(rules, "external_directory", "/other/**")).toBe("deny");
    // Wiki skills stay scoped; no MCP authority even when scoped.
    expect(evaluatePermission(rules, "skill", "aria-wiki-lookup")).toBe("allow");
    expect(evaluatePermission(rules, "skill", "aria-document-design")).toBe("deny");
    expect(evaluatePermission(rules, "engram_*", "*")).toBe("ask");
  });

  it("scopes internal wiki paths location-relative", () => {
    const worktree = "/repo";
    process.env.WIKI_DIR = join(worktree, "wiki");
    const rules = getArchivistScopedPermissions(worktree);
    // Internal wiki lives inside the Location: Location-relative resources.
    expect(evaluatePermission(rules, "read", "wiki/page.md")).toBe("allow");
    expect(evaluatePermission(rules, "edit", "wiki/page.md")).toBe("allow");
    expect(evaluatePermission(rules, "read", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "src/app.ts")).toBe("deny");
  });
});
