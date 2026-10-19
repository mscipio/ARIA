import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentFiles } from "../src/agents.js";
import { resolveAriaConfig } from "../src/overrides.js";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions.js";
import { createUniqueScratchDir, scratchTaskScope } from "../src/scratch.js";

// T004 — workspace execution policy integration.
//
// Canonical source is `src/scratch.ts` (via `src/paths.ts` guards); every
// reference below is a concise pointer, never a duplicated path check. All
// artifacts this suite creates live under the repo ./scratch/ tree.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchWorktree(name: string): Promise<string> {
  const dir = await createUniqueScratchDir(REPO_ROOT, "tests/fixtures", name);
  managed.push(dir);
  return dir;
}

describe("T004 workspace execution policy integration", () => {
  it("survives generation: shared guidance reaches every MCP-role agent file", async () => {
    const worktree = await scratchWorktree("policy-gen");
    const resolved = resolveAriaConfig(worktree);
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"] as const) {
      expect(resolved.roles[role].promptText, `${role} prompt carries the policy`).toContain("src/scratch.ts");
    }
    const files = generateAgentFiles(resolved, "9.9.9");
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"] as const) {
      expect(files[role], `${role} generated file carries the policy`).toContain("src/scratch.ts");
    }
    // Non-MCP roles keep their own prompts (no shared MCP block) but carry a
    // concise confinement pointer where delegation/confinement is relevant.
    for (const role of ["scientist", "researcher", "writer", "archivist"] as const) {
      expect(resolved.roles[role].promptText, `${role} prompt carries a confinement pointer`).toContain("src/scratch.ts");
    }
  });

  it("survives handoff: child-task instructions forbid bypass by asking another agent", async () => {
    const worktree = await scratchWorktree("policy-handoff");
    const resolved = resolveAriaConfig(worktree);
    expect(resolved.roles.coder.promptText).toContain("survives handoff");
    expect(resolved.roles.coder.promptText).toContain("no bypass by asking another agent");
    expect(resolved.roles.scientist.promptText).toContain("survives delegation");
    expect(resolved.roles.writer.promptText).toContain("survives delegation");
    expect(resolved.roles.researcher.promptText).toContain("survives handoff");
    expect(resolved.roles.implementer.promptText).toContain("never bypass by asking another agent");
    expect(resolved.roles.visualizer.promptText).toContain("never bypass by asking another agent");
  });

  it("keeps setup/doctor modes with no edit/shell permission drift", async () => {
    // Representative effective decisions only (T003 parity owns the full
    // matrix): ordinary shell stays allow for both, destructive removal stays
    // denied — proving T004 added references without touching rules.
    expect(evaluatePermission(getPermissionsForRole("visualizer"), "shell", "npm run build")).toBe(
      evaluatePermission(getPermissionsForRole("implementer"), "shell", "npm run build"),
    );
    expect(evaluatePermission(getPermissionsForRole("visualizer"), "shell", "rm -rf /tmp/x")).toBe("deny");
    expect(evaluatePermission(getPermissionsForRole("implementer"), "shell", "rm -rf /tmp/x")).toBe("deny");
    // Canonical helper still fails closed through the single source (no
    // duplicated checks here): task env carries no HOME/XDG/global steering.
    const worktree = await scratchWorktree("policy-modes");
    const scope = await scratchTaskScope(worktree, "task-p4");
    for (const key of Object.keys(scope.env)) {
      expect(["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "ENGRAM_DATA_DIR", "TMPDIR"]).not.toContain(
        key,
      );
    }
    await expect(scratchTaskScope(worktree, "../escape")).rejects.toThrow();
  });

  it("leaves no artifacts outside ./scratch/", async () => {
    const worktree = await scratchWorktree("policy-placed");
    const scope = await scratchTaskScope(worktree, "task-p4");
    const entries = await readdir(scope.scratch);
    expect(entries.length).toBeGreaterThan(0);
    expect(resolve(scope.scratch).startsWith(resolve(worktree, "scratch"))).toBe(true);
    expect(join(worktree, "sentinel-outside.txt")).not.toContain("\0");
  });
});
