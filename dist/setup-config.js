import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeConfigPath, stripJsoncComments } from "./deps.js";
import { resolveAriaConfig } from "./overrides.js";
import { applyExperimentalSubagentDepthDefault } from "./permissions.js";
import { applyAriaSkillsToConfig, getPackageSkillsRoot, validateAriaSkillsConfig } from "./skills.js";
/**
 * T008 local-identity rule (narrow): an absolute filesystem path and its
 * corresponding `file://` URI denote one plugin identity. Node path/URL
 * primitives only (`URL`, `fileURLToPath`, `isAbsolute`, `resolve`); no
 * string-prefix slicing or manual `%`-decoding. Only absolute paths and
 * `file:` URIs map to a local path — bare npm names, remote URLs, relative
 * specifiers, and non-strings never do (existing symlink/realpath behavior
 * is preserved: lexical only, no filesystem probing, no canonical rewrite).
 */
function toLocalPluginPath(spec) {
    if (typeof spec !== "string" || spec.length === 0)
        return undefined;
    try {
        const url = new URL(spec);
        if (url.protocol === "file:") {
            return resolve(fileURLToPath(spec));
        }
        return undefined;
    }
    catch {
        // Not an absolute URL — fall through to the absolute-path check below.
    }
    if (isAbsolute(spec)) {
        return resolve(spec);
    }
    return undefined;
}
/**
 * One consistent local-identity comparison for filesystem registrations:
 * exact equality wins (preserves npm/remote semantics), otherwise two
 * strings are the same identity only when both map to the same local path
 * above (absolute path ≡ corresponding `file://` URI). Never rewrites.
 */
export function isSameLocalPluginIdentity(a, b) {
    if (typeof a !== "string" || typeof b !== "string")
        return false;
    if (a === b)
        return true;
    const pa = toLocalPluginPath(a);
    const pb = toLocalPluginPath(b);
    if (pa === undefined || pb === undefined)
        return false;
    return pa === pb;
}
/**
 * Idempotently ensure the exact ARIA plugin URI is present in a V2
 * `plugins: (string | Entry)[]` value. Missing `plugins` becomes `[uri]`;
 * an existing array keeps its order and entries (object entries are
 * preserved verbatim — only string entries equivalent under the local
 * path/file-URI rule count as present; an equivalent entry is left
 * unchanged, never rewritten to the canonical URI); a legacy non-array
 * value is left untouched for file-level migration.
 */
export function applyAriaPluginToConfig(config, pluginUri) {
    const current = config.plugins;
    if (current === undefined) {
        config.plugins = [pluginUri];
        return { added: true };
    }
    if (!Array.isArray(current)) {
        return { added: false };
    }
    if (current.some((entry) => isSameLocalPluginIdentity(entry, pluginUri))) {
        return { added: false };
    }
    current.push(pluginUri);
    return { added: true };
}
/**
 * Apply the full ARIA V2 setup (plugins + skills + depth default) to an
 * already-parsed config object. Returns per-key outcomes; never emits V1
 * keys (no singular `plugin`, no `skills.paths`/`urls`, no top-level
 * `subagent_depth`).
 */
export function applyAriaSetupToConfig(config, targets) {
    const skillsRoot = targets.skillsRoot ?? getPackageSkillsRoot();
    const pluginsAdded = applyAriaPluginToConfig(config, targets.pluginUri).added;
    const skillsAdded = applyAriaSkillsToConfig(config, skillsRoot).added;
    const depthBefore = config.experimental?.subagent_depth;
    applyExperimentalSubagentDepthDefault(config);
    return {
        pluginsAdded,
        skillsAdded,
        depthFilled: depthBefore === undefined || depthBefore === null,
    };
}
/** String entries salvaged from a legacy `skills` object (`paths`/`urls`). */
function legacySkillStrings(skills) {
    if (!skills || typeof skills !== "object" || Array.isArray(skills))
        return [];
    const record = skills;
    const out = [];
    for (const key of ["paths", "urls"]) {
        const value = record[key];
        if (!Array.isArray(value))
            continue;
        for (const entry of value) {
            if (typeof entry === "string" && entry.length > 0 && !out.includes(entry))
                out.push(entry);
        }
    }
    return out;
}
/**
 * V1-only config keys that ARIA setup never emits. `bash`/`task`/`plan`/
 * `todowrite` are permission actions (T004-owned), never config keys, so
 * they are not config-level legacy keys.
 */
export function findLegacySetupKeys(config) {
    if (!config || typeof config !== "object" || Array.isArray(config))
        return [];
    const record = config;
    const legacy = [];
    if ("subagent_depth" in record) {
        legacy.push("subagent_depth (V1 top-level; V2 uses experimental.subagent_depth)");
    }
    if ("plugin" in record) {
        legacy.push("plugin (V1 singular; V2 uses plugins[])");
    }
    if (record["skills"] !== undefined && !Array.isArray(record["skills"])) {
        legacy.push("skills (legacy object; V2 uses skills: string[])");
    }
    return legacy;
}
/**
 * Migrate ARIA-relevant V1 keys in place before V2 appliers run. String
 * `plugin` entries merge into `plugins[]`, a finite numeric top-level
 * `subagent_depth` moves to `experimental.subagent_depth` only when the V2
 * field is absent (an explicit V2 value wins and the V1 duplicate is
 * dropped). A legacy non-array `plugins` string wraps to `[value]`.
 * Anything else that cannot be migrated safely (non-string `plugin`,
 * non-numeric top-level depth, non-string legacy `plugins` shape) throws
 * before any file mutation so the caller fails closed with the original
 * bytes untouched.
 */
function migrateLegacySetupKeys(parsed) {
    const record = parsed;
    if ("plugin" in record) {
        const legacyPlugin = record["plugin"];
        const pluginsValue = record.plugins;
        if (typeof legacyPlugin === "string" && legacyPlugin.length > 0) {
            if (pluginsValue === undefined) {
                record.plugins = [legacyPlugin];
            }
            else if (Array.isArray(pluginsValue)) {
                if (!pluginsValue.some((entry) => isSameLocalPluginIdentity(entry, legacyPlugin))) {
                    pluginsValue.push(legacyPlugin);
                }
            }
            else if (typeof pluginsValue === "string" && pluginsValue.length > 0) {
                record.plugins = isSameLocalPluginIdentity(pluginsValue, legacyPlugin)
                    ? [pluginsValue]
                    : [pluginsValue, legacyPlugin];
            }
            else {
                throw new Error("legacy V1 `plugin` cannot be merged: existing `plugins` is not the canonical V2 array");
            }
        }
        else if (Array.isArray(legacyPlugin)) {
            const carried = legacyPlugin.filter((entry) => typeof entry === "string" && entry.length > 0);
            if (carried.length !== legacyPlugin.length) {
                throw new Error("legacy V1 `plugin` array holds non-string entries (rejecting before mutation)");
            }
            if (pluginsValue === undefined) {
                record.plugins = [...carried];
            }
            else if (Array.isArray(pluginsValue)) {
                for (const entry of carried) {
                    if (!pluginsValue.some((existing) => isSameLocalPluginIdentity(existing, entry))) {
                        pluginsValue.push(entry);
                    }
                }
            }
            else {
                throw new Error("legacy V1 `plugin` cannot be merged: existing `plugins` is not the canonical V2 array");
            }
        }
        else {
            throw new Error("legacy V1 `plugin` is not a string (rejecting before mutation)");
        }
        delete record["plugin"];
    }
    if ("subagent_depth" in record) {
        const topDepth = record["subagent_depth"];
        if (typeof topDepth === "number" && Number.isFinite(topDepth)) {
            const experimental = (record.experimental ?? {});
            if (experimental.subagent_depth === undefined || experimental.subagent_depth === null) {
                experimental.subagent_depth = topDepth;
                record.experimental = experimental;
            }
        }
        else {
            throw new Error("legacy top-level `subagent_depth` is not a finite number (rejecting before mutation)");
        }
        delete record["subagent_depth"];
    }
    if (record.plugins !== undefined && !Array.isArray(record.plugins)) {
        if (typeof record.plugins === "string" && record.plugins.length > 0) {
            record.plugins = [record.plugins];
        }
        else {
            throw new Error("`plugins` is not the canonical V2 array (rejecting before mutation)");
        }
    }
}
/**
 * Validate a config value against the T008 setup contract: no V1 keys, the
 * ARIA plugin identity registered exactly once (an absolute path and its
 * corresponding `file://` URI count as one identity; a config holding both
 * forms is a duplicate, not exactly-once), the canonical V2 `skills:
 * string[]` with the ARIA root once, and the defaulted depth present. Empty
 * means canonical.
 */
export function validateAriaSetupConfig(config, targets) {
    const issues = findLegacySetupKeys(config);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return [...issues, "config is not an object"];
    }
    const record = config;
    const plugins = record.plugins;
    if (!Array.isArray(plugins)) {
        issues.push("plugins entry is missing or not the canonical V2 array (ARIA plugin URI is not registered)");
    }
    else {
        const occurrences = plugins.filter((entry) => isSameLocalPluginIdentity(entry, targets.pluginUri)).length;
        if (occurrences === 0)
            issues.push("ARIA plugin URI is not registered in plugins[]");
        else if (occurrences > 1)
            issues.push("ARIA plugin URI is registered more than once (duplicate registration)");
    }
    const skillsRoot = targets.skillsRoot ?? getPackageSkillsRoot();
    issues.push(...validateAriaSkillsConfig(config, skillsRoot));
    const depth = record.experimental?.subagent_depth;
    if (depth === undefined || depth === null) {
        issues.push("experimental.subagent_depth is missing (ARIA default 3 is not registered)");
    }
    return issues;
}
// ---------------------------------------------------------------------------
// Project-neutral resolution (global agent files must not bake in CWD state)
// ---------------------------------------------------------------------------
/**
 * Resolve the config that managed global agent files are generated from:
 * packaged defaults plus global overrides, never project-local overrides.
 * Baking a CWD project's models into global files would violate T005
 * ("no global regeneration on project enter"; project overlays are
 * runtime-only via `agent.transform`). The worktree argument is accepted
 * for API compatibility but project reads are skipped.
 */
export function resolveSetupAriaConfig(worktree) {
    return resolveAriaConfig(worktree, { skipProject: true });
}
// ---------------------------------------------------------------------------
// File IO with backup/rollback/idempotence
// ---------------------------------------------------------------------------
/** Default global V2 config path (`$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json`). */
export function defaultGlobalConfigPath(explicit) {
    return opencodeConfigPath(explicit);
}
function backupStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
async function readExistingConfig(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function parseConfigFile(raw, path) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        try {
            parsed = JSON.parse(stripJsoncComments(raw));
        }
        catch (error) {
            throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${path}: expected a JSON object at the config root`);
    }
    return parsed;
}
/** Atomic write: temp file in the same directory, then rename into place. */
async function writeFileAtomic(path, content) {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, path);
    }
    catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
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
export async function ensureAriaSetupConfigFile(options) {
    const path = options.configPath ?? defaultGlobalConfigPath();
    const skillsRoot = options.skillsRoot ?? getPackageSkillsRoot();
    const existing = await readExistingConfig(path);
    const parsed = existing === undefined ? {} : parseConfigFile(existing, path);
    const before = JSON.stringify(parsed);
    migrateLegacySetupKeys(parsed);
    let migratedLegacySkills = false;
    const skillsValue = parsed.skills;
    if (skillsValue !== undefined && !Array.isArray(skillsValue)) {
        const carried = legacySkillStrings(skillsValue);
        // Append only when absent: `paths` may already hold the ARIA root, and
        // the V2 applier below is also idempotent, so never emit a duplicate.
        parsed.skills = carried.includes(skillsRoot) ? carried : [...carried, skillsRoot];
        migratedLegacySkills = true;
    }
    const applied = applyAriaSetupToConfig(parsed, {
        pluginUri: options.pluginUri,
        skillsRoot,
    });
    const issues = validateAriaSetupConfig(parsed, { pluginUri: options.pluginUri, skillsRoot });
    if (issues.length > 0) {
        throw new Error(`${path}: invalid setup config (${issues.join("; ")})`);
    }
    if (existing !== undefined && JSON.stringify(parsed) === before) {
        return {
            path,
            changed: false,
            created: false,
            pluginsAdded: false,
            skillsAdded: false,
            depthFilled: false,
            migratedLegacySkills: false,
        };
    }
    await mkdir(dirname(path), { recursive: true });
    const content = `${JSON.stringify(parsed, null, 2)}\n`;
    if (existing === undefined) {
        await writeFileAtomic(path, content);
        return {
            path,
            changed: true,
            created: true,
            pluginsAdded: applied.pluginsAdded,
            skillsAdded: applied.skillsAdded,
            depthFilled: applied.depthFilled,
            migratedLegacySkills,
        };
    }
    // Atomic replacement: preserve the original through backup + prep, then
    // rename over the live path. The backup is a copy (never a move), so
    // concurrent readers see old-or-new bytes, never a missing file.
    const backupPath = `${path}.aria-backup-${backupStamp()}`;
    await writeFile(backupPath, existing, { encoding: "utf8", flag: "wx" });
    try {
        await writeFileAtomic(path, content);
    }
    catch (error) {
        await unlink(backupPath).catch(() => undefined);
        throw error;
    }
    return {
        path,
        changed: true,
        created: false,
        pluginsAdded: applied.pluginsAdded,
        skillsAdded: applied.skillsAdded,
        depthFilled: applied.depthFilled,
        migratedLegacySkills,
        backupPath,
        previousContents: existing,
    };
}
/**
 * Roll back one `ensureAriaSetupConfigFile` result: restore the backup when
 * an existing file was replaced, remove only a file this call created, and
 * otherwise rewrite the replaced bytes verbatim. No-change results are
 * no-ops.
 */
export async function rollbackSetupConfigFile(path, state) {
    if (!state.changed)
        return;
    if (state.backupPath) {
        await rename(state.backupPath, path);
        return;
    }
    if (state.previousContents !== undefined) {
        await writeFileAtomic(path, state.previousContents);
        return;
    }
    if (state.created) {
        await unlink(path).catch(() => undefined);
    }
}
//# sourceMappingURL=setup-config.js.map