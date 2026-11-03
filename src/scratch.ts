import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  assertContained,
  canonicalWorktree,
  ensureSafeDirectory,
  safeProjectFile,
  verifySafeParent,
  withFileLock,
} from "./paths.js";
import { isFilesystemRoot } from "./paths.js";

const execFileAsync = promisify(execFile);

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
export const SCRATCH_DIR_NAME = ".aria/scratch";

/** The single managed ignore rule for scratch. */
export const SCRATCH_GITIGNORE_RULE = "/.aria/scratch/";

/** Namespace for unplanned work and independent tool output. */
export const UNPLANNED_NAMESPACE = "unplanned";

/** Lowercase RFC 4122 UUIDv4, the immutable Markdown plan identity. */
export const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Plan task identifier as written in Markdown plans (`T001`). */
export const PLAN_TASK_ID_PATTERN = /^T[0-9]{3}$/;

const PLAN_EXECUTION_NAME = /^[0-9]{8}-[0-9]{6}(?:-[a-f0-9]{6})?$/;
const UNPLANNED_EXECUTION_NAME = /^[0-9]{8}-[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*(?:-[a-f0-9]{6})?$/;

export type ScratchExecutionKind = "plan" | "unplanned";

export type ScratchExecution = {
  kind: ScratchExecutionKind;
  root: string;
  scratch: string;
  executionDir: string;
};

/** Local timestamp `YYYYMMDD-HHMMSS` for execution directory names. */
export function formatScratchTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Resolve and verify the canonical scratch root for a worktree (fail closed). */
export async function resolveScratchRoot(worktree: string): Promise<{ root: string; scratch: string }> {
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

/** Validate a plan ID (lowercase UUIDv4) before it becomes a path component. */
export function validatePlanId(planId: string): string {
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
    throw new Error(`Scratch plan id is not a lowercase UUIDv4 path component: ${String(planId)}`);
  }
  return planId;
}

/** Validate a plan task ID (`T001`) before it becomes a path component. */
export function validatePlanTaskId(taskId: string): string {
  if (typeof taskId !== "string" || !PLAN_TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Scratch task id is not a plan task path component (expected T000 form): ${String(taskId)}`);
  }
  return taskId;
}

function slugify(description: string): string {
  const slug = (typeof description === "string" ? description : "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    throw new Error("Unplanned scratch description must contain at least one letter or digit");
  }
  return slug;
}

/**
 * Atomically create one execution directory under `parentSegments`. The parent is
 * verified (and created) as a safe directory; the candidate is created with a
 * non-recursive `mkdir`, so a concurrent or repeated allocation can never reuse one.
 */
async function allocateExecution(worktree: string, parentSegments: readonly string[], name: string): Promise<string> {
  const { root, scratch } = await resolveScratchRoot(worktree);
  const parent = await ensureSafeDirectory(root, resolve(scratch, ...parentSegments), true);
  assertContained(scratch, parent, "Scratch parent");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = join(parent, attempt === 0 ? name : `${name}-${randomBytes(3).toString("hex")}`);
    try {
      await mkdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const dir = await ensureSafeDirectory(root, candidate, false);
    assertContained(scratch, dir, "Scratch execution directory");
    return dir;
  }
  throw new Error("Unable to allocate a unique scratch execution directory");
}

/** Allocate `.aria/scratch/<plan-id>/<task-id>/<timestamp>/` for planned work. */
export async function allocatePlanExecutionDir(worktree: string, planId: string, taskId: string): Promise<string> {
  validatePlanId(planId);
  validatePlanTaskId(taskId);
  return allocateExecution(worktree, [planId, taskId], formatScratchTimestamp());
}

/** Allocate `.aria/scratch/unplanned/<timestamp>-<description>/` for unplanned work and tool output. */
export async function allocateUnplannedExecutionDir(worktree: string, description: string): Promise<string> {
  const slug = slugify(description);
  return allocateExecution(worktree, [UNPLANNED_NAMESPACE], `${formatScratchTimestamp()}-${slug}`);
}

/**
 * Verify that `executionDir` is an existing execution directory: exactly
 * `<plan-id>/<task-id>/<timestamp>` or `unplanned/<timestamp>-<description>`
 * under the scratch root, with no symlinks on the path. Namespace roots, parent
 * directories, and anything outside `.aria/scratch/` are rejected.
 */
export async function resolveExecutionDir(worktree: string, executionDir: string): Promise<ScratchExecution> {
  if (typeof executionDir !== "string" || executionDir.trim().length === 0) {
    throw new Error("Scratch execution directory cannot be empty");
  }
  const { root, scratch } = await resolveScratchRoot(worktree);
  const target = isAbsolute(executionDir) ? resolve(executionDir) : resolve(root, executionDir);
  assertContained(scratch, target, "Scratch execution directory");
  const segments = relative(scratch, target).split(sep).filter((segment) => segment.length > 0);
  let kind: ScratchExecutionKind;
  if (segments.length === 3 && PLAN_ID_PATTERN.test(segments[0]!) && PLAN_TASK_ID_PATTERN.test(segments[1]!) && PLAN_EXECUTION_NAME.test(segments[2]!)) {
    kind = "plan";
  } else if (segments.length === 2 && segments[0] === UNPLANNED_NAMESPACE && UNPLANNED_EXECUTION_NAME.test(segments[1]!)) {
    kind = "unplanned";
  } else {
    throw new Error(
      `Not a scratch execution directory (expected <plan-id>/<task-id>/<timestamp> or unplanned/<timestamp>-<description>): ${executionDir}`,
    );
  }
  const dir = await ensureSafeDirectory(root, target, false);
  assertContained(scratch, dir, "Scratch execution directory");
  return { kind, root, scratch, executionDir: dir };
}

/**
 * Atomically write one file inside an existing execution directory. Parents are
 * created on demand, only for this file; the write is sibling-temp + rename under
 * `withFileLock`. The file path must stay strictly inside the execution directory.
 */
export async function writeExecutionFileAtomically(
  worktree: string,
  executionDir: string,
  relativeFile: string,
  content: string | Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (typeof relativeFile !== "string" || relativeFile.trim().length === 0 || isAbsolute(relativeFile)) {
    throw new Error(`Execution file path must be a non-empty relative path: ${String(relativeFile)}`);
  }
  const execution = await resolveExecutionDir(worktree, executionDir);
  const candidate = resolve(execution.executionDir, relativeFile);
  assertContained(execution.executionDir, candidate, "Execution file path");
  if (candidate === execution.executionDir) {
    throw new Error("Execution file path must name a file inside the execution directory");
  }
  const file = await safeProjectFile(execution.root, relative(execution.root, candidate), { createParent: true });
  assertContained(execution.executionDir, file.path, "Execution file path");
  await withFileLock(
    file.path,
    async () => {
      await verifySafeParent(execution.root, file.path);
      const temporaryPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, content, { flag: "wx" });
        await verifySafeParent(execution.root, temporaryPath);
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Operation aborted");
        }
        await rename(temporaryPath, file.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
    options.signal,
  );
  return file.path;
}

async function trackedScratchPaths(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", SCRATCH_DIR_NAME], { cwd: root });
    return stdout
      .split("\0")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
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
export async function ensureScratchGitignore(worktree: string): Promise<{
  gitignorePath: string;
  added: boolean;
  deduped: boolean;
  tracked: string[];
}> {
  const { root } = await resolveScratchRoot(worktree);
  const gitignorePath = resolve(root, ".gitignore");
  assertContained(root, gitignorePath, "Gitignore path");
  let existing: string | undefined;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const isRule = (line: string): boolean => line.trim() === SCRATCH_GITIGNORE_RULE;
  let next: string;
  let added = false;
  let deduped = false;
  if (existing === undefined || existing === "") {
    next = `${SCRATCH_GITIGNORE_RULE}\n`;
    added = true;
  } else {
    const lines = existing.split("\n");
    const count = lines.filter(isRule).length;
    if (count === 0) {
      added = true;
      next = existing.endsWith("\n") ? `${existing}${SCRATCH_GITIGNORE_RULE}\n` : `${existing}\n${SCRATCH_GITIGNORE_RULE}\n`;
    } else if (count === 1) {
      next = existing;
    } else {
      deduped = true;
      let kept = false;
      next = lines
        .filter((line) => {
          if (!isRule(line)) return true;
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
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  return { gitignorePath, added, deduped, tracked: await trackedScratchPaths(root) };
}
