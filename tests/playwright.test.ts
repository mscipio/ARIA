import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePlaywrightRuntimeOutput } from "../src/playwright-launch.js";
import { evaluatePermission, getArchivistScopedPermissions, getPermissionsForRole } from "../src/permissions.js";
import { createUniqueScratchDir } from "../src/scratch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureWorktree(name: string): Promise<string> {
  const fixtureRoot = process.env.ARIA_TEST_FIXTURE_ROOT ?? tmpdir();
  const path = await createUniqueScratchDir(fixtureRoot, "worktrees", name);
  fixtures.push(path);
  return path;
}

describe("accepted Playwright integration boundaries", () => {
  it("routes automatic output to workspace scratch without Plan/task selection", async () => {
    const contexts: Array<{ name: string; plan?: string }> = [
      { name: "no-plan" },
      { name: "unapproved-zero", plan: "approval: pending\ntasks: []\n" },
      { name: "approved-one", plan: "approval: approved\ntasks: [T001 in_progress]\n" },
      { name: "approved-multiple", plan: "approval: approved\ntasks: [T001 in_progress, T002 in_progress]\n" },
    ];

    for (const context of contexts) {
      const worktree = await fixtureWorktree(`playwright-${context.name}`);
      const planPath = join(worktree, ".aria", "rdc", "TASKS.md");
      if (context.plan !== undefined) {
        await mkdir(dirname(planPath), { recursive: true });
        await writeFile(planPath, context.plan);
      }

      const output = await resolvePlaywrightRuntimeOutput(worktree);
      const outputRelative = relative(worktree, output);
      expect(outputRelative).toMatch(/^scratch\/\d{4}-\d{2}-\d{2}\/\d{6}-playwright-mcp(?:-\d+)?$/);
      if (context.plan !== undefined) expect(await readFile(planPath, "utf8")).toBe(context.plan);
    }
  });

  it("allows browser navigation/screenshots only for Visualizer, including scoped Archivist", () => {
    const priorWikiDir = process.env.WIKI_DIR;
    process.env.WIKI_DIR = join(REPO_ROOT, "wiki");
    try {
      const roles = [
        "coder", "explorer", "visualizer", "planner", "implementer",
        "reviewer", "researcher", "archivist", "writer", "scientist",
      ] as const;
      for (const action of ["playwright_browser_navigate", "playwright_browser_take_screenshot"]) {
        for (const role of roles) {
          expect(evaluatePermission(getPermissionsForRole(role), action, "*")).toBe(role === "visualizer" ? "allow" : "deny");
        }
        expect(evaluatePermission(getArchivistScopedPermissions(REPO_ROOT), action, "*")).toBe("deny");
      }
    } finally {
      if (priorWikiDir === undefined) delete process.env.WIKI_DIR;
      else process.env.WIKI_DIR = priorWikiDir;
    }
  });
});
