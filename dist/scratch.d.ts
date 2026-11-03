/**
 * ARIA-controlled generated output lives under `<canonical-worktree>/.aria/scratch/`
 * in exactly two categories:
 *
 * - `<plan-id>/<task-id>/<timestamp>/` — planned work. The plan ID is a lowercase
 *   UUIDv4 and the task ID is `T` plus three digits, both validated by format only;
 *   the plan file is never read.
 * - `unplanned/<timestamp>-<description>/` — unplanned work and independent tool
 *   output (for example Playwright MCP, described as `playwright-mcp`).
 *
 * Timestamps are local `YYYYMMDD-HHMMSS`. Each allocation is created with an atomic
 * non-recursive `mkdir`; a collision appends a random hex suffix and retries, so an
 * existing execution directory is never reused or overwritten. Only the execution
 * directory is created. Subdirectories and files are created on demand by
 * `writeExecutionFileAtomically`, which creates parents only for the file it writes.
 *
 * Guarantees (enforced by the `src/paths.ts` guards): traversal, absolute paths, and
 * symlinks anywhere in the path are rejected; filesystem-root and empty worktrees are
 * rejected; identifiers are validated before any directory is created; a path is
 * accepted as an execution directory only if it has exactly one of the two shapes,
 * so namespace roots and parent directories are rejected. Historical `./scratch/`
 * content is never moved, deleted, or staged, and no `git add` or `git rm` runs here.
 *
 * Not an OS sandbox: the Unix account can still write outside the project, and
 * cooperative tools must use the directories returned here.
 */
/** Scratch location relative to the canonical worktree. */
export declare const SCRATCH_DIR_NAME = ".aria/scratch";
/** The single managed ignore rule for scratch. */
export declare const SCRATCH_GITIGNORE_RULE = "/.aria/scratch/";
/** Namespace for unplanned work and independent tool output. */
export declare const UNPLANNED_NAMESPACE = "unplanned";
/** Lowercase RFC 4122 UUIDv4, the immutable Markdown plan identity. */
export declare const PLAN_ID_PATTERN: RegExp;
/** Plan task identifier as written in Markdown plans (`T001`). */
export declare const PLAN_TASK_ID_PATTERN: RegExp;
export type ScratchExecutionKind = "plan" | "unplanned";
export type ScratchExecution = {
    kind: ScratchExecutionKind;
    root: string;
    scratch: string;
    executionDir: string;
};
/** Local timestamp `YYYYMMDD-HHMMSS` for execution directory names. */
export declare function formatScratchTimestamp(date?: Date): string;
/** Resolve and verify the canonical scratch root for a worktree (fail closed). */
export declare function resolveScratchRoot(worktree: string): Promise<{
    root: string;
    scratch: string;
}>;
/** Validate a plan ID (lowercase UUIDv4) before it becomes a path component. */
export declare function validatePlanId(planId: string): string;
/** Validate a plan task ID (`T001`) before it becomes a path component. */
export declare function validatePlanTaskId(taskId: string): string;
/** Allocate `.aria/scratch/<plan-id>/<task-id>/<timestamp>/` for planned work. */
export declare function allocatePlanExecutionDir(worktree: string, planId: string, taskId: string): Promise<string>;
/** Allocate `.aria/scratch/unplanned/<timestamp>-<description>/` for unplanned work and tool output. */
export declare function allocateUnplannedExecutionDir(worktree: string, description: string): Promise<string>;
/**
 * Verify that `executionDir` is an existing execution directory: exactly
 * `<plan-id>/<task-id>/<timestamp>` or `unplanned/<timestamp>-<description>`
 * under the scratch root, with no symlinks on the path. Namespace roots, parent
 * directories, and anything outside `.aria/scratch/` are rejected.
 */
export declare function resolveExecutionDir(worktree: string, executionDir: string): Promise<ScratchExecution>;
/**
 * Atomically write one file inside an existing execution directory. Parents are
 * created on demand, only for this file; the write is sibling-temp + rename under
 * `withFileLock`. The file path must stay strictly inside the execution directory.
 */
export declare function writeExecutionFileAtomically(worktree: string, executionDir: string, relativeFile: string, content: string | Uint8Array, options?: {
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