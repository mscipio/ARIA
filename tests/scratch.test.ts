import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  SCRATCH_GITIGNORE_RULE,
  allocatePlanExecutionDir,
  allocateUnplannedExecutionDir,
  ensureScratchGitignore,
  formatScratchTimestamp,
  resolveExecutionDir,
  resolveScratchRoot,
  writeExecutionFileAtomically,
} from "../src/scratch.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Test worktrees are unplanned execution directories inside the repo's own scratch. */
async function fixtureWorktree(name: string): Promise<string> {
  const dir = await allocateUnplannedExecutionDir(REPO_ROOT, `vitest-${name}`);
  managed.push(dir);
  return dir;
}

async function gitCheckIgnore(root: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", path], { cwd: root });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

const PLAN_EXECUTION = /^[0-9a-f-]{36}\/T\d{3}\/\d{8}-\d{6}(?:-[a-f0-9]{6})?$/;
const UNPLANNED_EXECUTION = /^unplanned\/\d{8}-\d{6}-[a-z0-9-]+(?:-[a-f0-9]{6})?$/;

describe("scratch layout: exactly two allocation categories", () => {
  it("allocates planned executions as <plan-id>/<task-id>/<timestamp>/ with no pre-created subdirectories", async () => {
    const worktree = await fixtureWorktree("planned-layout");
    const { scratch } = await resolveScratchRoot(worktree);
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T001");
    expect(relative(scratch, dir)).toMatch(PLAN_EXECUTION);
    expect(await readdir(dir)).toEqual([]);
  });

  it("serves two plan IDs, several tasks, and repeated allocations of one task without collisions", async () => {
    const worktree = await fixtureWorktree("two-plans");
    const { scratch } = await resolveScratchRoot(worktree);
    const planA = randomUUID();
    const planB = randomUUID();
    const dirs = [
      await allocatePlanExecutionDir(worktree, planA, "T001"),
      await allocatePlanExecutionDir(worktree, planA, "T001"),
      await allocatePlanExecutionDir(worktree, planA, "T002"),
      await allocatePlanExecutionDir(worktree, planB, "T001"),
    ];
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(relative(scratch, dirs[0]!).startsWith(`${planA}/T001/`)).toBe(true);
    expect(relative(scratch, dirs[2]!).startsWith(`${planA}/T002/`)).toBe(true);
    expect(relative(scratch, dirs[3]!).startsWith(`${planB}/T001/`)).toBe(true);
    expect(await readdir(join(scratch, planA, "T001"))).toHaveLength(2);
  });

  it("allocates concurrent executions for the same task, including forced timestamp collisions", async () => {
    const worktree = await fixtureWorktree("concurrent");
    const planId = randomUUID();
    const dirs = await Promise.all(Array.from({ length: 12 }, () => allocatePlanExecutionDir(worktree, planId, "T003")));
    expect(new Set(dirs).size).toBe(12);
    for (const dir of dirs) expect((await lstat(dir)).isDirectory()).toBe(true);
  });

  it("allocates unplanned executions as unplanned/<timestamp>-<description>/", async () => {
    const worktree = await fixtureWorktree("unplanned-layout");
    const { scratch } = await resolveScratchRoot(worktree);
    const dir = await allocateUnplannedExecutionDir(worktree, "Native Fast Path Check!");
    expect(relative(scratch, dir)).toMatch(/^unplanned\/\d{8}-\d{6}-native-fast-path-check(?:-[a-f0-9]{6})?$/);
    const again = await allocateUnplannedExecutionDir(worktree, "Native Fast Path Check!");
    expect(again).not.toBe(dir);
  });

  it("allocates Playwright MCP output in unplanned/ with a playwright-mcp description", async () => {
    const worktree = await fixtureWorktree("playwright-output");
    const { scratch } = await resolveScratchRoot(worktree);
    const dir = await allocateUnplannedExecutionDir(worktree, "playwright-mcp");
    expect(relative(scratch, dir)).toMatch(/^unplanned\/\d{8}-\d{6}-playwright-mcp(?:-[a-f0-9]{6})?$/);
  });

  it("uses a local YYYYMMDD-HHMMSS timestamp", () => {
    expect(formatScratchTimestamp(new Date(2026, 10, 3, 14, 30, 25))).toBe("20261103-143025");
  });
});

describe("execution directory acceptance and on-demand writes", () => {
  it("accepts exactly the two execution shapes and rejects namespace roots, parents, and outside paths", async () => {
    const worktree = await fixtureWorktree("shape-checks");
    const planId = randomUUID();
    const planDir = await allocatePlanExecutionDir(worktree, planId, "T004");
    const unplanned = await allocateUnplannedExecutionDir(worktree, "shape");
    expect((await resolveExecutionDir(worktree, planDir)).kind).toBe("plan");
    expect((await resolveExecutionDir(worktree, unplanned)).kind).toBe("unplanned");

    const { scratch } = await resolveScratchRoot(worktree);
    await expect(resolveExecutionDir(worktree, join(scratch, planId, "T004"))).rejects.toThrow(/Not a scratch execution directory/);
    await expect(resolveExecutionDir(worktree, join(scratch, planId))).rejects.toThrow(/Not a scratch execution directory/);
    await expect(resolveExecutionDir(worktree, join(scratch, "unplanned"))).rejects.toThrow(/Not a scratch execution directory/);
    await expect(resolveExecutionDir(worktree, scratch)).rejects.toThrow(/Not a scratch execution directory/);
    await expect(resolveExecutionDir(worktree, join(scratch, "fast-path", "2026-11-03", "x"))).rejects.toThrow(/Not a scratch execution directory/);
    await expect(resolveExecutionDir(worktree, join(scratch, planId, "T004", "missing-20261103-000000"))).rejects.toThrow();
    await expect(resolveExecutionDir(worktree, join(worktree, "..", "elsewhere"))).rejects.toThrow(/escapes|Not a scratch/);
  });

  it("writes a file inside an execution directory, creating only that file's parents", async () => {
    const worktree = await fixtureWorktree("on-demand");
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T005");
    expect(await readdir(dir)).toEqual([]);
    const written = await writeExecutionFileAtomically(worktree, dir, "logs/nested/run.log", "hello\n");
    expect(written).toBe(join(dir, "logs", "nested", "run.log"));
    expect(await readFile(written, "utf8")).toBe("hello\n");
    expect(await readdir(dir)).toEqual(["logs"]);
    expect((await readdir(join(dir, "logs", "nested"))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects writes that escape the execution directory or name the directory itself", async () => {
    const worktree = await fixtureWorktree("write-escape");
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T006");
    await expect(writeExecutionFileAtomically(worktree, dir, "../evil.txt", "x")).rejects.toThrow(/escapes/);
    await expect(writeExecutionFileAtomically(worktree, dir, "/tmp/evil.txt", "x")).rejects.toThrow(/relative path/);
    await expect(writeExecutionFileAtomically(worktree, dir, ".", "x")).rejects.toThrow();
    await expect(writeExecutionFileAtomically(worktree, dir, "", "x")).rejects.toThrow(/relative path/);
  });
});

describe("negative checks", () => {
  it("rejects malformed plan and task identifiers before any directory is created", async () => {
    const worktree = await fixtureWorktree("bad-identifiers");
    const { scratch } = await resolveScratchRoot(worktree);
    const planId = randomUUID();
    await expect(allocatePlanExecutionDir(worktree, "../x", "T001")).rejects.toThrow(/lowercase UUIDv4/);
    await expect(allocatePlanExecutionDir(worktree, planId.toUpperCase(), "T001")).rejects.toThrow(/lowercase UUIDv4/);
    await expect(allocatePlanExecutionDir(worktree, "00000000-0000-1000-8000-000000000000", "T001")).rejects.toThrow(/lowercase UUIDv4/);
    await expect(allocatePlanExecutionDir(worktree, planId, "T1")).rejects.toThrow(/plan task path component/);
    await expect(allocatePlanExecutionDir(worktree, planId, "T001/../../x")).rejects.toThrow(/plan task path component/);
    await expect(lstat(join(scratch, planId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an empty unplanned description and traversal in it", async () => {
    const worktree = await fixtureWorktree("bad-description");
    await expect(allocateUnplannedExecutionDir(worktree, "!!!")).rejects.toThrow(/at least one letter or digit/);
    await expect(allocateUnplannedExecutionDir(worktree, "")).rejects.toThrow(/at least one letter or digit/);
    const dir = await allocateUnplannedExecutionDir(worktree, "../../etc");
    const { scratch } = await resolveScratchRoot(worktree);
    expect(relative(scratch, dir).startsWith("unplanned/")).toBe(true);
    expect(relative(scratch, dir).includes("..")).toBe(false);
  });

  it("rejects symlinked scratch components and a symlinked .aria, never following them", async () => {
    const outside = await fixtureWorktree("symlink-target");
    const planId = randomUUID();

    const withLink = await fixtureWorktree("symlink-plan-component");
    await mkdir(join(withLink, ".aria", "scratch", planId), { recursive: true });
    await symlink(outside, join(withLink, ".aria", "scratch", planId, "T001"));
    await expect(allocatePlanExecutionDir(withLink, planId, "T001")).rejects.toThrow(/safe directory/);

    const ariaLink = await fixtureWorktree("symlink-aria-root");
    await rm(join(ariaLink, ".aria"), { recursive: true, force: true }).catch(() => undefined);
    await symlink(join(outside, ".."), join(ariaLink, ".aria"));
    await expect(allocatePlanExecutionDir(ariaLink, planId, "T001")).rejects.toThrow();
    await expect(allocateUnplannedExecutionDir(ariaLink, "symlink")).rejects.toThrow();
  });

  it("rejects filesystem-root and empty worktrees", async () => {
    await expect(resolveScratchRoot("/")).rejects.toThrow(/filesystem-root/);
    await expect(resolveScratchRoot("   ")).rejects.toThrow(/meaningful project worktree/);
    await expect(allocatePlanExecutionDir("", randomUUID(), "T001")).rejects.toThrow(/meaningful project worktree/);
    await expect(allocateUnplannedExecutionDir("/", "x")).rejects.toThrow(/filesystem-root/);
  });

  it("never moves, deletes, or touches historical ./scratch/ content", async () => {
    const worktree = await fixtureWorktree("historical-untouched");
    const legacy = join(worktree, "scratch", "history");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "old-output.txt"), "keep me\n");
    await allocatePlanExecutionDir(worktree, randomUUID(), "T007");
    await allocateUnplannedExecutionDir(worktree, "history check");
    expect(await readFile(join(legacy, "old-output.txt"), "utf8")).toBe("keep me\n");
    expect(await readdir(join(worktree, "scratch"))).toEqual(["history"]);
  });
});

describe("Git ignore behavior", () => {
  it("keeps exactly one managed /.aria/scratch/ rule and preserves existing rules byte-identical", async () => {
    const existing = await fixtureWorktree("gitignore-existing");
    await writeFile(join(existing, ".gitignore"), "node_modules/\n*.log\n");
    const first = await ensureScratchGitignore(existing);
    expect(first.added).toBe(true);
    const afterFirst = await readFile(first.gitignorePath, "utf8");
    expect(afterFirst).toBe(`node_modules/\n*.log\n${SCRATCH_GITIGNORE_RULE}\n`);
    const second = await ensureScratchGitignore(existing);
    expect(second.added).toBe(false);
    expect(await readFile(second.gitignorePath, "utf8")).toBe(afterFirst);
  });

  it("ignores real nested scratch paths while keeping plan files versionable (repo .gitignore)", async () => {
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(gitignore.split("\n").filter((line) => line === "/.aria/scratch/")).toHaveLength(1);
    expect(gitignore.split("\n")).toContain("/scratch/");
    expect(gitignore).toContain("!/.aria/plans/");

    const planId = randomUUID();
    expect(await gitCheckIgnore(REPO_ROOT, `.aria/scratch/${planId}/T001/20261103-143025/logs/run.log`)).toBe(true);
    expect(await gitCheckIgnore(REPO_ROOT, `.aria/scratch/unplanned/20261103-143025-x/out.txt`)).toBe(true);
    expect(await gitCheckIgnore(REPO_ROOT, `scratch/historical.txt`)).toBe(true);
    expect(await gitCheckIgnore(REPO_ROOT, `.aria/rdc/TASKS.md`)).toBe(true);
    expect(await gitCheckIgnore(REPO_ROOT, `.aria/plans/${planId}.md`)).toBe(false);
    expect(await gitCheckIgnore(REPO_ROOT, `.aria/plans/nested/${planId}.md`)).toBe(false);
  });

  it("reports tracked scratch paths without staging or changing the index", async () => {
    const worktree = await fixtureWorktree("gitignore-tracked");
    await execFileAsync("git", ["init", "-q"], { cwd: worktree });
    const dir = await allocatePlanExecutionDir(worktree, randomUUID(), "T008");
    await writeExecutionFileAtomically(worktree, dir, "tracked.txt", "tracked\n");
    const tracked = join(dir, "tracked.txt");
    await execFileAsync("git", ["add", "-f", "--", tracked], { cwd: worktree });
    const before = (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: worktree })).stdout;
    const result = await ensureScratchGitignore(worktree);
    const after = (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: worktree })).stdout;
    expect(result.tracked.some((entry) => entry.endsWith("tracked.txt"))).toBe(true);
    expect(after).toBe(before);
  });
});
