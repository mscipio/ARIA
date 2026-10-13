import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { resolveAriaConfig } from "../src/overrides";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions";

/**
 * T004 pre-planning evidence routing contract (file-content only, no live shell).
 *
 * Explorer owns content inspection via read/glob/grep/CodeGraph
 * (shell-denied, independent); Reviewer contributes shell-only
 * repository/workstation-fact inspection, inspection-only and non-mutating;
 * Coder reconciles both streams; Planner plans from the combined evidence.
 * Permissions stay unchanged: no new agent, no explorer/coder shell grant.
 */

function promptFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "defaults", "prompts", name), "utf8");
}

describe("T004 pre-planning evidence routing", () => {
  it("states the routing boundary in both coder and reviewer instructions", () => {
    for (const name of ["coder.md", "reviewer.md"] as const) {
      const text = promptFile(name);
      expect(text, `${name} routing header`).toContain("Pre-planning evidence routing:");
      expect(text, `${name} explorer content role`).toContain(
        "Explorer handles content inspection via read/glob/grep/CodeGraph",
      );
      expect(text, `${name} reviewer shell-fact role`).toContain(
        "Reviewer contributes shell-only repository/workstation-fact inspection",
      );
      expect(text, `${name} coder reconcile role`).toContain("Coder reconciles both evidence streams");
      expect(text, `${name} planner role`).toContain("Planner plans from the combined evidence");
    }
    // Resolved prompts carry the same boundary into generated agent bodies.
    const resolved = resolveAriaConfig(tmpdir());
    for (const role of ["coder", "reviewer"] as const) {
      expect(resolved.roles[role].promptText).toContain("Pre-planning evidence routing:");
    }
  });

  it("states the reviewer non-mutating boundary without expanding permissions", () => {
    const reviewer = promptFile("reviewer.md");
    expect(reviewer).toContain("inspection-only and non-mutating");
    expect(reviewer).toContain("no edits");
    expect(reviewer).toContain("no Git refs/index/worktree mutation");
    expect(reviewer).toContain("no installs");
    expect(reviewer).toContain("no config change");
    expect(reviewer).toContain("no publish/upgrade");
    expect(reviewer).toContain("no services");
  });

  it("keeps permission boundaries unchanged with no new agent or shell grant", () => {
    expect(Object.keys(loadDefaultConfig().roles)).toHaveLength(11);
    // Explorer: content tools allow, shell denied, no delegation.
    expect(evaluatePermission(getPermissionsForRole("explorer"), "shell", "git status")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("explorer"), "read", "src/app.ts")).toBe("allow");
    // Coder: coordinates without shell or edits.
    expect(evaluatePermission(getPermissionsForRole("coder"), "shell", "git status")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("coder"), "edit", "src/app.ts")).toBe("deny");
    // Reviewer: shell for inspection, edits denied.
    expect(evaluatePermission(getPermissionsForRole("reviewer"), "shell", "git status")).toBe("allow");
    expect(evaluatePermission(getPermissionsForRole("reviewer"), "edit", "src/app.ts")).toBe("deny");
  });
});
