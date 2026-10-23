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
  * - Scratch confinement applies only to transient/generated artifacts (logs,
  *   fixtures, temporary outputs, verification evidence, etc.), not intentional
  *   edits to authorized repository code, tests, configuration, or documentation.
  *   Scratch artifacts are never staged. `ensureScratchGitignore` never runs
  *   `git add`/`git rm` and never deletes already-tracked `scratch/` paths;
  *   tracked content and the index are left byte-identical. Staging explicitly
  *   approved source changes is permitted only during human-authorized Git
  *   operations; editing files does not itself authorize staging.
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
export declare const SCRATCH_DIR_NAME = "scratch";
export declare const SCRATCH_GITIGNORE_RULE = "/scratch/";
export declare const SCRATCH_SUBDIRS: readonly ["tmp", "tests/fixtures", "tests/results", "logs", "captures/screenshots", "captures/videos", "caches/npm", "caches/pip", "caches/python", "builds", "environments", "runtime", "experiments"];
export type ScratchSubdir = (typeof SCRATCH_SUBDIRS)[number];
export type ScratchTaskScope = {
    root: string;
    scratch: string;
    taskDir: string;
    dirs: {
        tmp: string;
        testFixtures: string;
        testResults: string;
        logs: string;
        screenshots: string;
        videos: string;
        npmCache: string;
        pipCache: string;
        pythonCache: string;
        builds: string;
        environments: string;
        runtime: string;
        experiments: string;
    };
    /**
     * Per-call environment additions only. Merge into a single
     * `ExecutorOptions.env`; never assign to `process.env`. Deliberately
     * carries no `HOME`, `XDG_*`, `ENGRAM_*`, or `TMPDIR` entries.
     */
    env: Record<string, string>;
};
/** Resolve and verify the canonical scratch root for a worktree (fail closed). */
export declare function resolveScratchRoot(worktree: string): Promise<{
    root: string;
    scratch: string;
}>;
/** Create the scratch root plus the requested subdirectories (defaults to the full layout). */
export declare function ensureScratchDirs(worktree: string, subdirs?: readonly string[]): Promise<{
    root: string;
    scratch: string;
}>;
/**
 * Create a concurrent-safe unique directory under `scratch/<scope>/` via
 * `mkdtemp` (atomic unique naming; sibling `mkdir` races resolve through
 * the `ensureSafeDirectory` EEXIST path). The scope parent stays inside the
 * verified scratch root; symlink escapes fail closed.
 */
export declare function createUniqueScratchDir(worktree: string, scope: string, prefix: string): Promise<string>;
/** Per-day deterministic directory: `<scratch>/<UTC date>/<task name>/`; a new UTC day intentionally gets a new path. */
export declare function createTaskScratch(worktree: string, taskId: string, taskName?: string): Promise<string>;
/** Concurrent-safe unique run directory under the per-task directory. */
export declare function createTaskRunDir(worktree: string, taskId: string, prefix?: string, taskName?: string): Promise<string>;
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
export declare function scratchTaskScope(worktree: string, taskId: string, taskName?: string): Promise<ScratchTaskScope>;
/**
 * Atomically write a file under `scratch/` (path relative to the scratch
 * root, e.g. `logs/run.log`): sibling-temp + `verifySafeParent` + rename,
 * serialized with `withFileLock` like the plan persistence. Paths escaping
 * `scratch/` (absolute, `..`) fail closed; the sibling temp is contained
 * iff the target is contained. Historical files outside `scratch/` are
 * never touched.
 */
export declare function writeScratchFileAtomically(worktree: string, scratchRelativePath: string, content: string | Uint8Array, options?: {
    signal?: AbortSignal;
}): Promise<string>;
/**
 * Ensure exactly one root `/scratch/` rule exists in `<worktree>/.gitignore`:
 * append it when missing, collapse exact duplicates to the first occurrence,
 * and otherwise preserve every existing rule byte-identical. The write is
 * atomic (sibling-temp + rename). Already-tracked `scratch/` paths are
 * detected via `git ls-files` and reported; their contents and the git index
 * are left untouched (never staged, never removed).
 */
export declare function ensureScratchGitignore(worktree: string): Promise<{
    gitignorePath: string;
    added: boolean;
    deduped: boolean;
    tracked: string[];
}>;
//# sourceMappingURL=scratch.d.ts.map