import { lstatSync } from "node:fs";
import { join } from "node:path";
import { UnsafePath, createExclusive, entries, kindOf, realRoot, removeOwnedDirectory, secureDir, touchDirectory } from "./safe-fs.ts";

/**
 * Per-session scratch: `.aria/scratch/<root-session>/<session>/`.
 *
 * Safety rules (all fail closed):
 * - every component from the real project root down is a real directory, never a symlink;
 *   a symlinked `.aria` or `.aria/scratch` disables scratch instead of being followed;
 * - session identifiers are validated before they become path components;
 * - cleanup removes only `<root>` directories that are real directories, whose DONE marker is a
 *   regular file (not a link), or that are explicitly stale; it renames and identity-checks each
 *   target before deleting, never follows links, and never crosses filesystems;
 * - every provisioning refreshes the session directory's mtime (activity signal for cleanup), and a DONE
 *   marker only counts if no session was active more than DONE_GRACE_MS after it;
 * - anything malformed is reported and kept.
 */

export const SCRATCH_DIR = ".aria/scratch";

/** POSIX single-quoting of one word (no command parsing): safe for spaces, quotes, `$`, backticks, newlines. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const SCRATCH_COMPONENTS = [".aria", "scratch"] as const;

/** OpenCode v2 session IDs are `ses` + `_` + an opaque sortable token. Anything else is not used as a path. */
const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;
export const validSessionID = (id: string) => SESSION_ID.test(id);

/**
 * Create (if needed) and return the session's scratch directory. Throws `UnsafePath` with a
 * specific reason when the location is unsafe; the caller reports scratch as unavailable.
 */
export function ensureScratch(projectDir: string, root: string, session: string): string {
  if (!validSessionID(root) || !validSessionID(session)) throw new UnsafePath(`invalid session id (${root} / ${session})`);
  const projectRoot = realRoot(projectDir);
  const base = secureDir(projectRoot, SCRATCH_COMPONENTS, true) as string;
  createExclusive(join(base, ".gitignore"), "*\n");
  const dir = secureDir(projectRoot, [...SCRATCH_COMPONENTS, root, session], true) as string;
  // Activity signal for cleanup: every provisioning (each model request of the session) refreshes
  // the session directory's mtime, so deeper file changes need not be scanned to see it is in use.
  touchDirectory(dir);
  return dir;
}

/**
 * A DONE marker only counts if the session tree stopped after it. Provisioning on later requests
 * moves a session directory's mtime past DONE by more than this grace (the final replies of the turn
 * that wrote DONE come within it), which shows the session continued.
 */
export const DONE_GRACE_MS = 10 * 60_000;

export interface ScratchEntry {
  readonly root: string;
  readonly sessions: readonly string[];
  /** DONE marker present and no session activity after it (beyond the grace). */
  readonly done: boolean;
  /** DONE marker present but a session was active after it; such an entry is kept. */
  readonly reopened: boolean;
  readonly modified: Date;
  /** Present when the entry is malformed; such entries are never removed. */
  readonly problem?: string;
  readonly identity: { dev: number; ino: number };
}

export interface ScratchListing {
  readonly entries: readonly ScratchEntry[];
  /** Why scratch could not be inspected, or names that were skipped as unsafe. */
  readonly problems: readonly string[];
}

function scratchBase(projectDir: string): { base?: string; problem?: string } {
  try {
    const base = secureDir(realRoot(projectDir), SCRATCH_COMPONENTS, false);
    return base ? { base } : {};
  } catch (error) {
    return { problem: error instanceof UnsafePath ? error.message : `cannot inspect ${SCRATCH_DIR}: ${(error as Error).message}` };
  }
}

export function listScratch(projectDir: string): ScratchListing {
  const { base, problem } = scratchBase(projectDir);
  if (!base) return { entries: [], problems: problem ? [problem] : [] };
  const out: ScratchEntry[] = [];
  const problems: string[] = [];
  for (const { name, kind } of entries(base)) {
    if (name === ".gitignore" || name.startsWith(".trash-")) continue;
    if (!validSessionID(name)) {
      problems.push(`skipped ${JSON.stringify(name)}: not a session id`);
      continue;
    }
    if (kind !== "directory") {
      problems.push(`skipped ${name}: ${kind === "symlink" ? "symbolic link (never followed)" : `not a directory (${kind})`}`);
      continue;
    }
    const dir = join(base, name);
    const stat = lstatSync(dir);
    let latest = stat.mtime;
    let activeAt = 0;
    let doneAt = 0;
    const sessions: string[] = [];
    let entryProblem: string | undefined;
    let done = false;
    for (const child of entries(dir)) {
      if (child.name === "DONE") {
        if (child.kind === "file") {
          done = true;
          doneAt = lstatSync(join(dir, "DONE")).mtime.getTime();
        } else entryProblem = `DONE is a ${child.kind}, not a regular file`;
      } else if (validSessionID(child.name) && child.kind === "directory") {
        sessions.push(child.name);
        activeAt = Math.max(activeAt, lstatSync(join(dir, child.name)).mtime.getTime());
      } else {
        entryProblem ??= `unexpected entry ${JSON.stringify(child.name)} (${child.kind})`;
      }
      if (child.kind === "file" || child.kind === "directory") {
        const m = lstatSync(join(dir, child.name)).mtime;
        if (m > latest) latest = m;
      }
    }
    const reopened = done && activeAt > doneAt + DONE_GRACE_MS;
    out.push({ root: name, sessions, done: done && !reopened, reopened, modified: latest, identity: { dev: stat.dev, ino: stat.ino }, ...(entryProblem ? { problem: entryProblem } : {}) });
  }
  out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return { entries: out, problems };
}

export interface CleanOptions {
  /** Also remove unfinished scratch untouched for this many days. Off unless given. */
  readonly staleDays?: number;
  readonly dryRun: boolean;
  readonly now?: Date;
}

export interface CleanResult {
  readonly removed: readonly string[];
  readonly kept: readonly { root: string; reason: string }[];
  readonly problems: readonly string[];
}

export function cleanScratch(projectDir: string, options: CleanOptions): CleanResult {
  if (options.staleDays !== undefined && !(Number.isSafeInteger(options.staleDays) && options.staleDays >= 1)) {
    throw new Error("--stale must be a whole number of days >= 1");
  }
  const { base } = scratchBase(projectDir);
  const listing = listScratch(projectDir);
  const now = (options.now ?? new Date()).getTime();
  const removed: string[] = [];
  const kept: { root: string; reason: string }[] = [];
  const problems = [...listing.problems];
  for (const entry of listing.entries) {
    if (entry.problem) {
      kept.push({ root: entry.root, reason: `malformed: ${entry.problem}` });
      continue;
    }
    const age = (now - entry.modified.getTime()) / 86_400_000;
    const stale = options.staleDays !== undefined && age >= options.staleDays;
    if (!entry.done && !stale) {
      kept.push({ root: entry.root, reason: entry.reopened ? "DONE marker is older than later session activity (kept)" : "not marked DONE (kept for recovery)" });
      continue;
    }
    if (!base || kindOf(base) !== "directory") {
      problems.push("scratch base changed during cleanup; stopped");
      break;
    }
    if (!options.dryRun) {
      // Re-read just before deleting: a session that became active since the listing keeps its scratch.
      const fresh = listScratch(projectDir).entries.find((e) => e.root === entry.root);
      if (!fresh || fresh.problem || fresh.modified.getTime() !== entry.modified.getTime() || fresh.done !== entry.done) {
        kept.push({ root: entry.root, reason: "changed while cleaning (kept)" });
        continue;
      }
      try {
        removeOwnedDirectory(base, entry.root, entry.identity);
      } catch (error) {
        kept.push({ root: entry.root, reason: `not removed: ${(error as Error).message}` });
        continue;
      }
    }
    removed.push(entry.root);
  }
  return { removed, kept, problems };
}
