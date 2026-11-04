import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripJsoncComments } from "./deps.js";
import { defaultDelay, verifyPersistedThenConverge, } from "./list-convergence.js";
import { openCodeGlobalDir } from "./paths.js";
// ---------------------------------------------------------------------------
// OpenCode Quota 6 lifecycle policy (single owner for update decisions).
//
// - Install (consented, optional): `opencode plugin add` of the exact latest
//   Quota 6 release, discovered from npm dist-tags (see bootstrap.ts).
// - Update: targeted native `opencode plugin update @slkiser/opencode-quota`,
//   only when the installed release is positively identified, the discovered
//   latest is in the same major, and it is strictly newer. Never a bare plugin
//   update (that would touch unrelated plugins) and never a downgrade.
// - Gates: OpenCode >= 2.0.26 and Node.js >= 22.13 (Quota's terminal commands
//   need it). ARIA declares Node >=20.19, so Quota operations are refused on
//   older Node with the reason rather than failing silently.
// - Rollback: a failed update restores the global config file bytes only. The
//   installed plugin package is not reverted by ARIA.
// - Quota 5 installs are observed and reported as outside the supported major;
//   they are never migrated automatically.
// ---------------------------------------------------------------------------
/** npm package providing Quota. */
export const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
/** V2 server plugin ID registered by the Quota package. */
export const QUOTA_PLUGIN_ID = "@slkiser/opencode-quota.server";
/** Only this major is eligible for a managed Quota install or update. */
export const QUOTA_MAJOR = 6;
/** OpenCode release the Quota 6 plugin documents as its minimum. */
export const QUOTA_MIN_OPENCODE = "2.0.26";
/**
 * Node.js floor for Quota's terminal commands (`engines` of the published
 * package). ARIA declares Node >=20.19, so this is detected at runtime and
 * refused with an explanation, never assumed.
 */
export const QUOTA_MIN_NODE = "22.13.0";
/**
 * Moving tags the updater keeps as written (never positively versioned, so
 * never eligible as an identified upgrade target).
 */
const QUOTA_MOVING_TAGS = new Set(["latest", "next", "4"]);
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Compare dotted numeric versions (`a.b.c`); negative when a < b. */
export function compareDotted(a, b) {
    const left = a.split(".").map((part) => Number.parseInt(part, 10));
    const right = b.split(".").map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < 3; index++) {
        const delta = (left[index] ?? 0) - (right[index] ?? 0);
        if (delta !== 0)
            return delta;
    }
    return 0;
}
/** Positive node/opencode version text (`v24.18.0`, `2.2.5`) or null when unparseable. */
function leadingVersion(text) {
    const match = text.match(/v?(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
}
/** Runtime gate: the Node.js on PATH must meet the Quota terminal-command floor. */
export async function quotaNodeGate(executor) {
    try {
        const result = await executor("node", ["--version"]);
        const version = leadingVersion(result.stdout);
        if (version === null)
            return { ok: false, reason: "Node.js version not positively identified; Quota terminal commands need Node.js " + QUOTA_MIN_NODE + " or newer" };
        if (compareDotted(version, QUOTA_MIN_NODE) < 0) {
            return {
                ok: false,
                reason: `Node.js ${version} is older than the ${QUOTA_MIN_NODE} minimum that Quota ${QUOTA_MAJOR} requires; ARIA declares Node >=20.19 and refuses this Quota operation instead of failing silently`,
            };
        }
        return { ok: true, version };
    }
    catch {
        return { ok: false, reason: "Node.js could not be executed; Quota terminal-command compatibility is unknown" };
    }
}
/** Runtime gate: the OpenCode release must meet Quota's documented minimum. */
export async function quotaOpenCodeGate(executor) {
    try {
        const result = await executor("opencode", ["--version"]);
        const version = leadingVersion(result.stdout);
        if (version === null)
            return { ok: false, reason: "OpenCode version not positively identified" };
        if (compareDotted(version, QUOTA_MIN_OPENCODE) < 0) {
            return { ok: false, reason: `OpenCode ${version} is older than the ${QUOTA_MIN_OPENCODE} minimum for Quota ${QUOTA_MAJOR}` };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: "OpenCode version could not be read" };
    }
}
/**
 * Latest exact Quota release on npm, restricted to the supported major. Read
 * with `npm view <pkg> dist-tags --json` (no install, no registry write).
 */
export async function discoverQuotaTarget(executor) {
    try {
        const result = await executor("npm", ["view", QUOTA_PACKAGE_NAME, "dist-tags", "--json"]);
        // `npm view --json` wraps a single result in an array; accept both shapes.
        const parsed = JSON.parse(result.stdout);
        const tags = (Array.isArray(parsed) ? parsed[0] : parsed);
        const version = typeof tags?.latest === "string" && EXACT_SEMVER_RE.test(tags.latest) ? tags.latest : null;
        if (version === null)
            return { ok: false, reason: `npm dist-tags for ${QUOTA_PACKAGE_NAME} carry no exact latest release` };
        if (quotaMajor(version) !== QUOTA_MAJOR) {
            return { ok: false, reason: `npm latest for ${QUOTA_PACKAGE_NAME} is ${version}; this policy installs and updates only Quota ${QUOTA_MAJOR}, leaving untouched` };
        }
        return { ok: true, version };
    }
    catch (error) {
        return { ok: false, reason: `npm dist-tags for ${QUOTA_PACKAGE_NAME} unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
}
/**
 * Observed Quota specs. The plugin list's SOURCE column is unversioned for
 * npm packages while its VERSION column is the runtime identity; an
 * unversioned package spec is therefore pinned to the listed version so the
 * runtime identity is positively used. A config spec pinned to a different
 * version stays distinct and fails closed as ambiguous.
 */
export function observedQuotaSpecs(listEntries, configSpecs) {
    const entries = listEntries ?? [];
    const listVersion = entries.length === 1 && entries[0] !== undefined && EXACT_SEMVER_RE.test(entries[0].version)
        ? entries[0].version
        : null;
    const pin = listVersion === null ? null : `${QUOTA_PACKAGE_NAME}@${listVersion}`;
    const pinned = (spec) => (pin !== null && spec === QUOTA_PACKAGE_NAME ? pin : spec);
    return {
        listSpecs: entries.map((entry) => pinned(entry.target)),
        configSpecs: configSpecs.map(pinned),
    };
}
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
/**
 * Strictly read-only Quota inventory for setup/sync reporting and the
 * future upgrade `--check` table: installed spec/version plus a status.
 * Never invokes the updater and never writes. Identified Quota 6 reports
 * `unmanaged-observed`: observed by this inventory while version action is
 * owned exclusively by the gated `upgradeQuota`/bootstrap lifecycle below,
 * and the legacy `deps sync` path performs no Quota installation or config
 * mutation. A moving tag such as `@latest` is never a positively
 * identified target: it reports `unknown-target` (fail-closed) and is
 * never upgraded, installed, or otherwise taken ownership of here.
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
    const observed = observedQuotaSpecs(listEntries, configState.kind === "single" ? configState.specs : []);
    const identified = identifyQuotaTarget(observed.listSpecs, observed.configSpecs);
    if (identified.kind === "absent") {
        return { status: "skipped", installedSpec: null, installedVersion: null, detail: "no Quota installation observed; nothing to upgrade" };
    }
    if (identified.kind === "identified") {
        return {
            status: "unmanaged-observed",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            detail: `Quota ${identified.version} observed (${identified.spec}); version action owned exclusively by the gated Quota adapter (setup bootstrap/upgrade path) — this inventory and deps sync perform no Quota installation or config mutation`,
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
 * Native Quota 6 update: `opencode plugin update @slkiser/opencode-quota`
 * (targeted; never the bare form, which updates every plugin). Preconditions:
 * supported OpenCode and Node runtimes, an exact identified Quota 6 install,
 * and a discovered target that is newer (never a downgrade). Afterwards the
 * persisted config must keep every unrelated plugin entry byte-for-byte and
 * the runtime list must converge on exactly one Quota entry at the target.
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
    const observed = observedQuotaSpecs(listEntries, configState.kind === "single" ? configState.specs : []);
    const identified = identifyQuotaTarget(observed.listSpecs, observed.configSpecs);
    if (identified.kind === "absent") {
        return reportOnly("skipped", null, null, "no Quota installation observed; nothing to upgrade");
    }
    if (identified.kind === "unknown-target" || identified.kind === "unsupported-ownership") {
        return reportOnly(identified.kind, null, null, identified.reason);
    }
    // Runtime gates: refuse with an explanation rather than fail silently.
    const openCode = await quotaOpenCodeGate(executor);
    if (!openCode.ok)
        return reportOnly("unmanaged-observed", identified.spec, identified.version, `${openCode.reason}; leaving Quota untouched`);
    const node = await quotaNodeGate(executor);
    if (!node.ok)
        return reportOnly("unmanaged-observed", identified.spec, identified.version, `${node.reason}; leaving Quota untouched`);
    const target = await discoverQuotaTarget(executor);
    if (!target.ok)
        return reportOnly("unknown-target", identified.spec, identified.version, `${target.reason}; leaving Quota untouched`);
    const ordering = compareDotted(identified.version, target.version);
    if (ordering > 0) {
        return reportOnly("unknown-target", identified.spec, identified.version, `installed Quota ${identified.version} is newer than the discovered release ${target.version}; never downgraded`);
    }
    if (ordering === 0) {
        return {
            status: "already-current",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            resultingSpec: null,
            detail: `Quota ${identified.version} is already the latest ${QUOTA_MAJOR}.x release; no change`,
            mutated: false,
            rolledBack: false,
        };
    }
    const snapshot = configState.kind === "single" ? { path: configState.path, raw: configState.raw } : null;
    const beforeNonQuota = configState.kind === "single" && !configState.unparseable
        ? allPluginSpecsFromConfig(configState.parsed).filter((spec) => !mentionsQuotaPackage(spec))
        : null;
    // Apply: targeted native update. The package argument restricts the change
    // to Quota; unrelated plugins are verified unchanged below.
    try {
        await executor("opencode", ["plugin", "update", QUOTA_PACKAGE_NAME]);
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
                    ? `Global config restored to the pre-upgrade bytes (${snapshot.path}); ARIA does not revert the installed package.`
                    : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`}`,
            mutated: true,
            rolledBack,
        };
    }
    const verification = await verifyPersistedThenConverge(async () => {
        const persisted = await readQuotaConfigState(configDir);
        if (persisted.kind === "ambiguous") {
            return {
                kind: "ambiguous",
                reason: "global opencode.json and opencode.jsonc both exist after the upgrade; dual-file ambiguity fails closed with neither file mutated",
            };
        }
        if (persisted.kind === "missing") {
            return { kind: "unreadable", reason: "global config is missing after the upgrade; config surface lost" };
        }
        if (persisted.unparseable) {
            return { kind: "unreadable", reason: `${persisted.path}: invalid JSON after the upgrade; config surface lost` };
        }
        return { kind: "ok", value: { parsed: persisted.parsed, path: persisted.path, raw: persisted.raw, specs: persisted.specs } };
    }, (config) => {
        if (config.specs.length === 0) {
            return { ok: false, reason: "global config no longer carries a quota entry; config surface lost" };
        }
        if (beforeNonQuota !== null) {
            const afterNonQuota = allPluginSpecsFromConfig(config.parsed).filter((spec) => !mentionsQuotaPackage(spec));
            if (!multisetEqual(beforeNonQuota, afterNonQuota)) {
                return { ok: false, reason: "unrelated global plugin entries changed during the upgrade" };
            }
        }
        return { ok: true };
    }, async () => {
        const listResult = await runPluginList(executor);
        return listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
    }, (entries) => {
        if (entries.length !== 1) {
            return {
                ok: false,
                reason: entries.length === 0
                    ? "quota plugin is no longer listed; registration surface lost"
                    : "quota plugin is listed more than once; registration surface ambiguous",
            };
        }
        if (entries[0]?.version !== target.version) {
            return { ok: false, reason: `runtime still reports Quota ${entries[0]?.version ?? "unknown"}, not ${target.version}` };
        }
        return { ok: true };
    }, options.convergence ?? {}, options.delay ?? defaultDelay);
    if (verification.outcome !== "converged") {
        const rolledBack = await restoreSnapshot(snapshot);
        const problem = verification.reason ?? "runtime plugin list did not converge within the bound";
        return {
            status: "validation-failed",
            installedSpec: identified.spec,
            installedVersion: identified.version,
            resultingSpec: null,
            detail: `upgrade validation failed (${problem}). ${snapshot === null
                ? "No global config snapshot existed; state is exactly as the updater left it."
                : rolledBack
                    ? `Global config restored to the pre-upgrade bytes (${snapshot.path}); ARIA does not revert the installed package.`
                    : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`}`,
            mutated: true,
            rolledBack,
        };
    }
    const afterQuotaSpec = quotaSpecsFromConfig(verification.persisted.parsed)[0] ?? null;
    return {
        status: "upgraded",
        installedSpec: identified.spec,
        installedVersion: identified.version,
        resultingSpec: afterQuotaSpec,
        detail: `Quota ${identified.version} upgraded to ${target.version} via 'opencode plugin update ${QUOTA_PACKAGE_NAME}'; unrelated plugin entries preserved (restart OpenCode to load)`,
        mutated: true,
        rolledBack: false,
    };
}
//# sourceMappingURL=quota.js.map