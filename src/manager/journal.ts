import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { journalDir } from "./env.ts";
import { newNonce, writeAtomic, type State } from "./state.ts";

/**
 * Write-ahead journal for operations that change several files (rollback). Nothing in OpenCode's
 * config or the filesystem gives a multi-file transaction, so ARIA does not claim atomicity.
 * Instead, before the first write it records, for every file, the exact content before and after,
 * and while writing it records which files are done (`written`) and which one is being written
 * (`inflight`). Each single file write is atomic (temp file + rename), so after a crash every file
 * holds either its `before` or its `after` content, or something a user wrote since.
 *
 * Reverting a file is only done when its current content is exactly what ARIA wrote (`after`), so
 * a file the user changed after ARIA wrote it is never overwritten.
 */

export type FileRole = "mcp-config" | "plugin-config" | "integration-plugin" | "launcher" | "state";

export interface JournalFile {
  readonly path: string;
  readonly role: FileRole;
  /** Exact content before the operation; null if the file did not exist. */
  readonly before: string | null;
  readonly after: string | null;
}

export interface Journal {
  readonly schema: 1;
  readonly id: string;
  readonly op: "rollback" | "dependency";
  readonly from?: string;
  readonly target: string;
  readonly createdAt: string;
  readonly pid: number;
  /** In write order: MCP-only config files, the plugin config file, the launcher, state.json. */
  readonly files: readonly JournalFile[];
  progress: { written: string[]; inflight: string | null };
}

/**
 * Fault injection for disposable verification (ARIA_FAULT_AT=<step>): a handled error by default,
 * or an abrupt kill with ARIA_FAULT_KILL=1 to simulate a crash or power loss mid-operation.
 */
export function fault(step: string) {
  if (process.env.ARIA_FAULT_AT !== step) return;
  if (process.env.ARIA_FAULT_KILL === "1") process.kill(process.pid, "SIGKILL");
  throw new Error(`simulated failure at ${step} (ARIA_FAULT_AT)`);
}

const pathOf = (id: string) => {
  if (!/^[0-9]{8}T[0-9]{6}-[0-9a-f]{16}$/.test(id)) throw new Error(`invalid journal id ${JSON.stringify(id)}`);
  return join(journalDir(), `${id}.json`);
};

/** Create a new journal file (never reuses an id). */
export function createJournal(j: Omit<Journal, "schema" | "id" | "createdAt" | "pid" | "progress">): Journal {
  mkdirSync(journalDir(), { recursive: true, mode: 0o700 });
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${newNonce()}${newNonce()}`.slice(0, 32);
  const journal: Journal = { schema: 1, id, createdAt: now.toISOString(), pid: process.pid, progress: { written: [], inflight: null }, ...j };
  const fd = openSync(pathOf(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, JSON.stringify(journal, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  return journal;
}

export function saveJournal(j: Journal): void {
  writeAtomic(pathOf(j.id), JSON.stringify(j, null, 2) + "\n");
}

export function removeJournal(id: string): void {
  try {
    unlinkSync(pathOf(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readJournal(name: string): { id: string; journal?: Journal; error?: string } {
  const id = basename(name, ".json");
  try {
    const p = pathOf(id);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return { id, error: "not a regular file" };
    const j = JSON.parse(readFileSync(p, "utf8")) as Journal;
    if (j.schema !== 1 || j.id !== id || !Array.isArray(j.files) || !j.progress) return { id, error: "unknown journal format" };
    return { id, journal: j };
  } catch (error) {
    return { id, error: (error as Error).message };
  }
}

export const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

export type RevertOutcome = "unchanged" | "reverted" | "modified";

/**
 * Put one file back to its `before` content, but only if it holds exactly what ARIA wrote.
 * `ours` widens "what ARIA wrote" (state.json also holds ARIA's interrupted-operation marker).
 */
export function revertFile(f: JournalFile, ours: (current: string) => boolean = () => false): RevertOutcome {
  const current = readText(f.path);
  if (current === f.before) return "unchanged";
  if (current === f.after || (current !== null && ours(current))) {
    if (f.before === null) unlinkSync(f.path);
    else writeAtomic(f.path, f.before);
    return "reverted";
  }
  return "modified";
}

export const isOurMarker = (j: Pick<Journal, "id">) => (text: string) => {
  try {
    return (JSON.parse(text) as State).pending?.journal === j.id;
  } catch {
    return false;
  }
};

/** State is reverted last so its recovery marker survives until all other files are safe. */
export function revertJournal(j: Journal, label: string): { reverted: string[]; modified: string[]; complete: boolean } {
  const reverted: string[] = [];
  const modified: string[] = [];
  const stateFile = j.files.find((f) => f.role === "state");
  for (const f of [...j.files].reverse()) {
    if (f.role === "state") continue;
    if (!j.progress.written.includes(f.path) && j.progress.inflight !== f.path) continue;
    fault(`${label}:revert:${f.role}`);
    const r = revertFile(f);
    if (r === "reverted") reverted.push(f.path);
    if (r === "modified") modified.push(f.path);
  }
  if (modified.length === 0 && stateFile) {
    fault(`${label}:revert:state`);
    const r = revertFile(stateFile, isOurMarker(j));
    if (r === "reverted") reverted.push(stateFile.path);
    if (r === "modified") modified.push(stateFile.path);
  }
  const complete = modified.length === 0;
  if (complete) removeJournal(j.id);
  return { reverted, modified, complete };
}
