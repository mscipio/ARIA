import { type ConfigScope, type PendingChanges, type ScopedEntries } from "./model-manager-state.js";
import type { AriaDefaults, RoleName } from "./types.js";
export interface ScopePaths {
    /** File written when this scope changes (`aria.json`). */
    target: string;
    /** File currently supplying the scope's overrides, if any (aria.json or legacy). */
    source: string | undefined;
}
export interface ModelManagerSnapshot {
    worktree: string;
    defaults: AriaDefaults;
    saved: ScopedEntries;
    paths: Record<ConfigScope, ScopePaths>;
}
/**
 * Load the defaults and both override layers. Throws on malformed config so
 * the caller can stop before presenting or writing anything.
 *
 * Legacy `review-driven-code.json` files are read as fallbacks. The first save
 * of such a scope writes canonical `aria.json`, seeded from the effective
 * legacy layer, so effective routes are preserved; the legacy file itself is
 * never modified.
 */
export declare function loadModelManagerSnapshot(worktree: string, options?: {
    globalDir?: string;
}): ModelManagerSnapshot;
/** Read-only table of effective assignments, variants, and configuration sources. */
export declare function formatModelAssignments(snapshot: ModelManagerSnapshot): string;
export type PersistOutcome = {
    status: "unchanged";
    message: string;
} | {
    status: "saved";
    message: string;
    changed: Record<ConfigScope, RoleName[]>;
    regenerated: boolean;
    warning?: string;
} | {
    status: "failed";
    error: string;
};
export interface PersistOptions {
    /** Managed-agent regeneration after a global change (defaults to the existing regeneration). */
    regenerate?: (worktree: string) => Promise<{
        legacyArchitectWarning?: string;
    } | void>;
}
/**
 * Persist pending edits atomically. Only the `aria.json` of a scope with real
 * changes is rewritten; unrelated keys, unrelated roles, and legacy alias keys
 * are preserved. Global changes regenerate managed agents from the new global
 * layer; if regeneration fails, both files are restored to their prior bytes.
 */
export declare function persistAssignments(snapshot: ModelManagerSnapshot, pending: PendingChanges, options?: PersistOptions): Promise<PersistOutcome>;
//# sourceMappingURL=model-manager-store.d.ts.map