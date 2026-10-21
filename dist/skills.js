import { realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
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
 * deliberately unused: it would duplicate the 22 on-disk `SKILL.md` contents
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
 * Canonical inventory of the 22 packaged skills (9 `rdc-*`, 13 `aria-*`),
 * alphabetical — the same order `readdirSync` yields, so the on-disk
 * `skills/<name>/SKILL.md` tree is the sync check, not a second copy.
 */
export const ARIA_SKILL_NAMES = [
    "aria-academic-writing",
    "aria-document-design",
    "aria-paper-self-review",
    "aria-qt-ui",
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
/** Compare filesystem paths by their real identity when they exist. */
export function areEquivalentSkillsPaths(a, b) {
    if (typeof a !== "string" || !isAbsolute(a) || !isAbsolute(b))
        return false;
    const canonical = (value) => {
        const lexical = resolve(normalize(value));
        try {
            return realpathSync(lexical);
        }
        catch {
            return lexical;
        }
    };
    return canonical(a) === canonical(b);
}
export function isEphemeralNpxInstallRoot(root) {
    const parts = resolve(normalize(root)).split(sep);
    return parts.length >= 4 && parts[parts.length - 4] === "_npx"
        && parts[parts.length - 2] === "node_modules" && parts[parts.length - 1] === "aria";
}
export function isEphemeralAriaSkillsPath(entry) {
    return isAriaPackageSkillsPath(entry) && isEphemeralNpxInstallRoot(dirname(entry));
}
export function isDurableAriaSkillsPath(entry) {
    return isAriaPackageSkillsPath(entry) && !isEphemeralAriaSkillsPath(entry);
}
export function resolveGlobalAriaSkillsRoot() {
    const exeDir = dirname(process.execPath);
    const prefix = process.env.NPM_CONFIG_PREFIX?.trim() || (process.platform === "win32" ? exeDir : dirname(exeDir));
    const globalRoot = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
    const packageRoot = join(globalRoot, "aria");
    const skillsRoot = join(packageRoot, "skills");
    try {
        if (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name !== "aria" || !existsSync(skillsRoot))
            return undefined;
        return realpathSync(skillsRoot);
    }
    catch {
        return undefined;
    }
}
export function resolveDurableAriaSkillsRoot(options = {}) {
    const installedRoot = options.installedRoot ?? getPackageRoot();
    if (!isEphemeralNpxInstallRoot(installedRoot))
        return getPackageSkillsRoot(installedRoot);
    const discovered = (options.globalSkillsRootResolver ?? resolveGlobalAriaSkillsRoot)();
    return discovered && existsSync(discovered) ? (() => { try {
        return realpathSync(discovered);
    }
    catch {
        return resolve(discovered);
    } })() : getPackageSkillsRoot(installedRoot);
}
/**
 * T007 v1.0.14 — positively owned packaged skills path predicate.
 *
 * True only for absolute paths whose normalized form ends with the packaged
 * install suffix `node_modules/aria/skills` (npx/npm cache, extracted
 * `node_modules/aria`). This is the only lexical shape that positively proves
 * ARIA ownership: the 22 namespaced `SKILL.md` files ship only under that
 * suffix, while user entries (`/user/skills`, `/custom/skills`, URLs,
 * relative paths) never do. Checkout roots (`<checkout>/skills`) do NOT
 * match and are treated as unrelated (preserved, never guessed) — the live
 * stale path (v1.0.7 npx cache `.../_npx/<hash>/node_modules/aria/skills`)
 * and the current release location (same suffix, different prefix) both
 * match, so stale-to-current refresh is proven without guessing user paths.
 * Non-strings, relative paths, URLs, and empty strings are never owned.
 */
export function isAriaPackageSkillsPath(entry) {
    if (typeof entry !== "string" || entry.length === 0)
        return false;
    if (!isAbsolute(entry))
        return false;
    const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.endsWith("/node_modules/aria/skills");
}
/**
 * Idempotently ensure the single version-locked ARIA skills root is present
 * in a V2 `skills: string[]` config value.
 *
 * - Missing `skills` → set to `[root]`.
 * - Existing array with exactly one stale packaged entry (see
 *   `isAriaPackageSkillsPath`, not the current root) and no current root →
 *   replace it in place with `root` (unrelated entries keep their order and
 *   bytes; no old cache is deleted, only the config string is refreshed).
 *   Returns `added: true` (the current root was installed by this call).
 * - Existing array with the current root exactly once and no stale packaged
 *   entry → idempotent, returns `added: false`.
 * - Existing array with zero owned entries (all unrelated, non-empty) →
 *   append `root` once; user entries (including non-string entries, which
 *   validation flags) keep their order and are never removed.
 * - Empty array (`[]`, an explicit user choice to disable discovery) →
 *   throws (ambiguous, fail closed, no mutation).
 * - Multiple owned entries (two or more packaged paths, or a packaged stale
 *   plus the current root, or duplicate current roots aside — duplicate
 *   current is left for validation to report) → throws when a stale is
 *   involved (ambiguous ownership, fail closed, no mutation); duplicate
 *   current alone returns `added: false` so `validateAriaSkillsConfig`
 *   reports it in `ensureAriaSetupConfigFile` before any write.
 * - Legacy non-array `skills` (e.g. V1 `{ paths: [...] }`) → left untouched;
 *   T008 owns migration with backup. Returns `added: false`.
 *
 * Never emits `skills.paths`/`skills.urls` or any other legacy key. Never
 * deletes skills directories; never rewrites unrelated config keys.
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
    if (current.length === 0) {
        throw new Error("skills[] is explicitly empty (ambiguous ownership: refusing to guess whether discovery was disabled on purpose). No changes were made.");
    }
    const currentCount = current.filter((entry) => areEquivalentSkillsPaths(entry, packageSkillsRoot)).length;
    const staleIndices = [];
    current.forEach((entry, index) => {
        if (!areEquivalentSkillsPaths(entry, packageSkillsRoot) && isAriaPackageSkillsPath(entry))
            staleIndices.push(index);
    });
    if (staleIndices.length > 1) {
        throw new Error(`skills[] holds ${staleIndices.length} positively owned ARIA package paths (ambiguous ownership: refusing to guess which is stale). No changes were made.`);
    }
    if (staleIndices.length === 1 && currentCount >= 1) {
        throw new Error("skills[] holds both the current ARIA skills root and a stale packaged ARIA path (ambiguous ownership: refusing to guess). No changes were made.");
    }
    if (staleIndices.length === 1) {
        current[staleIndices[0]] = packageSkillsRoot;
        return { added: true };
    }
    if (currentCount > 1) {
        return { added: false };
    }
    if (current.some((entry) => areEquivalentSkillsPaths(entry, packageSkillsRoot))) {
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
    const occurrences = skills.filter((entry) => areEquivalentSkillsPaths(entry, packageSkillsRoot)).length;
    if (occurrences === 0) {
        issues.push("ARIA package skills root is not registered");
    }
    else if (occurrences > 1) {
        issues.push("ARIA package skills root is registered more than once (duplicate discovery)");
    }
    return issues;
}
//# sourceMappingURL=skills.js.map