import { join } from "node:path";
import { getPackageRoot } from "./defaults.js";
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
export const ARIA_SKILL_NAMES = [
    "aria-academic-writing",
    "aria-document-design",
    "aria-paper-self-review",
    "aria-research-evidence",
    "aria-research-planning",
    "aria-results-analysis",
    "aria-review-response",
    "aria-wiki-archive",
    "aria-wiki-compile",
    "aria-wiki-lookup",
    "aria-writing-anti-ai",
    "aria-zotero-tutor",
    "rdc-adversarial-review",
    "rdc-code-exploration",
    "rdc-code-implementation",
    "rdc-implementation-planning",
    "rdc-implementation-review",
    "rdc-plan-review",
    "rdc-scope-assessment",
    "rdc-testing-discipline",
    "rdc-visual-analysis",
];
/** Absolute `skills/` root of the loaded ARIA install. */
export function getPackageSkillsRoot(packageRoot = getPackageRoot()) {
    return join(packageRoot, "skills");
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
export function applyAriaSkillsToConfig(config, packageSkillsRoot = getPackageSkillsRoot()) {
    const current = config.skills;
    if (current === undefined) {
        config.skills = [packageSkillsRoot];
        return { added: true };
    }
    if (!Array.isArray(current)) {
        return { added: false };
    }
    if (current.includes(packageSkillsRoot)) {
        return { added: false };
    }
    current.push(packageSkillsRoot);
    return { added: true };
}
/**
 * Validate a config value against the T007 single-source contract.
 * Returns a human-readable issue per violation; empty when canonical.
 */
export function validateAriaSkillsConfig(config, packageSkillsRoot = getPackageSkillsRoot()) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return ["config is not an object"];
    }
    const skills = config.skills;
    if (skills === undefined) {
        return ["skills entry is missing (ARIA skills root is not registered)"];
    }
    if (!Array.isArray(skills)) {
        return ["skills is not the canonical V2 string[] (legacy skills.paths/urls shape)"];
    }
    const issues = [];
    for (const entry of skills) {
        if (typeof entry !== "string" || entry.length === 0) {
            issues.push(`skills entry is not a non-empty string (got ${JSON.stringify(entry) ?? typeof entry})`);
        }
    }
    const occurrences = skills.filter((entry) => entry === packageSkillsRoot).length;
    if (occurrences === 0) {
        issues.push("ARIA package skills root is not registered");
    }
    else if (occurrences > 1) {
        issues.push("ARIA package skills root is registered more than once (duplicate discovery)");
    }
    return issues;
}
//# sourceMappingURL=skills.js.map