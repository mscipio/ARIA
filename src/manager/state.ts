import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ariaHome, journalDir, statePath } from "./env.ts";
import type { OperationResult } from "./types.ts";

/**
 * ARIA's own installation state (ARIA_HOME/state.json). It records only what ARIA did: releases it
 * installed, the active one, an interrupted operation, config entries it wrote, and previous model
 * values so they can be restored. It never contains secrets, provider credentials or copies of
 * user configuration.
 */

export interface Release {
  readonly version: string;
  readonly path: string;
  readonly installedAt: string;
  readonly source: string;
  readonly sha256?: string;
  /** Release identity (inventory.ts); same version + different identity = conflict. */
  readonly digest?: string;
  /** Algorithm of `digest`; absent for records written before alpha.5 (legacy digest). */
  readonly identityAlgorithm?: string;
  /**
   * Full records of the ARIA-managed tools in use with this release, written when the release is
   * left and on every tool change while it is active; rollback restores them. Records from before
   * alpha.5 hold only the executable path (string).
   */
  readonly tools?: Record<string, ManagedTool | string>;
}

export interface Owned {
  /** Config file and JSON path of an entry ARIA wrote. */
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly kind: "plugin" | "mcp";
  /** Fingerprint of the value ARIA wrote; if the file now differs, the user changed it and ARIA no longer owns it. */
  readonly fingerprint: string;
}

export interface ModelChange {
  readonly role: string;
  readonly scope: "global" | "project";
  readonly file: string;
  /** Value before ARIA changed it; null when the key did not exist. */
  readonly previous: string | null;
  readonly next: string | null;
  readonly at: string;
}

export interface Pending {
  readonly op: "setup" | "update" | "rollback";
  readonly version?: string;
  readonly staging?: string;
  readonly step: string;
  readonly startedAt: string;
  /** Written by one invocation; only that invocation (or `aria repair`) clears it. */
  readonly nonce?: string;
  /** Journal id of a journaled operation (rollback). */
  readonly journal?: string;
  /** The plugin entry an activation is about to write, so repair can re-adopt it after an interruption. */
  readonly adopt?: { readonly file: string; readonly fingerprint: string };
}

export const newNonce = () => randomBytes(8).toString("hex");

/** Record an interrupted-operation marker; returns the nonce that lets this invocation clear it. */
export function markPending(p: Omit<Pending, "nonce" | "startedAt">, nonce: string = newNonce()): string {
  const s = readState().state;
  s.pending = { ...p, nonce, startedAt: new Date().toISOString() };
  writeState(s);
  return nonce;
}

/** Clear the pending marker, but only if this invocation wrote it (same nonce). */
export function clearPending(nonce: string | undefined): boolean {
  if (!nonce) return false;
  const s = readState().state;
  if (s.pending?.nonce !== nonce) return false;
  delete s.pending;
  writeState(s);
  return true;
}

export interface ManagedTool {
  /** Versioned install directory under ARIA_HOME/tools (venvs are not relocatable, so each install gets its own). */
  readonly path: string;
  readonly executable: string;
  readonly version?: string;
  readonly installedAt: string;
}

export interface State {
  readonly schema: 1;
  releases: Release[];
  tools: Record<string, ManagedTool>;
  active?: string;
  previous?: string;
  pending?: Pending;
  owned: Owned[];
  models: ModelChange[];
  /** Staging directories ARIA created and has not finished with (path + marker nonce). */
  stagings?: { path: string; nonce: string; createdAt: string }[];
}

/** Record full copies of the current tool records with a release (when it is left, and on every tool change). */
export function recordTools(state: State, version: string | undefined) {
  if (!version) return;
  const tools = Object.fromEntries(Object.entries(state.tools).map(([id, t]) => [id, { ...t }]));
  state.releases = state.releases.map((r) => (r.version === version ? { ...r, tools } : r));
}

export const emptyState = (): State => ({ schema: 1, releases: [], tools: {}, owned: [], models: [] });

export function readState(): { state: State; error?: string } {
  const path = statePath();
  if (!existsSync(path)) return { state: emptyState() };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as State;
    if (value?.schema !== 1 || !Array.isArray(value.releases)) return { state: emptyState(), error: "state.json has an unknown format" };
    value.owned ??= [];
    value.tools ??= {};
    value.models ??= [];
    return { state: value };
  } catch (error) {
    return { state: emptyState(), error: `state.json unreadable: ${(error as Error).message}` };
  }
}

/** Write a file atomically: temp file in the same directory, then rename over the target. */
export function writeAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.aria-${process.pid}-${Date.now()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

export function writeState(state: State): void {
  writeAtomic(statePath(), JSON.stringify(state, null, 2) + "\n");
}

/** A conflict that needs a decision (exit code 4), e.g. an interrupted operation awaiting repair. */
export class BlockedError extends Error {
  override readonly name = "BlockedError";
}

/** Journals of operations that did not finish (files in ARIA_HOME/journal). */
export function openJournals(): string[] {
  try {
    return readdirSync(journalDir()).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** Describe a recorded interrupted operation, if any. */
export function interrupted(): string | undefined {
  const { state } = readState();
  const journals = openJournals();
  if (state.pending) return `an interrupted ${state.pending.op} is recorded (step "${state.pending.step}", started ${state.pending.startedAt})`;
  if (journals.length) return `an unfinished operation journal is recorded (${journals.join(", ")})`;
  return undefined;
}

/**
 * Entry check for every mutating operation (preview included, so a preview never promises a change
 * that would be refused): while an interrupted operation is recorded, refuse with BlockedError.
 */
export function assertNotInterrupted(): void {
  const blocked = interrupted();
  if (blocked) throw new BlockedError(`${blocked}. Run \`aria repair\` first; no other change is made until it is resolved.`);
}

/** The same check as a result, for operations that report rather than throw. */
export function interruptedResult(dryRun: boolean): OperationResult | undefined {
  const blocked = interrupted();
  return blocked ? { ok: false, dryRun, outcome: "blocked", changes: [], messages: [], errors: [], blocked: `${blocked}. Run \`aria repair\` first; no other change is made until it is resolved.` } : undefined;
}

let depth = 0;

/**
 * One mutating operation at a time. The lock file holds the owner's pid; a lock whose process is
 * gone is stale and is replaced. Nested calls in the same process share the outer lock.
 *
 * While an interrupted operation is recorded, every mutating operation refuses (BlockedError,
 * exit 4) so it cannot build on a half-applied state; only `aria repair` passes
 * `allowInterrupted`.
 */
export async function withLock<T>(fn: () => Promise<T>, opts: { allowInterrupted?: boolean } = {}): Promise<T> {
  if (depth > 0) {
    depth++;
    try {
      return await fn();
    } finally {
      depth--;
    }
  }
  const lock = join(ariaHome(), ".lock");
  mkdirSync(ariaHome(), { recursive: true });
  const take = () => {
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      if (owner > 0) {
        process.kill(owner, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive && owner !== process.pid) throw new BlockedError(`another ARIA operation is running (pid ${owner}); try again when it finishes`);
    unlinkSync(lock);
    take();
  }
  depth = 1;
  try {
    const blocked = opts.allowInterrupted ? undefined : interrupted();
    if (blocked) throw new BlockedError(`${blocked}. Run \`aria repair\` first; no other change is made until it is resolved.`);
    return await fn();
  } finally {
    depth = 0;
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}
