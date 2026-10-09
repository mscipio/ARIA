import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripJsoncComments } from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
// ---------------------------------------------------------------------------
// Quota 5 dual policy (T007) — upgrade-only single owner
// ---------------------------------------------------------------------------
//
// Quota 5 stays optional: the setup bootstrap lifecycle (`ensureQuotaForLifecycle`
// in `./dependencies.js`: absent → install-if-missing via `installQuotaIfMissing`
// in `./bootstrap.js`; identified Quota 5 → gated update via `upgradeQuota` below)
// may manage it under safety/ownership gates. The legacy `deps sync` path
// (`depsSync` in `./deps.js`) remains non-version-chasing and does not
// independently chase or install Quota (`SyncResult` carries no quota field,
// and the setup file phases never write quota entries).
// This module is the single upgrade-only owner, consumed by the future
// `aria upgrade` orchestration (T010):
//
// - `checkQuotaUpgrade` is strictly read-only inventory (`opencode plugin
//   list` plus the XDG-contained global config): installed spec/version plus
//   a status. Unknown or unsafe targets report observed/unmanaged with zero
//   mutation.
// - `upgradeQuota` upgrades an already-installed Quota 5 ONLY when its
//   installed npm target is positively identified as Quota 5 (exactly one
//   distinct exact-semver `5.x` spec across the plugin list and the global
//   config) AND the native `opencode-quota update --dry-run` preview exits
//   cleanly for that target on OpenCode 2 with no downgrade risk.
//   Each attempted upgrade is validated (the plugin list still carries the
//   quota plugin exactly once and the global config still carries a quota
//   entry with unrelated entries preserved — the TUI and server surfaces)
//   and the snapshotted global config is rolled back where feasible.
//
// Failure anywhere before the apply leaves every file byte-identical. The
// package-cache cleanup the updater performs after its own config
// verification cannot be rolled back and is reported, never guessed.
//
// Evidence basis (read-only; no upstream installer was executed): Quota 5 is
// an OpenCode V2 server plugin (`@slkiser/opencode-quota.server`, providing
// the `quota_status` tool, slash commands, quota RPC for the TUI surfaces,
// and session hooks) installed as an npm spec such as
// `@slkiser/opencode-quota@5.0.2` in the global `plugins[]`. Its supported
// update mechanism is its own `update` command (`--dry-run` previews without
// writing; `--yes` applies only safe setting/cache work after the preview
// and never moves or deletes secrets). Quota 5 needs OpenCode 2: on
// OpenCode 1 the updater pins Quota to `@4`, so OpenCode 1 is an unsafe
// target for a Quota 5 upgrade and stays report-only.
/** npm package providing Quota. */
export const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
/** V2 server plugin ID registered by the Quota package. */
export const QUOTA_PLUGIN_ID = "@slkiser/opencode-quota.server";
/** Only this major is eligible for a managed Quota upgrade. */
export const QUOTA_MAJOR = 5;
/** Binary invoked for the native update preview/apply (never for setup/sync). */
const QUOTA_UPDATE_BIN = "opencode-quota";
/**
 * Moving tags the updater keeps as written (never positively versioned, so
 * never eligible as an identified upgrade target).
 */
const QUOTA_MOVING_TAGS = new Set(["latest", "next", "4"]);
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/**
 * True when the text names exactly the Quota package (npm spec, plugin ID,
 * or config entry). A fork such as `@slkiser/opencode-quota-extra` does not
 * match: the character after the package name must end the name or start a
 * version/namespace suffix (`@`, `.`, `/`, `:`).
 */
export function mentionsQuotaPackage(text) {
    if (typeof text !== "string")
        return false;
    const index = text.indexOf(QUOTA_PACKAGE_NAME);
    if (index === -1)
        return false;
    const next = text[index + QUOTA_PACKAGE_NAME.length];
    return next === undefined || next === "@" || next === "." || next === "/" || next === ":";
}
/**
 * Classify a plugin spec string. Returns null when the spec is not
 * quota-related at all (unrelated entries are ignored, never upgraded).
 * Quota-related names that are not plain npm specs for exactly this package
 * (Git specs, file paths, local directories, similarly named forks that
 * passed the caller pre-filter) report the `foreign` channel so the adapter
 * fails closed with `unsupported-ownership` instead of guessing.
 */
export function describeQuotaSpec(spec) {
    if (!mentionsQuotaPackage(spec))
        return null;
    if (spec === QUOTA_PACKAGE_NAME)
        return { spec, channel: "npm", version: null };
    if (spec.startsWith(`${QUOTA_PACKAGE_NAME}@`)) {
        const version = spec.slice(QUOTA_PACKAGE_NAME.length + 1);
        if (version.length === 0 || version.includes("/") || version.includes(" ") || version.includes("#")) {
            return { spec, channel: "foreign", version: null };
        }
        return { spec, channel: "npm", version };
    }
    return { spec, channel: "foreign", version: null };
}
/** Leading major of a dotted version; null when absent or unparseable. */
export function quotaMajor(version) {
    if (!version)
        return null;
    const match = version.match(/^(\d+)\./);
    const majorText = match?.[1];
    if (majorText === undefined)
        return null;
    const major = Number.parseInt(majorText, 10);
    return Number.isFinite(major) ? major : null;
}
/**
 * Extract quota rows from `opencode plugin list` output. Returns null when
 * the output shape is unrecognized (never guessed); an empty array when the
 * list is recognized and carries no quota rows.
 */
export function quotaEntriesFromPluginList(stdout) {
    const lines = stdout.split("\n");
    if (lines.some((line) => line.trim().toLowerCase() === "no plugins found"))
        return [];
    const headerIndex = lines.findIndex((line) => /^\s*ID\s+VERSION\s+SOURCE\s*$/i.test(line));
    if (headerIndex === -1)
        return null;
    const entries = [];
    for (let index = headerIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        if (line === undefined || line.trim() === "")
            continue;
        // ID and VERSION contain no spaces; SOURCE is the remainder (paths may
        // contain spaces).
        const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
        const id = match?.[1];
        const version = match?.[2];
        const target = match?.[3]?.trim();
        if (!id || !version || !target)
            continue;
        if (mentionsQuotaPackage(id) || mentionsQuotaPackage(target)) {
            entries.push({ id, version, target });
        }
    }
    return entries;
}
function specFromPluginEntry(entry) {
    if (typeof entry === "string")
        return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string")
        return entry[0];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const pkg = entry["package"];
        if (typeof pkg === "string")
            return pkg;
    }
    return null;
}
/** Every plugin spec string in the parsed global config (`plugins`/`plugin`). */
function allPluginSpecsFromConfig(parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return [];
    const root = parsed;
    const specs = [];
    for (const key of ["plugins", "plugin"]) {
        const list = root[key];
        if (!Array.isArray(list))
            continue;
        for (const entry of list) {
            const spec = specFromPluginEntry(entry);
            if (spec !== null)
                specs.push(spec);
        }
    }
    return specs;
}
/** Quota plugin specs in the parsed global config (string/tuple/object forms). */
export function quotaSpecsFromConfig(parsed) {
    return allPluginSpecsFromConfig(parsed).filter((spec) => mentionsQuotaPackage(spec));
}
/**
 * Positively identify the installed Quota target from the union of
 * plugin-list SOURCE values and global-config specs. Exactly one distinct
 * exact-semver `5.x` npm spec identifies; anything else fails closed:
 * absent (nothing installed), unknown-target (ambiguous or not positively
 * versioned — never guessed), or unsupported-ownership (foreign channel or
 * a major this policy does not upgrade).
 */
export function identifyQuotaTarget(listSpecs, configSpecs) {
    const distinct = [...new Set([...listSpecs, ...configSpecs])];
    if (distinct.length === 0)
        return { kind: "absent" };
    if (distinct.length > 1) {
        return {
            kind: "unknown-target",
            reason: `multiple distinct quota targets observed (${distinct.join(", ")}); refusing to guess`,
        };
    }
    const spec = distinct[0];
    if (spec === undefined)
        return { kind: "absent" };
    const info = describeQuotaSpec(spec);
    if (info === null) {
        return { kind: "unknown-target", reason: `quota target is not positively identified (${spec})` };
    }
    if (info.channel !== "npm") {
        return {
            kind: "unsupported-ownership",
            reason: `quota installed from a non-npm channel (${spec}); ownership unsupported, leaving untouched`,
        };
    }
    if (info.version === null) {
        return {
            kind: "unknown-target",
            reason: `quota spec carries no version (${spec}); installed version not positively identified`,
        };
    }
    if (QUOTA_MOVING_TAGS.has(info.version)) {
        return {
            kind: "unknown-target",
            reason: `quota spec is a moving tag (${spec}); installed version not positively identified`,
        };
    }
    if (!EXACT_SEMVER_RE.test(info.version)) {
        return {
            kind: "unknown-target",
            reason: `quota version is not an exact release (${spec}); installed target not positively identified`,
        };
    }
    const major = quotaMajor(info.version);
    if (major !== QUOTA_MAJOR) {
        return {
            kind: "unsupported-ownership",
            reason: `quota major is ${major ?? "unknown"} (this policy upgrades only Quota ${QUOTA_MAJOR}); leaving untouched`,
        };
    }
    return { kind: "identified", spec, version: info.version };
}
/**
 * Read the XDG-contained global config for quota specs. Both
 * `opencode.json` and `opencode.jsonc` existing is dual-file ambiguity
 * (T002): fail closed with `ambiguous` and mutate neither file.
 */
async function readQuotaConfigState(configDir) {
    const base = openCodeGlobalDir(configDir);
    const jsonPath = join(base, "opencode.json");
    const jsoncPath = join(base, "opencode.jsonc");
    let jsonRaw = null;
    let jsoncRaw = null;
    try {
        jsonRaw = await readFile(jsonPath);
    }
    catch {
        jsonRaw = null;
    }
    try {
        jsoncRaw = await readFile(jsoncPath);
    }
    catch {
        jsoncRaw = null;
    }
    if (jsonRaw !== null && jsoncRaw !== null)
        return { kind: "ambiguous" };
    if (jsonRaw !== null) {
        return parseQuotaConfigFile(jsonPath, jsonRaw, false);
    }
    if (jsoncRaw !== null) {
        return parseQuotaConfigFile(jsoncPath, jsoncRaw, true);
    }
    return { kind: "missing" };
}
function parseQuotaConfigFile(path, raw, jsonc) {
    try {
        const text = raw.toString("utf8");
        const normalized = jsonc ? stripJsoncComments(text) : text;
        const parsed = JSON.parse(normalized);
        return { kind: "single", path, raw, specs: quotaSpecsFromConfig(parsed), parsed, unparseable: false };
    }
    catch {
        return { kind: "single", path, raw, specs: [], parsed: null, unparseable: true };
    }
}
async function runPluginList(executor) {
    try {
        const result = await executor("opencode", ["plugin", "list"]);
        return { ok: true, stdout: result.stdout };
    }
    catch {
        return { ok: false };
    }
}
function parseOpenCodeMajor(output) {
    const match = output.match(/(\d+)\.\d+\.\d+/);
    const majorText = match?.[1];
    if (majorText === undefined)
        return null;
    const major = Number.parseInt(majorText, 10);
    return Number.isFinite(major) ? major : null;
}
/**
 * Strictly read-only Quota inventory for setup/sync reporting and the
 * future upgrade `--check` table: installed spec/version plus a status.
 * Never invokes the updater and never writes. Identified Quota 5 reports
 * `unmanaged-observed` — observed for the setup bootstrap lifecycle to manage
 * under safety/ownership gates, while the legacy `deps sync` path performs
 * no Quota installation or config mutation.
 */
export async function checkQuotaUpgrade(executor, configDir) {
    const listResult = await runPluginList(executor);
    const listEntries = listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
    const configState = await readQuotaConfigState(configDir);
    if (configState.kind === "ambiguous") {
        return {
            status: "unknown-target",
            installedSpec: null,
            installedVersion: null,
            detail: "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated",
        };
    }
    if (listEntries === null && configState.kind === "missing") {
        return {
            status: "unknown-target",
            installedSpec: null,
            installedVersion: null,
            detail: "plugin list unavailable and no global config observed; installed target not positively identified",
        };
    }
    const listSpecs = listEntries === null ? [] : listEntries.map((entry) => entry.target);
    const identified = identifyQuotaTarget(listSpecs, configState.kind === "single" ? configState.specs : []);
    if (identified.kind === "absent") {
        return { status: "skipped", installedSpec: null, installedVersion: null, detail: "no Quota installation observed; nothing to upgrade" };
    }
    if (identified.kind === "identified") {
        return {
            status: "unmanaged-observed",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            detail: `Quota ${identified.version} observed and user-managed; setup and deps sync perform no Quota installation or config mutation`,
        };
    }
    return { status: identified.kind, installedSpec: null, installedVersion: null, detail: identified.reason };
}
function reportOnly(status, installedSpec, installedVersion, detail) {
    return { status, installedSpec, installedVersion, resultingSpec: null, detail, mutated: false };
}
async function restoreSnapshot(snapshot) {
    if (snapshot === null)
        return false;
    try {
        await writeFile(snapshot.path, snapshot.raw);
        return true;
    }
    catch {
        return false;
    }
}
function multisetEqual(left, right) {
    if (left.length !== right.length)
        return false;
    const counts = new Map();
    for (const item of left)
        counts.set(item, (counts.get(item) ?? 0) + 1);
    for (const item of right) {
        const remaining = counts.get(item) ?? 0;
        if (remaining === 0)
            return false;
        counts.set(item, remaining - 1);
    }
    return true;
}
/**
 * Gated Quota 5 upgrade for `aria upgrade` (T010 wires this; setup and sync
 * never call it). Inventory first: the installed target must be positively
 * identified as Quota 5. Safety second: OpenCode must be major 2 (on major 1
 * the native updater would pin Quota to `@4`, a downgrade) and the native
 * `opencode-quota update --dry-run` preview must exit cleanly. Only then
 * `opencode-quota update --yes` applies, followed by validation that the
 * TUI and server surfaces survived (plugin list still carries the quota
 * plugin exactly once; the global config still carries a quota entry with
 * unrelated entries preserved). Validation failure rolls the snapshotted
 * global config back where feasible.
 */
export async function upgradeQuota(executor, options = {}) {
    const configDir = options.configDir;
    // XDG guard: a divergent explicit dir is not honored by the native
    // updater, so a mutating update must not run against it.
    if (configDir !== undefined && resolve(configDir) !== resolve(openCodeGlobalDir())) {
        return reportOnly("unmanaged-observed", null, null, "explicit config dir diverges from the effective OpenCode global dir; native updater targeting cannot be verified, leaving Quota untouched");
    }
    const listResult = await runPluginList(executor);
    const listEntries = listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
    const configState = await readQuotaConfigState(configDir);
    if (configState.kind === "ambiguous") {
        return reportOnly("unknown-target", null, null, "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated");
    }
    if (listEntries === null && configState.kind === "missing") {
        return reportOnly("unknown-target", null, null, "plugin list unavailable and no global config observed; installed target not positively identified");
    }
    const listSpecs = listEntries === null ? [] : listEntries.map((entry) => entry.target);
    const identified = identifyQuotaTarget(listSpecs, configState.kind === "single" ? configState.specs : []);
    if (identified.kind === "absent") {
        return reportOnly("skipped", null, null, "no Quota installation observed; nothing to upgrade");
    }
    if (identified.kind === "unknown-target" || identified.kind === "unsupported-ownership") {
        return reportOnly(identified.kind, null, null, identified.reason);
    }
    // Safety gate 1: OpenCode major must be 2 for a Quota 5 upgrade.
    let openCodeMajor = null;
    try {
        const probed = await executor("opencode", ["--version"]);
        openCodeMajor = parseOpenCodeMajor(probed.stdout);
    }
    catch {
        openCodeMajor = null;
    }
    if (openCodeMajor !== 2) {
        return reportOnly("unmanaged-observed", identified.spec, identified.version, openCodeMajor === null
            ? `Quota ${identified.version} identified (${identified.spec}) but the OpenCode version is not positively identified; native update safety cannot be demonstrated, leaving Quota untouched`
            : `Quota ${identified.version} identified (${identified.spec}) but OpenCode major is ${openCodeMajor} (Quota 5 needs OpenCode 2; the native updater would pin @4); leaving Quota untouched`);
    }
    // Safety gate 2: the native read-only preview must exit cleanly.
    try {
        await executor(QUOTA_UPDATE_BIN, ["update", "--dry-run"]);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return reportOnly("unmanaged-observed", identified.spec, identified.version, `Quota ${identified.version} identified (${identified.spec}) but the native update preview failed (${reason}); leaving Quota untouched`);
    }
    const snapshot = configState.kind === "single" ? { path: configState.path, raw: configState.raw } : null;
    const beforeNonQuota = configState.kind === "single" && !configState.unparseable
        ? allPluginSpecsFromConfig(configState.parsed).filter((spec) => !mentionsQuotaPackage(spec))
        : null;
    const beforeListText = listEntries === null ? null : JSON.stringify(listEntries);
    // Apply: safe setting/cache work only, after the demonstrated-safe preview.
    try {
        await executor(QUOTA_UPDATE_BIN, ["update", "--yes"]);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const rolledBack = await restoreSnapshot(snapshot);
        return {
            status: "update-failed",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            resultingSpec: null,
            detail: `native update failed (${reason}). ${snapshot === null
                ? "No global config snapshot existed; config state is exactly as the updater left it."
                : rolledBack
                    ? `Global config restored to the pre-upgrade bytes (${snapshot.path}).`
                    : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`}`,
            mutated: true,
            rolledBack,
        };
    }
    // Validate: TUI + server surfaces survived.
    const afterListResult = await runPluginList(executor);
    const afterEntries = afterListResult.ok ? quotaEntriesFromPluginList(afterListResult.stdout) : null;
    const afterState = await readQuotaConfigState(configDir);
    const validationProblems = [];
    if (afterEntries === null) {
        validationProblems.push("post-upgrade plugin list is unavailable or unrecognized; registration surface not positively confirmed");
    }
    else if (afterEntries.length !== 1) {
        validationProblems.push(afterEntries.length === 0
            ? "quota plugin is no longer listed; registration surface lost"
            : "quota plugin is listed more than once; registration surface ambiguous");
    }
    let afterQuotaSpec = null;
    if (afterState.kind !== "single") {
        if (snapshot !== null) {
            validationProblems.push("global config is missing or ambiguous after the upgrade; config surface lost");
        }
    }
    else if (afterState.unparseable) {
        validationProblems.push(`global config is unparseable after the upgrade (${afterState.path}); config surface lost`);
    }
    else {
        const afterQuotaSpecs = quotaSpecsFromConfig(afterState.parsed);
        if (afterQuotaSpecs.length === 0) {
            validationProblems.push("global config no longer carries a quota entry; config surface lost");
        }
        else {
            afterQuotaSpec = afterQuotaSpecs[0] ?? null;
        }
        if (beforeNonQuota !== null) {
            const afterNonQuota = allPluginSpecsFromConfig(afterState.parsed).filter((spec) => !mentionsQuotaPackage(spec));
            if (!multisetEqual(beforeNonQuota, afterNonQuota)) {
                validationProblems.push("unrelated global plugin entries changed during the upgrade");
            }
        }
    }
    if (validationProblems.length > 0) {
        const rolledBack = await restoreSnapshot(snapshot);
        return {
            status: "validation-failed",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            resultingSpec: null,
            detail: `upgrade validation failed (${validationProblems.join("; ")}). ${snapshot === null
                ? "No global config snapshot existed; state is exactly as the updater left it."
                : rolledBack
                    ? `Global config restored to the pre-upgrade bytes (${snapshot.path}).`
                    : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`}`,
            mutated: true,
            rolledBack,
        };
    }
    // The updater is a no-op when already current: bytes prove it, so report
    // it instead of claiming an upgrade.
    const configIdentical = snapshot === null
        ? afterState.kind === "missing"
        : afterState.kind === "single" && afterState.raw.equals(snapshot.raw);
    const listIdentical = beforeListText === null ? afterEntries === null : JSON.stringify(afterEntries) === beforeListText;
    if (configIdentical && listIdentical) {
        return {
            status: "already-current",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            resultingSpec: null,
            detail: `Quota ${identified.version} is already current; native update changed no files`,
            mutated: false,
            rolledBack: false,
        };
    }
    const keptId = afterEntries !== null && afterEntries.length === 1 ? afterEntries[0]?.id ?? QUOTA_PLUGIN_ID : QUOTA_PLUGIN_ID;
    return {
        status: "upgraded",
        installedSpec: identified.spec,
        installedVersion: identified.version,
        resultingSpec: afterQuotaSpec ?? (afterEntries !== null && afterEntries.length === 1 ? (afterEntries[0]?.target ?? null) : null),
        detail: `Quota ${identified.version} upgraded via the native update; plugin list carries ${keptId} exactly once and unrelated global entries are preserved (restart OpenCode to load)`,
        mutated: true,
        rolledBack: false,
    };
}
//# sourceMappingURL=quota.js.map