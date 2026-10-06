import type { ResolvedAriaConfig } from "./types.js";
/**
 * T008 — Global V2 setup config (`opencode.json`) plus project-neutral
 * resolution for managed agent files.
 *
 * Supported V2 surface only (verified against `@opencode/schema@2.0.23`
 * `Config.Info`: `plugins` is `(string | Entry)[]`, `skills` is `string[]`,
 * `experimental.subagent_depth` is an int; `docs/config` describes `skills`
 * as "Additional paths or URLs to discover skills from"). This module writes
 * exactly three things:
 * - `plugins`: the ARIA plugin identity (absolute path ≡ corresponding
 *   `file://` URI, one consistent local rule), appended once only when no
 *   equivalent is present and never rewriting an existing equivalent
 *   (idempotent);
 * - `skills`: the single version-locked ARIA skills root via T007
 *   `applyAriaSkillsToConfig` (idempotent, user entries preserved);
 * - `experimental.subagent_depth`: default `3` only when absent via T004
 *   `applyExperimentalSubagentDepthDefault` (explicit values incl. `0`
 *   preserved, never a top-level `subagent_depth` V1 key).
 *
 * Never emitted: V1 `plugin` (singular), legacy `skills` objects
 * (`skills.paths`/`skills.urls` shapes), top-level `subagent_depth`, and
 * legacy permission actions (`bash`/`task`/`plan`/`todowrite` never appear in
 * config keys at all; permission renames are T004-owned in `src/permissions.ts`).
 *
 * Preservation, backup, rollback, idempotence: unrelated user keys keep
 * their order and bytes; an existing file is copied aside to
 * `<path>.aria-backup-<stamp>` before an atomic replacement (temp file in
 * the same directory, then rename — the `writeGlobalConfigAtomic` pattern
 * from `src/model-config.ts`), so the live path is never missing; a second
 * run with the same inputs writes nothing.
 *
 * No unsupported V2 lifecycle API is used: all writes are plain JSON files
 * matching the pinned schema, and CLI registration uses the supported V2
 * `opencode plugin add <package>` / `opencode plugin list` surfaces in
 * `src/lifecycle.ts` (never `plugin <uri> --global` or `debug info`, which
 * do not exist on pinned 2.0.23; `ctx.plugin.list` stays runtime-only and
 * `debug config`/`debug paths` remain advisory, never authoritative).
 */
/** Minimal structural config surface this module reads/writes. */
export interface SetupConfig {
    plugins?: unknown;
    skills?: unknown;
    experimental?: {
        subagent_depth?: number | null | undefined;
    } | undefined;
}
export interface ApplySetupResult {
    pluginsAdded: boolean;
    skillsAdded: boolean;
    /** True when `experimental.subagent_depth` was absent/null and defaulted to 3. */
    depthFilled: boolean;
}
/**
 * One consistent local-identity comparison for filesystem registrations:
 * exact equality wins (preserves npm/remote semantics), otherwise two
 * strings are the same identity only when both map to the same local path
 * above (absolute path ≡ corresponding `file://` URI). Never rewrites.
 */
export declare function isSameLocalPluginIdentity(a: unknown, b: unknown): boolean;
/**
 * Idempotently ensure the exact ARIA plugin URI is present in a V2
 * `plugins: (string | Entry)[]` value. Missing `plugins` becomes `[uri]`;
 * an existing array keeps its order and entries (object entries are
 * preserved verbatim — only string entries equivalent under the local
 * path/file-URI rule count as present; an equivalent entry is left
 * unchanged, never rewritten to the canonical URI); a legacy non-array
 * value is left untouched for file-level migration.
 */
export declare function applyAriaPluginToConfig<T extends SetupConfig>(config: T, pluginUri: string): {
    added: boolean;
};
/**
 * Apply the full ARIA V2 setup (plugins + skills + depth default) to an
 * already-parsed config object. Returns per-key outcomes; never emits V1
 * keys (no singular `plugin`, no `skills.paths`/`urls`, no top-level
 * `subagent_depth`).
 */
export declare function applyAriaSetupToConfig<T extends SetupConfig>(config: T, targets: {
    pluginUri: string;
    skillsRoot?: string;
}): ApplySetupResult;
/**
 * V1-only config keys that ARIA setup never emits. `bash`/`task`/`plan`/
 * `todowrite` are permission actions (T004-owned), never config keys, so
 * they are not config-level legacy keys.
 */
export declare function findLegacySetupKeys(config: unknown): string[];
/**
 * Validate a config value against the T008 setup contract: no V1 keys, the
 * ARIA plugin identity registered exactly once (an absolute path and its
 * corresponding `file://` URI count as one identity; a config holding both
 * forms is a duplicate, not exactly-once), the canonical V2 `skills:
 * string[]` with the ARIA root once, and the defaulted depth present. Empty
 * means canonical.
 */
export declare function validateAriaSetupConfig(config: unknown, targets: {
    pluginUri: string;
    skillsRoot?: string;
}): string[];
/**
 * Resolve the config that managed global agent files are generated from:
 * packaged defaults plus global overrides, never project-local overrides.
 * Baking a CWD project's models into global files would violate T005
 * ("no global regeneration on project enter"; project overlays are
 * runtime-only via `agent.transform`). The worktree argument is accepted
 * for API compatibility but project reads are skipped.
 */
export declare function resolveSetupAriaConfig(worktree: string): ResolvedAriaConfig;
/** Default global V2 config path (`~/.config/opencode/opencode.json`). */
export declare function defaultGlobalConfigPath(): string;
export interface SetupConfigFileResult {
    path: string;
    changed: boolean;
    /** True when no config file existed before this call. */
    created: boolean;
    pluginsAdded: boolean;
    skillsAdded: boolean;
    depthFilled: boolean;
    /** True when a legacy `skills` object was migrated forward (with backup). */
    migratedLegacySkills: boolean;
    /** Backup holding the pre-existing bytes, when an existing file was replaced. */
    backupPath?: string;
    /** Pre-existing raw bytes replaced by this call (rollback fallback). */
    previousContents?: string;
}
/**
 * Ensure the global V2 config carries the ARIA setup (exact plugin URI,
 * single skills root, depth default 3). Unrelated user keys are preserved;
 * a replaced file is backed up first (as a copy, so the live path is never
 * missing); no write happens when nothing changed. ARIA-relevant V1 keys
 * (`plugin` singular, top-level `subagent_depth`) migrate forward with
 * backup; anything unmigratable rejects before mutation. A legacy non-array
 * `skills` object migrates forward with backup (preserved string entries
 * from `paths`/`urls`, ARIA root appended once). The resulting config is
 * validated before commit and rejects without touching the file when invalid.
 */
export declare function ensureAriaSetupConfigFile(options: {
    configPath?: string;
    pluginUri: string;
    skillsRoot?: string;
}): Promise<SetupConfigFileResult>;
/**
 * Roll back one `ensureAriaSetupConfigFile` result: restore the backup when
 * an existing file was replaced, remove only a file this call created, and
 * otherwise rewrite the replaced bytes verbatim. No-change results are
 * no-ops.
 */
export declare function rollbackSetupConfigFile(path: string, state: Pick<SetupConfigFileResult, "changed" | "created" | "backupPath" | "previousContents">): Promise<void>;
//# sourceMappingURL=setup-config.d.ts.map