import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  SCRATCH_GITIGNORE_RULE,
  SCRATCH_SUBDIRS,
  createTaskRunDir,
  createTaskScratch,
  createUniqueScratchDir,
  ensureScratchDirs,
  ensureScratchGitignore,
  resolveScratchRoot,
  scratchTaskScope,
  writeScratchFileAtomically,
} from "../src/scratch.js";

const execFileAsync = promisify(nodeExecFile);

// T002: every artifact this suite creates lives under the repo ./scratch/
// tree (which the new /scratch/ gitignore rule keeps untracked). No /tmp,
// no /home/scratch, no HOME/XDG staging: worktrees are unique scratch
// subdirectories, and nothing here mutates process.env.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureWorktree(name: string): Promise<string> {
  const dir = await createUniqueScratchDir(REPO_ROOT, "tests/fixtures", name);
  managed.push(dir);
  return dir;
}

function containedUnder(scratch: string, candidate: string): boolean {
  const child = relative(scratch, candidate);
  return child.length > 0 && !child.startsWith(`..${sep}`) && child !== "..";
}

describe("T002 workspace/scratch policy", () => {
  it("creates the canonical layout under repo, subdir, and nested worktrees", async () => {
    const repoLayout = await ensureScratchDirs(REPO_ROOT);
    expect(repoLayout.scratch).toBe(resolve(repoLayout.root, "scratch"));
    for (const subdir of SCRATCH_SUBDIRS) {
      const info = await lstat(join(repoLayout.scratch, ...subdir.split("/")));
      expect(info.isDirectory()).toBe(true);
    }

    const outer = await fixtureWorktree("layout");
    const nested = join(outer, "proj", "nested");
    await mkdir(nested, { recursive: true });
    const nestedLayout = await ensureScratchDirs(nested);
    expect(nestedLayout.scratch).toBe(resolve(nestedLayout.root, "scratch"));
    const probe = await writeScratchFileAtomically(nested, "logs/run.log", "hello\n");
    expect(probe).toBe(join(nestedLayout.scratch, "logs", "run.log"));
    expect(await readFile(probe, "utf8")).toBe("hello\n");
  });

  it("rejects traversal, symlink escapes, filesystem roots, and ambiguous roots", async () => {
    await expect(resolveScratchRoot("")).rejects.toThrow(/meaningful project worktree/);
    await expect(resolveScratchRoot("   ")).rejects.toThrow(/meaningful project worktree/);
    await expect(resolveScratchRoot("/")).rejects.toThrow(/filesystem-root/);

    const worktree = await fixtureWorktree("reject");
    await expect(createUniqueScratchDir(worktree, "../escape", "x")).rejects.toThrow(/escapes the workspace/);
    await expect(createUniqueScratchDir(worktree, "/absolute", "x")).rejects.toThrow(/escapes the workspace/);
    await expect(writeScratchFileAtomically(worktree, "../evil.txt", "x")).rejects.toThrow(/escapes the (workspace|project worktree)/);
    await expect(writeScratchFileAtomically(worktree, "/evil.txt", "x")).rejects.toThrow(/escapes the workspace/);
    await expect(createTaskScratch(worktree, "../x")).rejects.toThrow(/safe path component/);
    await expect(createTaskScratch(worktree, "a/b")).rejects.toThrow(/safe path component/);
    await expect(scratchTaskScope(worktree, "")).rejects.toThrow();

    // Symlink escape: a scratch scope that is a symlink to outside the
    // worktree fails closed instead of writing through it.
    const outside = await fixtureWorktree("outside");
    const { scratch } = await ensureScratchDirs(worktree);
    const link = join(scratch, "tmp");
    await rm(link, { recursive: true, force: true });
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(createUniqueScratchDir(worktree, "tmp", "run")).rejects.toThrow(/safe directory/);

    // Symlink-to-root worktree is a filesystem root in disguise.
    const rootLink = join(worktree, "rootlink");
    await symlink("/", rootLink, "junction").catch(() => undefined);
    const stat = await lstat(rootLink).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      await expect(resolveScratchRoot(rootLink)).rejects.toThrow(/filesystem-root/);
    }
  });

  it("creates concurrent-safe noncolliding directories per task", async () => {
    const worktree = await fixtureWorktree("collide");
    const taskDir = await createTaskScratch(worktree, "task-p2");
    expect(taskDir).toBe(join((await resolveScratchRoot(worktree)).scratch, "task-p2"));
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => createTaskRunDir(worktree, "task-p2", "run")),
    );
    expect(new Set(runs).size).toBe(8);
    for (const run of runs) {
      expect(containedUnder(taskDir, run)).toBe(true);
      expect((await lstat(run)).isDirectory()).toBe(true);
    }
  });

  it("keeps task-owned outputs disjoint across task scopes while caches stay shared", async () => {
    const worktree = await fixtureWorktree("disjoint");
    const scopeA = await scratchTaskScope(worktree, "task-a");
    const scopeB = await scratchTaskScope(worktree, "task-b");
    expect(scopeA.taskDir).not.toBe(scopeB.taskDir);
    const ownedA = [
      scopeA.dirs.tmp,
      scopeA.dirs.testFixtures,
      scopeA.dirs.testResults,
      scopeA.dirs.logs,
      scopeA.dirs.screenshots,
      scopeA.dirs.videos,
      scopeA.dirs.builds,
      scopeA.dirs.environments,
      scopeA.dirs.runtime,
      scopeA.dirs.experiments,
    ];
    const ownedB = [
      scopeB.dirs.tmp,
      scopeB.dirs.testFixtures,
      scopeB.dirs.testResults,
      scopeB.dirs.logs,
      scopeB.dirs.screenshots,
      scopeB.dirs.videos,
      scopeB.dirs.builds,
      scopeB.dirs.environments,
      scopeB.dirs.runtime,
      scopeB.dirs.experiments,
    ];
    for (const dir of ownedA) {
      expect(containedUnder(scopeA.taskDir, dir)).toBe(true);
      expect((await lstat(dir)).isDirectory()).toBe(true);
    }
    for (const dir of ownedB) {
      expect(containedUnder(scopeB.taskDir, dir)).toBe(true);
      expect((await lstat(dir)).isDirectory()).toBe(true);
    }
    // No task-owned path is shared between the two scopes.
    expect(new Set([...ownedA.map((p) => resolve(p)), ...ownedB.map((p) => resolve(p))]).size).toBe(
      ownedA.length + ownedB.length,
    );
    // Task-facing env outputs are task-owned too: disjoint and under taskDir.
    const taskEnvKeys = [
      "ARIA_SCRATCH_TMP",
      "ARIA_TEST_RESULTS_DIR",
      "ARIA_TEST_FIXTURES_DIR",
      "ARIA_LOG_DIR",
      "ARIA_CAPTURE_DIR",
      "ARIA_BUILD_DIR",
    ] as const;
    for (const key of taskEnvKeys) {
      expect(resolve(scopeA.env[key]!)).not.toBe(resolve(scopeB.env[key]!));
      expect(containedUnder(scopeA.taskDir, scopeA.env[key]!)).toBe(true);
      expect(containedUnder(scopeB.taskDir, scopeB.env[key]!)).toBe(true);
    }
    expect(resolve(scopeA.env.ARIA_SCRATCH_TASK_DIR!)).not.toBe(resolve(scopeB.env.ARIA_SCRATCH_TASK_DIR!));
    // Deliberately shared content-addressed caches stay shared.
    expect(resolve(scopeA.dirs.npmCache)).toBe(resolve(scopeB.dirs.npmCache));
    expect(resolve(scopeA.dirs.pipCache)).toBe(resolve(scopeB.dirs.pipCache));
    expect(resolve(scopeA.dirs.pythonCache)).toBe(resolve(scopeB.dirs.pythonCache));
  });

  it("keeps every scratch path and task env under ./scratch/, leaving outside files alone", async () => {
    const worktree = await fixtureWorktree("placed");
    const sentinel = join(worktree, "sentinel-outside.txt");
    await writeFile(sentinel, "do not touch\n");
    const scope = await scratchTaskScope(worktree, "task-p2");
    const paths = [
      scope.scratch,
      scope.taskDir,
      ...Object.values(scope.dirs),
      ...Object.values(scope.env),
    ];
    for (const candidate of paths) {
      expect(containedUnder(scope.scratch, candidate) || resolve(candidate) === resolve(scope.scratch)).toBe(true);
      expect(resolve(candidate).startsWith(`${scope.root}${sep}`)).toBe(true);
    }
    // No HOME/XDG/global-config steering in the per-call env.
    for (const key of Object.keys(scope.env)) {
      expect(["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "ENGRAM_DATA_DIR", "TMPDIR"]).not.toContain(
        key,
      );
    }
    const written = await writeScratchFileAtomically(worktree, "tests/results/out.json", "{}\n");
    expect(containedUnder(scope.scratch, written)).toBe(true);
    expect(await readdir(join(scope.scratch, "tests", "results"))).toContain("out.json");
    expect(await readFile(sentinel, "utf8")).toBe("do not touch\n");
  });

  it("keeps exactly one /scratch/ rule while preserving existing rules", async () => {
    const missing = await fixtureWorktree("ignore-missing");
    const created = await ensureScratchGitignore(missing);
    expect(created.added).toBe(true);
    expect(await readFile(created.gitignorePath, "utf8")).toBe(`${SCRATCH_GITIGNORE_RULE}\n`);

    const existing = await fixtureWorktree("ignore-existing");
    const original = "node_modules/\n*.log";
    await writeFile(join(existing, ".gitignore"), original);
    const first = await ensureScratchGitignore(existing);
    expect(first.added).toBe(true);
    const afterFirst = await readFile(join(existing, ".gitignore"), "utf8");
    expect(afterFirst.startsWith(original)).toBe(true);
    expect(afterFirst.match(new RegExp(`^${SCRATCH_GITIGNORE_RULE}$`, "gm"))).toHaveLength(1);

    const second = await ensureScratchGitignore(existing);
    expect(second.added).toBe(false);
    expect(second.deduped).toBe(false);
    expect(await readFile(join(existing, ".gitignore"), "utf8")).toBe(afterFirst);

    const dupes = await fixtureWorktree("ignore-dupes");
    await writeFile(join(dupes, ".gitignore"), `a\n${SCRATCH_GITIGNORE_RULE}\nb\n${SCRATCH_GITIGNORE_RULE}\n`);
    const deduped = await ensureScratchGitignore(dupes);
    expect(deduped.deduped).toBe(true);
    expect(await readFile(join(dupes, ".gitignore"), "utf8")).toBe(`a\n${SCRATCH_GITIGNORE_RULE}\nb\n`);
  });

  it("keeps the repo .gitignore to a single /scratch/ rule (read-only)", async () => {
    const content = await readFile(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(content.match(new RegExp(`^${SCRATCH_GITIGNORE_RULE}$`, "gm"))).toHaveLength(1);
  });

  it("preserves already-tracked scratch paths with an unchanged index and no staging", async () => {
    const worktree = await fixtureWorktree("tracked");
    await execFileAsync("git", ["init", "-q"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "aria-test@example.com"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.name", "aria-test"], { cwd: worktree });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: worktree });
    await writeFile(join(worktree, ".gitignore"), "node_modules/\n");
    const keepDir = join(worktree, "scratch", "logs");
    await mkdir(keepDir, { recursive: true });
    await writeFile(join(keepDir, "keep.txt"), "v1\n");
    await execFileAsync("git", ["add", "scratch/logs/keep.txt"], { cwd: worktree });
    await execFileAsync("git", ["commit", "-qm", "track scratch file"], { cwd: worktree });

    const statusBefore = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: worktree })).stdout;
    const indexBefore = (await execFileAsync("git", ["ls-files", "-s"], { cwd: worktree })).stdout;

    const result = await ensureScratchGitignore(worktree);
    expect(result.tracked).toContain(join("scratch", "logs", "keep.txt"));
    expect(await readFile(join(keepDir, "keep.txt"), "utf8")).toBe("v1\n");
    expect((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: worktree })).stdout).toBe(statusBefore);
    expect((await execFileAsync("git", ["ls-files", "-s"], { cwd: worktree })).stdout).toBe(indexBefore);
  });
});
