/**
 * T007 — Packaged skills, single source: V2 config `skills: string[]`.
 *
 * ONE canonical discovery/registration, chosen from the pinned 2.0.23 API
 * (verified, not guessed):
 * - `@opencode/plugin@2.0.23` `dist/promise/plugin.d.ts` — `Context` carries
 *   `readonly skill: SkillDomain`.
 * - `@opencode/plugin@2.0.23` `dist/promise/skill.d.ts` — `SkillDomain`
 *   supports `transform` (`SkillEditor` list/get/add/update/remove) plus
 *   `reload()`. Supported, but NOT selected (see below).
 * - `@opencode/schema@2.0.23` `dist/config.d.ts:69` + `dist/config.js:82-84`
 *   — `Config.Info.skills` is `Schema.String.pipe(Schema.Array, optional)`:
 *   a plain `string[]` described as "Additional paths or URLs to discover
 *   skills from". This is the canonical V2 shape when writing config.
 *
 * Decision: the single registration is one `skills: string[]` entry pointing
 * at the installed package's `skills/` root. `ctx.skill.transform` is
 * deliberately unused: it would duplicate the 21 on-disk `SKILL.md` contents
 * into runtime `Skill.Info` objects (plus `reload` handling), while config
 * discovery keeps the packaged files canonical — the same files-are-primary
 * precedent T003 set for agents (managed files preferred over runtime
 * materialization). The plugin `setup` (`src/index.ts`) therefore never
 * touches `ctx.skill`, and this module never emits a transform; T008's
 * lifecycle owns writing this entry into user config with
 * backup/rollback/idempotence.
 *
 * Version-lock: the entry is derived from `getPackageRoot()` — the loaded
 * ARIA install — never a hardcoded or floating path, so discovery always
 * resolves inside the exact installed package. The `@opencode/plugin`
 * dependency itself stays exactly pinned (`2.0.23`, no range).
 *
 * V1 (`src/register.ts`) stays untouched as the frozen V1 reference until
 * migration completes; its legacy `skills: { paths: [...] }` shape is never
 * emitted here. A legacy non-array `skills` value is left in place by the
 * applier (T008 owns migration with backup) and flagged by validation.
 */
/**
 * Canonical inventory of the 21 packaged skills (9 `rdc-*`, 12 `aria-*`),
 * alphabetical — the same order `readdirSync` yields, so the on-disk
 * `skills/<name>/SKILL.md` tree is the sync check, not a second copy.
 */
export declare const ARIA_SKILL_NAMES: readonly string[];
/** Absolute `skills/` root of the loaded ARIA install. */
export declare function getPackageSkillsRoot(packageRoot?: string): string;
/** Minimal structural config surface this module reads/writes. */
export interface SkillsConfig {
    skills?: unknown;
}
export interface ApplySkillsResult {
    /** True when the ARIA entry was appended by this call. */
    added: boolean;
}
/**
 * Idempotently ensure the single version-locked ARIA skills root is present
 * in a V2 `skills: string[]` config value.
 *
 * - Missing `skills` → set to `[root]`.
 * - Existing array → append `root` once; user entries (including non-string
 *   entries, which validation flags) keep their order and are never removed.
 * - Legacy non-array `skills` (e.g. V1 `{ paths: [...] }`) → left untouched;
 *   T008 owns migration with backup. Returns `added: false`.
 *
 * Never emits `skills.paths`/`skills.urls` or any other legacy key.
 */
export declare function applyAriaSkillsToConfig<T extends SkillsConfig>(config: T, packageSkillsRoot?: string): ApplySkillsResult;
/**
 * Validate a config value against the T007 single-source contract.
 * Returns a human-readable issue per violation; empty when canonical.
 */
export declare function validateAriaSkillsConfig(config: unknown, packageSkillsRoot?: string): string[];
//# sourceMappingURL=skills.d.ts.map