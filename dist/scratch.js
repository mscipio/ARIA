import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { assertContained, canonicalWorktree, ensureSafeDirectory, safeProjectFile, verifySafeParent, withFileLock, } from "./paths.js";
import { isFilesystemRoot } from "./plan-tool.js";
const execFileAsync = promisify(execFile);
/**
 * T002 — Canonical workspace/scratch policy.
 *
 * All ARIA-controlled generated output (task working state, test fixtures
 * and results, logs, captures, caches, builds, environments, runtime state,
 * experiments) lives under `<canonical-worktree>/scratch/`, never under the
 * ambient temp dir, never under `/home/scratch` staging, and never under a
 * caller-global location. The scratch root is derived from the verified
 * canonical project worktree and every path below it is fail-closed through
 * the `src/paths.ts` guards (`canonicalWorktree`, `ensureSafeDirectory`,
 * `safeProjectFile`, `assertContained`, `verifySafeParent`) plus the
 * filesystem-root sentinel shared with the plan tool (`isFilesystemRoot`):
 * `..` traversal, symlink escapes, filesystem roots, and ambiguous
 * (empty/whitespace) roots are rejected before anything is created.
 *
 * What this module never does:
 * - No process-wide `HOME`/`XDG_*`/`TMPDIR`/`ENGRAM_DATA_DIR` mutation. The
 *   task scope below returns a per-call `env` record only, merged by the
 *   caller into a single `ExecutorOptions.env` (the T011 precedent). Global
 *   config resolution (`~/.config/opencode`, Engram data) is preserved
 *   byte-identical.
 * - No `TMPDIR`-via-executor-env steering. `node:os.tmpdir()` and
 *   `mkdtemp()` read the ambient process environment at call time, so a
 *   per-call env merge does not steer them (TMPDIR-via-executor-env is NOT
 *   proven safe). Callers route temp output through the explicit `tmp`
 *   directory returned here instead.
 * - No migration or deletion of historical artifacts outside `scratch/`.
 *   Pre-existing repo clutter stays untouched; only needed `scratch/`
 *   subdirectories are created.
 * - No staging. `ensureScratchGitignore` never runs `git add`/`git rm` and
 *   never deletes already-tracked `scratch/` paths; tracked content and the
 *   index are left byte-identical.
 *
 * Explicit exceptions (not promised): tools that do not accept explicit
 * output paths or per-call env — hardcoded `~/.cache` writers, absolute
 * `/tmp` writers, and call sites that resolve `os.tmpdir()` ambiently at
 * call time (e.g. the Engram download path in `src/deps.ts`, which cleans up
 * with `finally rm -rf`) — remain ambient until those call sites accept
 * explicit directories. This module provides no OS sandbox (no chroot,
 * mount, or user namespace); containment is path-level fail-closed checks
 * plus explicit-path routing for cooperative operations.
 *
 * Approvals/workflow note: workspace/scratch instructions and RDC approvals
 * remain required but are not OS-sandbox enforcement (the Unix account can
 * still write outside those locations). Increased Visualizer authority under
 * T003 edit/shell parity changes nothing here.
 */
export const SCRATCH_DIR_NAME = "scratch";
export const SCRATCH_GITIGNORE_RULE = "/scratch/";
export const SCRATCH_SUBDIRS = [
    "tmp",
    "tests/fixtures",
    "tests/results",
    "logs",
    "captures/screenshots",
    "captures/videos",
    "caches/npm",
    "caches/pip",
    "caches/python",
    "builds",
    "environments",
    "runtime",
    "experiments",
];
/** Resolve and verify the canonical scratch root for a worktree (fail closed). */
export async function resolveScratchRoot(worktree) {
    if (typeof worktree !== "string" || worktree.trim().length === 0) {
        throw new Error("Scratch policy requires a meaningful project worktree (empty/ambiguous roots rejected)");
    }
    if (isFilesystemRoot(worktree)) {
        throw new Error("Scratch policy rejects filesystem-root worktrees");
    }
    const root = await canonicalWorktree(worktree);
    if (isFilesystemRoot(root)) {
        throw new Error("Scratch policy rejects filesystem-root worktrees (canonical root)");
    }
    const scratch = resolve(root, SCRATCH_DIR_NAME);
    assertContained(root, scratch, "Scratch root");
    return { root, scratch };
}
function validateScopeSegments(scope) {
    if (typeof scope !== "string" || scope.trim().length === 0) {
        throw new Error("Scratch scope cannot be empty");
    }
    const trimmed = scope.trim();
    if (isAbsolute(trimmed)) {
        throw new Error(`Scratch scope escapes the workspace: ${scope}`);
    }
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        throw new Error("Scratch scope cannot be empty");
    }
    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new Error(`Scratch scope escapes the workspace: ${scope}`);
        }
        if (segment.includes("\\") || segment.includes("\0")) {
            throw new Error(`Scratch scope is not a portable path component: ${scope}`);
        }
    }
    return segments;
}
async function resolveScratchDir(root, scratch, scope, create) {
    const segments = validateScopeSegments(scope);
    const candidate = resolve(scratch, ...segments);
    assertContained(scratch, candidate, "Scratch scope");
    assertContained(root, candidate, "Scratch scope");
    return ensureSafeDirectory(root, candidate, create);
}
/** Create the scratch root plus the requested subdirectories (defaults to the full layout). */
export async function ensureScratchDirs(worktree, subdirs = SCRATCH_SUBDIRS) {
    const { root, scratch } = await resolveScratchRoot(worktree);
    await ensureSafeDirectory(root, scratch, true);
    for (const subdir of subdirs) {
        await resolveScratchDir(root, scratch, subdir, true);
    }
    return { root, scratch };
}
function sanitizePrefix(prefix) {
    const cleaned = (prefix ?? "").trim().replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
    const sliced = cleaned.slice(0, 32);
    return sliced.length > 0 ? sliced : "run";
}
/**
 * Create a concurrent-safe unique directory under `scratch/<scope>/` via
 * `mkdtemp` (atomic unique naming; sibling `mkdir` races resolve through
 * the `ensureSafeDirectory` EEXIST path). The scope parent stays inside the
 * verified scratch root; symlink escapes fail closed.
 */
export async function createUniqueScratchDir(worktree, scope, prefix) {
    const { root, scratch } = await resolveScratchRoot(worktree);
    const scopeDir = await resolveScratchDir(root, scratch, scope, true);
    const created = await mkdtemp(join(scopeDir, `${sanitizePrefix(prefix)}-`));
    assertContained(scratch, created, "Scratch directory");
    assertContained(root, created, "Scratch directory");
    return created;
}
function validateTaskId(taskId) {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
        throw new Error("Scratch task id cannot be empty");
    }
    const id = taskId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
        throw new Error(`Scratch task id is not a safe path component: ${taskId}`);
    }
    return id;
}
/** Deterministic per-task directory: `<scratch>/<taskId>/` (created when missing). */
export async function createTaskScratch(worktree, taskId) {
    const id = validateTaskId(taskId);
    const { root, scratch } = await resolveScratchRoot(worktree);
    return resolveScratchDir(root, scratch, id, true);
}
/** Concurrent-safe unique run directory under the per-task directory. */
export async function createTaskRunDir(worktree, taskId, prefix = "run") {
    const id = validateTaskId(taskId);
    return createUniqueScratchDir(worktree, id, prefix);
}
/**
 * Task-scoped directories plus per-call env for ARIA-controlled operations.
 * Route caches, logs, captures, builds, and test outputs through `dirs`
 * (or explicit CLI flags pointed at them); merge `env` per call via
 * `ExecutorOptions.env`. Nothing here touches `process.env`, `HOME`,
 * `XDG_*`, or global config, and atomic sibling-temp + `withFileLock`
 * semantics are preserved by `writeScratchFileAtomically` for file writes.
 *
 * Non-collision layout: every task-owned output (`tmp`, `tests/fixtures`,
 * `tests/results`, `logs`, `captures/*`, `builds`, `environments`,
 * `runtime`, `experiments`) lives beneath the per-task directory
 * (`<scratch>/<taskId>/`), so two distinct task scopes return disjoint
 * task-owned paths and cooperative callers following `ARIA_LOG_DIR`/
 * `ARIA_CAPTURE_DIR`/`ARIA_BUILD_DIR` (and the other `ARIA_*` task env
 * values, which all point beneath `taskDir`) cannot overwrite another
 * task's same-named output. Deliberately shared across tasks (content-
 * addressed caches safe for reuse): `caches/npm`, `caches/pip`,
 * `caches/python` under the scratch root, surfaced as `NPM_CONFIG_CACHE`,
 * `PIP_CACHE_DIR`, and `PYTHONPYCACHEPREFIX`.
 */
export async function scratchTaskScope(worktree, taskId) {
    const id = validateTaskId(taskId);
    const { root, scratch } = await resolveScratchRoot(worktree);
    await ensureSafeDirectory(root, scratch, true);
    const taskDir = await resolveScratchDir(root, scratch, id, true);
    const [tmp, testFixtures, testResults, logs, screenshots, videos, capturesDir, npmCache, pipCache, pythonCache, builds, environments, runtime, experiments] = await Promise.all([
        resolveScratchDir(root, scratch, `${id}/tmp`, true),
        resolveScratchDir(root, scratch, `${id}/tests/fixtures`, true),
        resolveScratchDir(root, scratch, `${id}/tests/results`, true),
        resolveScratchDir(root, scratch, `${id}/logs`, true),
        resolveScratchDir(root, scratch, `${id}/captures/screenshots`, true),
        resolveScratchDir(root, scratch, `${id}/captures/videos`, true),
        resolveScratchDir(root, scratch, `${id}/captures`, true),
        resolveScratchDir(root, scratch, "caches/npm", true),
        resolveScratchDir(root, scratch, "caches/pip", true),
        resolveScratchDir(root, scratch, "caches/python", true),
        resolveScratchDir(root, scratch, `${id}/builds`, true),
        resolveScratchDir(root, scratch, `${id}/environments`, true),
        resolveScratchDir(root, scratch, `${id}/runtime`, true),
        resolveScratchDir(root, scratch, `${id}/experiments`, true),
    ]);
    return {
        root,
        scratch,
        taskDir,
        dirs: {
            tmp,
            testFixtures,
            testResults,
            logs,
            screenshots,
            videos,
            npmCache,
            pipCache,
            pythonCache,
            builds,
            environments,
            runtime,
            experiments,
        },
        env: {
            ARIA_SCRATCH_ROOT: scratch,
            ARIA_SCRATCH_TASK_DIR: taskDir,
            ARIA_SCRATCH_TMP: tmp,
            NPM_CONFIG_CACHE: npmCache,
            PIP_CACHE_DIR: pipCache,
            PYTHONPYCACHEPREFIX: pythonCache,
            ARIA_TEST_RESULTS_DIR: testResults,
            ARIA_TEST_FIXTURES_DIR: testFixtures,
            ARIA_LOG_DIR: logs,
            ARIA_CAPTURE_DIR: capturesDir,
            ARIA_BUILD_DIR: builds,
        },
    };
}
/**
 * Atomically write a file under `scratch/` (path relative to the scratch
 * root, e.g. `logs/run.log`): sibling-temp + `verifySafeParent` + rename,
 * serialized with `withFileLock` like the plan persistence. Paths escaping
 * `scratch/` (absolute, `..`) fail closed; the sibling temp is contained
 * iff the target is contained. Historical files outside `scratch/` are
 * never touched.
 */
export async function writeScratchFileAtomically(worktree, scratchRelativePath, content, options = {}) {
    if (typeof scratchRelativePath !== "string" || scratchRelativePath.trim().length === 0) {
        throw new Error("Scratch file path cannot be empty");
    }
    if (isAbsolute(scratchRelativePath)) {
        throw new Error(`Scratch file path escapes the workspace: ${scratchRelativePath}`);
    }
    const { root, scratch } = await resolveScratchRoot(worktree);
    const candidate = resolve(scratch, scratchRelativePath);
    assertContained(scratch, candidate, "Scratch file path");
    assertContained(root, candidate, "Scratch file path");
    const file = await safeProjectFile(root, relative(root, candidate), { createParent: true });
    assertContained(scratch, file.path, "Scratch file path");
    await withFileLock(file.path, async () => {
        await verifySafeParent(root, file.path);
        const temporaryPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, content, { flag: "wx" });
            await verifySafeParent(root, temporaryPath);
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Operation aborted");
            }
            await rename(temporaryPath, file.path);
        }
        catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }, options.signal);
    return file.path;
}
async function trackedScratchPaths(root) {
    try {
        const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", SCRATCH_DIR_NAME], { cwd: root });
        return stdout
            .split("\0")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    catch {
        return [];
    }
}
/**
 * Ensure exactly one root `/scratch/` rule exists in `<worktree>/.gitignore`:
 * append it when missing, collapse exact duplicates to the first occurrence,
 * and otherwise preserve every existing rule byte-identical. The write is
 * atomic (sibling-temp + rename). Already-tracked `scratch/` paths are
 * detected via `git ls-files` and reported; their contents and the git index
 * are left untouched (never staged, never removed).
 */
export async function ensureScratchGitignore(worktree) {
    const { root } = await resolveScratchRoot(worktree);
    const gitignorePath = resolve(root, ".gitignore");
    assertContained(root, gitignorePath, "Gitignore path");
    let existing;
    try {
        existing = await readFile(gitignorePath, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const isRule = (line) => line.trim() === SCRATCH_GITIGNORE_RULE;
    let next;
    let added = false;
    let deduped = false;
    if (existing === undefined || existing === "") {
        next = `${SCRATCH_GITIGNORE_RULE}\n`;
        added = true;
    }
    else {
        const lines = existing.split("\n");
        const count = lines.filter(isRule).length;
        if (count === 0) {
            added = true;
            next = existing.endsWith("\n") ? `${existing}${SCRATCH_GITIGNORE_RULE}\n` : `${existing}\n${SCRATCH_GITIGNORE_RULE}\n`;
        }
        else if (count === 1) {
            next = existing;
        }
        else {
            deduped = true;
            let kept = false;
            next = lines
                .filter((line) => {
                if (!isRule(line))
                    return true;
                if (!kept) {
                    kept = true;
                    return true;
                }
                return false;
            })
                .join("\n");
        }
    }
    if (next !== existing) {
        const temporaryPath = `${gitignorePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, next, { encoding: "utf8", flag: "wx" });
            await verifySafeParent(root, temporaryPath);
            await rename(temporaryPath, gitignorePath);
        }
        catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
    return { gitignorePath, added, deduped, tracked: await trackedScratchPaths(root) };
}
//# sourceMappingURL=scratch.js.map