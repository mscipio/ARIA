import { createElement as h } from "react";
import { render } from "ink";

import { discoverAvailableModels, type ModelDiscovery } from "./model-config.js";
import { normalizePending, validatePending, type PendingChanges } from "./model-manager-state.js";
import {
  formatModelAssignments,
  loadModelManagerSnapshot,
  persistAssignments,
  type PersistOptions,
  type PersistOutcome,
} from "./model-manager-store.js";
import { ModelManagerApp } from "./model-manager-tui.js";

/**
 * Entry points for `aria models` (interactive manager) and `aria models --show`
 * (read-only table). Discovery uses the OpenCode catalog; nothing calls a model
 * or touches provider credentials.
 */

export const NON_INTERACTIVE_MESSAGE =
  "aria models is interactive and needs a terminal. Run it from a terminal, or use `aria models --show` for a read-only table of effective assignments.";

export interface ModelManagerOptions {
  /** Catalog discovery seam (defaults to the OpenCode CLI catalog). */
  discover?: (worktree: string) => Promise<ModelDiscovery>;
  /** Managed-agent regeneration seam for global saves. */
  regenerate?: PersistOptions["regenerate"];
  /** Global OpenCode config directory override (tests); defaults to the XDG/home location. */
  globalDir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/** Read-only table of effective assignments for a worktree. Throws on malformed config. */
export function formatModelAssignmentsFor(worktree: string, options: { globalDir?: string } = {}): string {
  return formatModelAssignments(loadModelManagerSnapshot(worktree, options));
}

/**
 * Re-validate and persist the pending edits against the live layers and a
 * fresh catalog. Nothing is written when the catalog is unavailable or any
 * pending model/variant is no longer supported.
 */
export async function saveFromManager(
  worktree: string,
  pending: PendingChanges,
  options: ModelManagerOptions,
): Promise<PersistOutcome> {
  const discover = options.discover ?? discoverAvailableModels;
  let snapshot: ReturnType<typeof loadModelManagerSnapshot>;
  try {
    snapshot = loadModelManagerSnapshot(worktree, { globalDir: options.globalDir });
  } catch (error) {
    return { status: "failed", error: `configuration could not be re-read (${describe(error)}); nothing was written.` };
  }
  let models: Awaited<ReturnType<typeof discover>>["models"];
  try {
    models = (await discover(worktree)).models;
  } catch (error) {
    return { status: "failed", error: `model catalog unavailable (${describe(error)}); nothing was written.` };
  }
  const errors = validatePending(normalizePending(snapshot.saved, pending), models);
  if (errors.length > 0) {
    return { status: "failed", error: `not saved: ${errors.join("; ")}. Change or discard those selections.` };
  }
  return persistAssignments(snapshot, pending, { regenerate: options.regenerate });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the interactive manager. Returns the process exit code. A cancelled
 * session (Esc without pending changes, or Ctrl+C) writes nothing and exits 0.
 */
export async function runModelManager(worktree: string, options: ModelManagerOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    console.error(NON_INTERACTIVE_MESSAGE);
    return 1;
  }

  let snapshot: ReturnType<typeof loadModelManagerSnapshot>;
  try {
    snapshot = loadModelManagerSnapshot(worktree, { globalDir: options.globalDir });
  } catch (error) {
    console.error(`aria models: ${describe(error)}. Fix the configuration file; nothing was changed.`);
    return 1;
  }

  const discover = options.discover ?? discoverAvailableModels;
  let outcome: PersistOutcome | undefined;
  let closed = false;
  const instance = render(
    h(ModelManagerApp, {
      snapshot,
      discover: async () => (await discover(worktree)).models,
      save: (pending: PendingChanges) => saveFromManager(worktree, pending, options),
      onFinish: (result: PersistOutcome | undefined) => {
        if (closed) return;
        closed = true;
        outcome = result;
      },
    }),
    { stdin, stdout, exitOnCtrlC: true },
  );
  await instance.waitUntilExit();

  if (outcome === undefined) {
    console.log("Model manager closed without saving: no changes were written.");
    return 0;
  }
  if (outcome.status === "failed") {
    console.error(`Model configuration: [FAIL] ${outcome.error}`);
    return 1;
  }
  console.log(`Model configuration: ${outcome.status === "saved" ? "[OK]" : "unchanged."} ${outcome.message}`);
  if (outcome.status === "saved" && outcome.warning) console.log(outcome.warning);
  return 0;
}
