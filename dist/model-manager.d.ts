import { type ModelDiscovery } from "./model-config.js";
import { type PendingChanges } from "./model-manager-state.js";
import { type PersistOptions, type PersistOutcome } from "./model-manager-store.js";
/**
 * Entry points for `aria models` (interactive manager) and `aria models --show`
 * (read-only table). Discovery uses the OpenCode catalog; nothing calls a model
 * or touches provider credentials.
 */
export declare const NON_INTERACTIVE_MESSAGE = "aria models is interactive and needs a terminal. Run it from a terminal, or use `aria models --show` for a read-only table of effective assignments.";
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
export declare function formatModelAssignmentsFor(worktree: string, options?: {
    globalDir?: string;
}): string;
/**
 * Re-validate and persist the pending edits against the live layers and a
 * fresh catalog. Nothing is written when the catalog is unavailable or any
 * pending model/variant is no longer supported.
 */
export declare function saveFromManager(worktree: string, pending: PendingChanges, options: ModelManagerOptions): Promise<PersistOutcome>;
/**
 * Run the interactive manager. Returns the process exit code. A cancelled
 * session (Esc without pending changes, or Ctrl+C) writes nothing and exits 0.
 */
export declare function runModelManager(worktree: string, options?: ModelManagerOptions): Promise<number>;
//# sourceMappingURL=model-manager.d.ts.map