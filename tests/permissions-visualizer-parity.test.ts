import { describe, expect, it } from "vitest";

import { generateAgentFiles } from "../src/agents";
import { authorizePlan } from "../src/plan-tool";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions";
import type { AgentRule } from "../src/permissions";
import { resolveAriaConfig } from "../src/overrides";

/**
 * T003 — Visualizer/Implementer exact effective edit/shell parity.
 *
 * Compares ACTUAL effective decisions via `evaluatePermission` (not helper
 * presence) for representative shell commands and edit paths, checks that
 * generated agent files agree with the canonical permissions, and pins the
 * preserved non-edit/shell safeguards plus unchanged other roles.
 */

const VISUALIZER = () => getPermissionsForRole("visualizer");
const IMPLEMENTER = () => getPermissionsForRole("implementer");

function effectFor(role: "visualizer" | "implementer", action: string, resource: string) {
  const rules = role === "visualizer" ? VISUALIZER() : IMPLEMENTER();
  return evaluatePermission(rules, action, resource);
}

function ruleSlice(rules: readonly AgentRule[], action: string): AgentRule[] {
  return rules.filter((rule) => rule.action === action);
}

function parseFrontmatterPermissions(content: string): AgentRule[] {
  const lines = content.split("\n");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new Error("generated agent file has no frontmatter closing");
  const frontmatter = lines.slice(1, closing);
  const permissions: AgentRule[] = [];
  for (let index = 0; index < frontmatter.length; index += 1) {
    const actionMatch = frontmatter[index]?.match(/^\s*-\s*action:\s*(.*)$/);
    if (!actionMatch) continue;
    const resourceLine = frontmatter[index + 1];
    const effectLine = frontmatter[index + 2];
    if (!resourceLine?.includes("resource:") || !effectLine?.includes("effect:")) {
      throw new Error("malformed generated permissions frontmatter");
    }
    const action = JSON.parse(actionMatch[1]!.trim()) as unknown;
    const resource = JSON.parse(resourceLine.split("resource:")[1]!.trim()) as unknown;
    const effect = effectLine.split("effect:")[1]!.trim();
    if (typeof action !== "string" || typeof resource !== "string") throw new Error("bad rule");
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") throw new Error("bad effect");
    permissions.push({ action, resource, effect });
  }
  return permissions;
}

describe("T003 visualizer/implementer effective edit/shell parity", () => {
  it("shares identical edit/shell rule subsequences (same helpers, same order)", () => {
    const viz = VISUALIZER();
    const impl = IMPLEMENTER();
    expect(ruleSlice(viz, "edit")).toEqual(ruleSlice(impl, "edit"));
    expect(ruleSlice(viz, "shell")).toEqual(ruleSlice(impl, "shell"));
    // No visualizer-only shell overrides survive: no blanket `shell: ask`,
    // no egress/install/git-mutating deny resources beyond the shared list.
    expect(viz.some((rule) => rule.action === "shell" && rule.resource === "*")).toBe(true);
    expect(
      viz.find((rule) => rule.action === "shell" && rule.resource === "*"),
    ).toEqual({ action: "shell", resource: "*", effect: "allow" });
  });

  it("evaluates ordinary dev shell commands identically (allow/allow)", () => {
    const ordinaryDev = [
      "python scripts/capture.py",
      "python -m pytest tests/",
      "xvfb-run python screenshot.py",
      "python -m qtest",
      "ls",
      "pwd",
      "mkdir -p scratch/captures",
      "git status",
    ];
    for (const cmd of ordinaryDev) {
      expect(effectFor("visualizer", "shell", cmd)).toBe(effectFor("implementer", "shell", cmd));
      expect(effectFor("visualizer", "shell", cmd)).toBe("allow");
    }
  });

  it("evaluates shared destructive/publish denies identically (deny/deny)", () => {
    const sharedDenies = ["rm foo", "rm -rf scratch/captures", "rm", "rmdir foo", "npm publish foo"];
    for (const cmd of sharedDenies) {
      expect(effectFor("visualizer", "shell", cmd)).toBe("deny");
      expect(effectFor("implementer", "shell", cmd)).toBe("deny");
    }
  });

  it("evaluates formerly visualizer-divergent commands identically (parity, allow/allow)", () => {
    // Superseded visualizer-only denies: under exact parity these match the
    // implementer (`allow`), documenting the increased authority.
    const formerlyDivergent = [
      "curl https://example.com",
      "wget https://example.com/pkg.tar.gz",
      "npm install some-package",
      "pip install some-package",
      "git push origin main",
      "git reset --hard",
    ];
    for (const cmd of formerlyDivergent) {
      expect(effectFor("visualizer", "shell", cmd)).toBe(effectFor("implementer", "shell", cmd));
    }
    expect(effectFor("visualizer", "shell", "curl https://example.com")).toBe("allow");
  });

  it("evaluates edit paths identically, including protected files", () => {
    const cases: [string, "allow" | "ask"][] = [
      ["src/app.ts", "allow"],
      ["src/qt/widget.py", "allow"],
      [".env", "ask"],
      ["config.env", "ask"],
      ["a.env.bak", "ask"],
      [".env.example", "allow"],
      ["config.env.example", "allow"],
    ];
    for (const [path, expected] of cases) {
      expect(effectFor("visualizer", "edit", path)).toBe(expected);
      expect(effectFor("implementer", "edit", path)).toBe(expected);
    }
  });

  it("generates agent files agreeing with canonical permissions", () => {
    // Read-only generation: no installs, no global-config writes.
    const resolved = resolveAriaConfig(process.cwd());
    const files = generateAgentFiles(resolved, "9.9.9");
    for (const role of ["visualizer", "implementer"] as const) {
      expect(parseFrontmatterPermissions(files[role])).toEqual(getPermissionsForRole(role));
    }
    // Parity survives generation: file-byte shell/edit slices agree.
    const vizRules = parseFrontmatterPermissions(files.visualizer);
    const implRules = parseFrontmatterPermissions(files.implementer);
    expect(ruleSlice(vizRules, "edit")).toEqual(ruleSlice(implRules, "edit"));
    expect(ruleSlice(vizRules, "shell")).toEqual(ruleSlice(implRules, "shell"));
  });

  it("preserves visualizer non-edit/shell safeguards", () => {
    const rules = VISUALIZER();
    // Grant-only skill.
    expect(evaluatePermission(rules, "skill", "aria-qt-ui")).toBe("allow");
    expect(evaluatePermission(rules, "skill", "unknown-skill")).toBe("deny");
    // Coding MCP triple; research MCP family denied.
    expect(evaluatePermission(rules, "engram_*", "*")).toBe("allow");
    expect(evaluatePermission(rules, "context7_*", "*")).toBe("allow");
    expect(evaluatePermission(rules, "codegraph_*", "*")).toBe("allow");
    expect(evaluatePermission(rules, "zotpilot_search_papers", "*")).toBe("deny");
    // Delegation + web/question/external boundaries.
    expect(evaluatePermission(rules, "subagent", "explorer")).toBe("deny");
    expect(evaluatePermission(rules, "webfetch", "https://example.com")).toBe("deny");
    expect(evaluatePermission(rules, "websearch", "query")).toBe("deny");
    expect(evaluatePermission(rules, "question", "*")).toBe("deny");
    expect(evaluatePermission(rules, "external_directory", "/tmp/x")).toBe("deny");
    // Plan access stays denied at execution; no Rule[] emitted for it.
    expect(evaluatePermission(rules, "plan", "*")).toBe("ask");
    expect(rules.some((rule) => rule.action === "mcp_plan")).toBe(false);
    expect(authorizePlan({ sessionID: "test", agent: "visualizer" }, "get")).not.toBeNull();
  });

  it("leaves other roles unchanged (spot checks)", () => {
    // Coder/explorer still deny edits and shell outright.
    expect(evaluatePermission(getPermissionsForRole("coder"), "edit", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("coder"), "shell", "git status")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "edit", "src/app.ts")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "shell", "git status")).toBe("deny");
    // Reviewer stays unrestricted for inspection.
    expect(evaluatePermission(getPermissionsForRole("reviewer"), "shell", "rm foo")).toBe("allow");
    // Researcher/scientist shell posture untouched.
    expect(evaluatePermission(getPermissionsForRole("researcher"), "shell", "ls")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("scientist"), "shell", "zotpilot")).toBe("deny");
    // Coder delegation untouched (writer still excluded).
    expect(evaluatePermission(getPermissionsForRole("coder"), "subagent", "explorer")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("coder"), "subagent", "writer")).toBe("deny");
  });
});
