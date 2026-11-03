import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentFiles } from "../src/agents.js";
import { resolveAriaConfig } from "../src/overrides.js";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions.js";
import { randomUUID } from "node:crypto";
import { allocatePlanExecutionDir, allocateUnplannedExecutionDir, resolveScratchRoot } from "../src/scratch.js";

// T004 — workspace execution policy integration.
//
// Canonical source is `src/scratch.ts` (via `src/paths.ts` guards); every
// reference below is a concise pointer, never a duplicated path check. All
// artifacts this suite creates live under the repo .aria/scratch/ tree.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchWorktree(name: string): Promise<string> {
  const dir = await allocateUnplannedExecutionDir(REPO_ROOT, name);
  managed.push(dir);
  return dir;
}

describe("T004 workspace execution policy integration", () => {
  it("survives generation: shared guidance reaches every MCP-role agent file", async () => {
    const worktree = await scratchWorktree("policy-gen");
    const resolved = resolveAriaConfig(worktree);
    for (const role of ["coder", "explorer", "visualizer", "planner", "implementer", "reviewer"] as const) {
      expect(resolved.roles[role].promptText, `${role} prompt carries the policy`).toContain("src/scratch.ts");
    }
    const files = generateAgentFiles(resolved, "9.9.9");
    for (const role of ["coder", "explorer", "visualizer", "planner", "implementer", "reviewer"] as const) {
      expect(files[role], `${role} generated file carries the policy`).toContain("src/scratch.ts");
    }
    const effectiveInstructions = `${resolved.roles.implementer.promptText}\n${files.implementer}`;
    // Authorized edits to repository source remain in scope; scratch only
    // confines transient/generated output and is never a staging location.
    expect(effectiveInstructions).toContain("does not restrict intentional edits to authorized repository code");
    expect(effectiveInstructions).toContain("confine transient/generated artifacts");
    expect(effectiveInstructions).toContain("scratch artifacts are never staged");
    expect(effectiveInstructions).toContain("human authorization");
    expect(effectiveInstructions).toContain("editing files does not authorize staging");
    // Non-MCP roles keep their own prompts (no shared MCP block) but carry a
    // concise confinement pointer where delegation/confinement is relevant.
    for (const role of ["scientist", "researcher", "writer", "archivist"] as const) {
      expect(resolved.roles[role].promptText, `${role} prompt carries a confinement pointer`).toContain("src/scratch.ts");
    }
  });

  it("survives handoff: child-task instructions forbid bypass by asking another agent", async () => {
    const worktree = await scratchWorktree("policy-handoff");
    const resolved = resolveAriaConfig(worktree);
    expect(resolved.roles.coder.promptText).toContain("Delegation cannot expand authorization");
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
    const worktree = await scratchWorktree("policy-modes");
    await expect(allocatePlanExecutionDir(worktree, "../escape", "T004")).rejects.toThrow();
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T004");
    expect(dir.startsWith(resolve((await resolveScratchRoot(worktree)).scratch))).toBe(true);
  });

  it("leaves no artifacts outside .aria/scratch/ and creates no subdirectories on allocation", async () => {
    const worktree = await scratchWorktree("policy-placed");
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T004");
    expect(await readdir(dir)).toEqual([]);
    expect(resolve(dir).startsWith(resolve(worktree, ".aria", "scratch"))).toBe(true);
  });
});
