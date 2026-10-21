import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeConfigPath, stripJsoncComments } from "./deps.js";
import { resolveAriaConfig } from "./overrides.js";
import { applyExperimentalSubagentDepthDefault } from "./permissions.js";
import { applyAriaSkillsToConfig, areEquivalentSkillsPaths, getPackageSkillsRoot, isAriaPackageSkillsPath, validateAriaSkillsConfig } from "./skills.js";
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
 * Apply the full ARIA V2 setup (default agent + plugins + skills + depth
 * default) to an already-parsed config object. Returns per-key outcomes;
 * never emits V1 keys (no singular `plugin`, no `skills.paths`/`urls`, no
 * top-level `subagent_depth`).
 */
export function applyAriaSetupToConfig(config, targets) {
    const skillsRoot = targets.skillsRoot ?? getPackageSkillsRoot();
    const defaultAgentBefore = config.default_agent;
    const defaultAgentFilled = defaultAgentBefore === undefined
        || defaultAgentBefore === null
        || (typeof defaultAgentBefore === "string" && defaultAgentBefore.trim().length === 0);
    if (defaultAgentFilled) {
        config.default_agent = "coder";
    }
    const pluginsAdded = applyAriaPluginToConfig(config, targets.pluginUri).added;
    const skillsAdded = applyAriaSkillsToConfig(config, skillsRoot).added;
    const depthBefore = config.experimental?.subagent_depth;
    applyExperimentalSubagentDepthDefault(config);
    return {
        defaultAgentFilled,
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
/**
 * Pure T002 selection among the pinned names from existence alone: exactly
 * one existing file wins, none means the canonical creation target, and both
 * existing is ambiguous. Parseability and extension order never decide —
 * callers must fail closed on `"ambiguous"`.
 */
export function selectSetupConfigKind(jsonExists, jsoncExists) {
    if (jsonExists && jsoncExists)
        return "ambiguous";
    if (jsonExists)
        return "json";
    if (jsoncExists)
        return "jsonc";
    return "missing";
}
async function configFileExists(path) {
    try {
        const info = await stat(path);
        return info.isFile();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function ambiguousConfigError(jsonPath, jsoncPath) {
    return new Error(`Ambiguous global OpenCode config: both ${jsonPath} and ${jsoncPath} exist. ` +
        `OpenCode reads ${jsonPath} (opencode.json) when both are present, so changing either file alone ` +
        `could shadow user-owned settings in the other, and nothing proves which file is redundant: ` +
        `ARIA writes no ownership marker into this config and ownership is never inferred from keys or values. ` +
        `No file was created, modified, or backed up. Keep the single file OpenCode should read ` +
        `(merging any settings worth keeping into it), remove the redundant file, then re-run setup.`);
}
/**
 * Resolve the requested global config path to the canonical discovery
 * target. For the pinned `opencode.json` / `opencode.jsonc` basenames the
 * sibling directory is inspected: a single existing file is updated in
 * place (so a pre-existing `.jsonc` is never shadowed by a newly created
 * `.json`), absence creates the canonical `opencode.json` — or the
 * explicitly requested sibling when the caller named one — and both
 * existing fails closed before any mutation (never by parseability or
 * extension order).
 *
 * No safe automatic repair exists: pinned precedence says which file is
 * *effective*, not which is *redundant*, and this config carries no
 * durable ARIA ownership marker (agent files have one; config keys such as
 * `plugins`/`skills` are explicitly not ownership evidence). In
 * particular the v1.0.6 state — a pre-existing `opencode.jsonc` plus the
 * `opencode.json` the old setup path created alongside it — fails closed
 * here even when one file looks ARIA-shaped. Non-`opencode.json(c)`
 * basenames (explicit test seams) resolve to the requested path unchanged.
 */
async function resolveSetupConfigPath(requestedPath, explicit) {
    const base = basename(requestedPath);
    if (base !== "opencode.json" && base !== "opencode.jsonc")
        return requestedPath;
    const dir = dirname(requestedPath);
    const jsonPath = join(dir, "opencode.json");
    const jsoncPath = join(dir, "opencode.jsonc");
    const [jsonExists, jsoncExists] = await Promise.all([configFileExists(jsonPath), configFileExists(jsoncPath)]);
    switch (selectSetupConfigKind(jsonExists, jsoncExists)) {
        case "ambiguous":
            throw ambiguousConfigError(jsonPath, jsoncPath);
        case "json":
            return jsonPath;
        case "jsonc":
            return jsoncPath;
        case "missing":
            return explicit ? requestedPath : jsonPath;
    }
}
/**
 * T001 hotfix preflight: read-only canonical-config discovery shared with
 * `ensureAriaSetupConfigFile`. Runs before any `opencode plugin add`
 * executor mutation in `setup()` so a dual-file (`opencode.json` plus
 * `opencode.jsonc`) state fails closed with neither file touched and zero
 * mutating executor calls. Only stats the sibling directory — never creates,
 * modifies, or backs up any file. Ambiguity detection is the exact
 * `resolveSetupConfigPath` path above (same basenames, same directory, same
 * `selectSetupConfigKind` rule, same error), so this gate and the later
 * config-writing phase can never disagree. The `explicit` flag only selects
 * the missing-case creation target (discarded here); it never affects
 * ambiguity. `setup()` always resolves to a concrete path before calling, so
 * `true` matches `ensureAriaSetupConfigFile`'s view.
 */
export async function assertSetupConfigNotAmbiguous(requestedPath) {
    await resolveSetupConfigPath(requestedPath, true);
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
 * Ensure the global V2 config carries the ARIA setup (`default_agent`
 * default `coder` only when unconfigured, exact plugin URI,
 * single skills root, depth default 3). The target is the canonical
 * discovery selection: a single existing `opencode.json` or
 * `opencode.jsonc` is updated in place (parsed JSONC-tolerantly, written
 * back to the same path), absence creates the canonical `opencode.json`,
 * and both existing fails closed with neither file touched. Unrelated user
 * keys are preserved;
 * a replaced file is backed up first (as a copy, so the live path is never
 * missing); no write happens when nothing changed. ARIA-relevant V1 keys
 * (`plugin` singular, top-level `subagent_depth`) migrate forward with
 * backup; anything unmigratable rejects before mutation. A legacy non-array
 * `skills` object migrates forward with backup (preserved string entries
 * from `paths`/`urls`, ARIA root appended once). The resulting config is
 * validated before commit and rejects without touching the file when invalid.
 */
export async function ensureAriaSetupConfigFile(options) {
    const requestedPath = options.configPath ?? defaultGlobalConfigPath();
    const path = await resolveSetupConfigPath(requestedPath, options.configPath !== undefined);
    const skillsRoot = options.skillsRoot ?? getPackageSkillsRoot();
    const existing = await readExistingConfig(path);
    const parsed = existing === undefined ? {} : parseConfigFile(existing, path);
    const before = JSON.stringify(parsed);
    migrateLegacySetupKeys(parsed);
    let migratedLegacySkills = false;
    const skillsValue = parsed.skills;
    if (skillsValue !== undefined && !Array.isArray(skillsValue)) {
        const carried = legacySkillStrings(skillsValue);
        // Preserve equivalent aliases; reconcile the first stale owned legacy
        // path in place before appending a new root.
        if (carried.length === 0)
            carried.push(skillsRoot);
        const equivalent = carried.some((entry) => areEquivalentSkillsPaths(entry, skillsRoot));
        const staleIndex = equivalent ? -1 : carried.findIndex((entry) => isAriaPackageSkillsPath(entry));
        if (staleIndex >= 0)
            carried[staleIndex] = skillsRoot;
        else if (!equivalent && carried.length > 0)
            carried.push(skillsRoot);
        parsed.skills = carried;
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
            defaultAgentFilled: false,
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
            defaultAgentFilled: applied.defaultAgentFilled,
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
        defaultAgentFilled: applied.defaultAgentFilled,
        pluginsAdded: applied.pluginsAdded,
        skillsAdded: applied.skillsAdded,
        depthFilled: applied.depthFilled,
        migratedLegacySkills,
        backupPath,
        previousContents: existing,
    };
}
/**
 * T011 — splice the owned skills entry into the original config source
 * without rewriting any other byte.
 *
 * The parsed decision stays single-sourced with `applyAriaSkillsToConfig`
 * (same `isAriaPackageSkillsPath` ownership predicate: exactly one stale
 * packaged entry with no current root refreshes in place; zero owned
 * entries with no current root appends alongside unrelated entries;
 * anything else is ambiguous and throws before any mutation). This helper
 * only serializes that already-validated decision into `source`:
 * - refresh: replace the stale entry's string literal span with the
 *   `JSON.stringify` literal of `skillsRoot`;
 * - append: insert `, "<root>"` immediately after the last element's
 *   literal (an existing trailing comma stays where it is, so no second
 *   comma is ever emitted).
 *
 * The `skills` array is located JSONC-tolerantly (whitespace, `//` line and
 * `/* ... *\/` block comments skipped, string escapes honored) at the
 * config root; the located element values must decode exactly to
 * `beforeSkills`, otherwise this throws fail-closed (never a guessed
 * rewrite). Comments, whitespace, key order, separators, and the trailing
 * newline of `source` are preserved verbatim.
 */
function spliceOwnedSkillsIntoSource(source, beforeSkills, skillsRoot, path) {
    const failClosed = (reason) => new Error(`${path}: skills refresh cannot locate the owned entry surgically (${reason}). No changes were made.`);
    const skipTrivia = (index) => {
        let cursor = index;
        while (cursor < source.length) {
            const char = source[cursor];
            if (char === " " || char === "\t" || char === "\n" || char === "\r") {
                cursor += 1;
                continue;
            }
            if (char === "/" && source[cursor + 1] === "/") {
                cursor += 2;
                while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r")
                    cursor += 1;
                continue;
            }
            if (char === "/" && source[cursor + 1] === "*") {
                const close = source.indexOf("*/", cursor + 2);
                if (close === -1)
                    return source.length;
                cursor = close + 2;
                continue;
            }
            break;
        }
        return cursor;
    };
    const readStringEnd = (start) => {
        let cursor = start + 1;
        let escaped = false;
        while (cursor < source.length) {
            const char = source[cursor];
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                return cursor + 1;
            }
            cursor += 1;
        }
        return -1;
    };
    const decodeString = (start, end) => {
        try {
            const value = JSON.parse(source.slice(start, end));
            if (typeof value !== "string")
                throw new Error("not a string");
            return value;
        }
        catch {
            throw failClosed("a skills string literal does not decode");
        }
    };
    // Locate the top-level `skills` array open bracket (root object depth 1,
    // outside any nested array).
    let braceDepth = 0;
    let bracketDepth = 0;
    let arrayOpen = -1;
    let cursor = 0;
    while (cursor < source.length) {
        cursor = skipTrivia(cursor);
        if (cursor >= source.length)
            break;
        const char = source[cursor];
        if (char === '"') {
            const end = readStringEnd(cursor);
            if (end === -1)
                throw failClosed("unterminated string literal");
            const value = decodeString(cursor, end);
            const after = skipTrivia(end);
            if (value === "skills" && braceDepth === 1 && bracketDepth === 0 && source[after] === ":") {
                const open = skipTrivia(after + 1);
                if (source[open] !== "[")
                    throw failClosed("the skills value is not an array in source");
                arrayOpen = open;
                break;
            }
            cursor = end;
            continue;
        }
        if (char === "{")
            braceDepth += 1;
        else if (char === "}")
            braceDepth -= 1;
        else if (char === "[")
            bracketDepth += 1;
        else if (char === "]")
            bracketDepth -= 1;
        cursor += 1;
    }
    if (arrayOpen === -1)
        throw failClosed("no top-level skills array found");
    // Collect the array element string spans (depth 1 only; nested values skipped).
    const spans = [];
    let depth = 1;
    cursor = arrayOpen + 1;
    let arrayClosed = false;
    while (cursor < source.length) {
        cursor = skipTrivia(cursor);
        if (cursor >= source.length)
            break;
        const char = source[cursor];
        if (char === '"') {
            const end = readStringEnd(cursor);
            if (end === -1)
                throw failClosed("unterminated string literal in the skills array");
            if (depth === 1)
                spans.push({ start: cursor, end, value: decodeString(cursor, end) });
            cursor = end;
            continue;
        }
        if (char === "[" || char === "{") {
            depth += 1;
            cursor += 1;
            continue;
        }
        if (char === "]" || char === "}") {
            depth -= 1;
            cursor += 1;
            if (depth === 0) {
                arrayClosed = true;
                break;
            }
            continue;
        }
        cursor += 1;
    }
    if (!arrayClosed)
        throw failClosed("the skills array never closes in source");
    if (spans.length !== beforeSkills.length) {
        throw failClosed(`source holds ${spans.length} skills strings but the parsed config holds ${beforeSkills.length}`);
    }
    for (const [index, span] of spans.entries()) {
        const expected = beforeSkills[index];
        if (typeof expected !== "string" || span === undefined || span.value !== expected) {
            throw failClosed(`skills entry ${index} differs between source and parsed config`);
        }
    }
    const currentCount = beforeSkills.filter((entry) => areEquivalentSkillsPaths(entry, skillsRoot)).length;
    const staleIndices = [];
    beforeSkills.forEach((entry, index) => {
        if (!areEquivalentSkillsPaths(entry, skillsRoot) && isAriaPackageSkillsPath(entry))
            staleIndices.push(index);
    });
    if (staleIndices.length === 1 && currentCount === 0) {
        const staleIndex = staleIndices[0];
        const span = staleIndex === undefined ? undefined : spans[staleIndex];
        if (span === undefined)
            throw failClosed("the stale skills entry is not in source");
        return `${source.slice(0, span.start)}${JSON.stringify(skillsRoot)}${source.slice(span.end)}`;
    }
    if (staleIndices.length === 0 && currentCount === 0 && spans.length > 0) {
        const last = spans[spans.length - 1];
        if (last === undefined)
            throw failClosed("the skills array is empty in source");
        return `${source.slice(0, last.end)}, ${JSON.stringify(skillsRoot)}${source.slice(last.end)}`;
    }
    throw failClosed("the parsed skills decision is not a single refresh or append");
}
/**
 * T007 v1.0.14 — skills-only refresh for the upgrade continuation
 * (strict, fail-closed, no plugin/depth/agent touch).
 *
 * Reads the canonical discovery target (single existing `opencode.json` or
 * `opencode.jsonc` updated in place; both existing fails closed; missing
 * file fails closed — setup owns creation, upgrade never creates), applies
 * only `applyAriaSkillsToConfig` (single stale packaged
 * `node_modules/aria/skills` → current in place; current idempotent;
 * unrelated entries preserved in order), validates only
 * `validateAriaSkillsConfig`, and splices only the owned entry into the
 * original source bytes atomically with backup only when the skills value
 * changed (T011: a single stale string is replaced in place, an append
 * inserts after the last element — comments, whitespace, key order, and
 * the trailing newline are preserved verbatim). No skills directory is
 * deleted; no unrelated config is rewritten.
 *
 * Fails closed without touching the file when ownership is ambiguous:
 * missing file, missing `skills` key, non-array `skills` (legacy objects
 * stay with T008 migration), explicitly empty `[]`, multiple owned entries
 * (two packaged paths, or packaged stale plus current), duplicate current,
 * or non-string/empty-string entries. The throw happens before any backup
 * or replacement, so the original bytes stay intact with no stray files.
 */
export async function ensureAriaSkillsRefreshFile(options) {
    const requestedPath = options.configPath ?? defaultGlobalConfigPath();
    const path = await resolveSetupConfigPath(requestedPath, options.configPath !== undefined);
    const skillsRoot = options.skillsRoot ?? getPackageSkillsRoot();
    const existing = await readExistingConfig(path);
    if (existing === undefined) {
        throw new Error(`${path}: skills refresh blocked (config file is missing; refusing to guess). No changes were made.`);
    }
    const parsed = parseConfigFile(existing, path);
    const before = JSON.stringify(parsed);
    if (parsed.skills === undefined) {
        throw new Error(`${path}: skills entry is missing (no positively owned ARIA path to refresh; refusing to guess). No changes were made.`);
    }
    const beforeSkills = JSON.stringify(parsed.skills);
    applyAriaSkillsToConfig(parsed, skillsRoot);
    const issues = validateAriaSkillsConfig(parsed, skillsRoot);
    if (issues.length > 0) {
        throw new Error(`${path}: invalid skills config (${issues.join("; ")}). No changes were made.`);
    }
    if (JSON.stringify(parsed) === before) {
        return { path, changed: false, refreshed: false, added: false };
    }
    const beforeArray = JSON.parse(beforeSkills);
    const afterArray = parsed.skills;
    // Replace-in-place keeps the array length (single stale → current);
    // append grows it (zero owned → current alongside unrelated).
    const refreshed = Array.isArray(beforeArray) && Array.isArray(afterArray)
        && beforeArray.length === afterArray.length;
    const added = !refreshed;
    // T011 surgical write: only the owned string changes; every other source
    // byte (comments, whitespace, key order, trailing newline) is preserved.
    // A locate failure throws fail-closed before any backup or replacement.
    const content = spliceOwnedSkillsIntoSource(existing, beforeArray, skillsRoot, path);
    await mkdir(dirname(path), { recursive: true });
    const backupPath = `${path}.aria-backup-${backupStamp()}`;
    await writeFile(backupPath, existing, { encoding: "utf8", flag: "wx" });
    try {
        await writeFileAtomic(path, content);
    }
    catch (error) {
        await unlink(backupPath).catch(() => undefined);
        throw error;
    }
    return { path, changed: true, refreshed, added, backupPath, previousContents: existing };
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