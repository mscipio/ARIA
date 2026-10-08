// ---------------------------------------------------------------------------
// T016 — Bootstrap lifecycle evidence extension.
//
// Per-component install-if-missing evidence plus ONLY the install-if-missing
// paths that are demonstrated safe (XDG-contained, no legacy writes). Update
// of an existing installation stays ownership-gated/report-only and unchanged
// here (Engram T012, CodeGraph T013, ZotPilot T014, Quota T007 own those
// paths); T017 wires these installers into setup/upgrade orchestration.
//
// Distinction (task core): a MISSING component may be installed through a
// demonstrated-safe ARIA-controlled path even when an EXISTING installation
// of that component would stay ownership-gated/report-only. Existing
// installations still require positive ownership/install-mechanism evidence
// before any mutation.
//
// No dependency-version compatibility database is introduced anywhere here:
// current upstream is discovered at runtime through each component/package
// manager's normal mechanism (npm view / pip index / GitHub releases API /
// brew), and post-install integration validation (`--version` probe + live
// `opencode mcp list` / `plugin list` + config-surface check, with snapshot
// rollback where feasible) is the safety mechanism.
//
// XDG isolation: every config write goes through the explicit `configDir`
// seam (`openCodeGlobalDir(configDir)`, same seam as the Context7 adapter).
// Legacy shapes (`mcp.<name>`) are never written; a pre-existing legacy
// entry means an existing installation and fails closed to report-only.
// No `.npmrc`, no session migration, no unrelated cleanup.
//
// Verdicts (honest report for T020):
// - Engram:    REAL install path (existing syncEngram brew/github channels;
//              evidence + decision coverage here, no new installer code).
// - CodeGraph: REAL install path (npm binary + ARIA file-based V2
//              `mcp.servers.codegraph`; the upstream `codegraph install
//              --target` reconciler stays prohibited per T006).
// - ZotPilot:  REAL install path (user-scoped `pip install --user` binary +
//              ARIA file-based V2 `mcp.servers.zotpilot`; every mutating
//              `zotpilot` subcommand stays prohibited per T006).
// - Quota:     REAL install path (native `opencode plugin add <exact 5.x>`
//              after `npm view` discovery; absent-only, XDG-guarded like the
//              T007 upgrade adapter). Setup/sync wiring is T017's job — this
//              module only provides the callable mechanism.
// ---------------------------------------------------------------------------
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectCodeGraph, parseMcpList, stripJsoncComments } from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
import { QUOTA_MAJOR, QUOTA_PACKAGE_NAME, quotaEntriesFromPluginList, quotaMajor, quotaSpecsFromConfig, } from "./quota.js";
export const BOOTSTRAP_EVIDENCE = [
    {
        component: "engram",
        missingPath: "install",
        discovery: "brew channel probe (`which brew`) else newest stable core-semver GitHub release with a matching platform asset (normal GitHub releases API mechanism)",
        installCommands: [
            "brew install gentleman-programming/tap/engram (+ `engram setup opencode`)",
            "curl GitHub release tarball + checksums.txt verify (+ atomic ~/.local/bin replace + `engram setup opencode`)",
        ],
        safety: "Existing syncEngram missing branch: brew-managed or checksum-verified binary into ~/.local/bin, then `engram setup opencode` with the T005 statusline side effect normalized away; config writes XDG-contained via the configDir seam.",
        existingGate: "Unchanged: homebrew-managed existing installs upgrade via brew; any other existing install takes the GitHub path. T012 owns future upgrade behavior; this module adds no Engram installer code.",
        prohibitions: ["overwriting a Homebrew-cellar binary (redirects to ~/.local/bin)"],
    },
    {
        component: "codegraph",
        missingPath: "install",
        discovery: "`npm view @colbymchenry/codegraph version` (npm's normal mechanism), pinned exact at install time",
        installCommands: [
            "npm install -g @colbymchenry/codegraph@<discovered>",
            "file-based V2 `mcp.servers.codegraph = { type: \"local\", command: [\"codegraph\", \"serve\", \"--mcp\"] }` (command shape from the T006 `install --print-config` probe)",
        ],
        safety: "Binary install performs no config write; V2 registration is ARIA file-based under the configDir seam (never the upstream reconciler), preserving unrelated entries. Post-install validation (`codegraph --version` + `opencode mcp list` connected + legacy-path absence) with config-snapshot rollback.",
        existingGate: "Unchanged: any detected `codegraph --version`, any V2 `mcp.servers.codegraph`, or any legacy `mcp.codegraph` entry means an existing installation → report-only `already-present`, zero mutation (T006/T013).",
        prohibitions: ["codegraph install --target opencode (writes legacy mcp.codegraph per T006)", "codegraph upgrade (unpinned latest)", "npm install -g ...@latest (unpinned)"],
    },
    {
        component: "zotpilot",
        missingPath: "install",
        discovery: "`python3 -m pip index versions zotpilot` (pip's normal mechanism), pinned `==` at install time",
        installCommands: [
            "python3 -m pip install --user zotpilot==<discovered>",
            "file-based V2 `mcp.servers.zotpilot = { type: \"local\", command: [\"zotpilot\", \"mcp\", \"serve\"] }` (command shape as observed in `opencode mcp list`)",
        ],
        safety: "`--user` scopes the install to the invoking user's home (never a shared conda env); no `zotpilot` mutating subcommand runs; V2 registration is ARIA file-based under the configDir seam. Post-install validation (`zotpilot --version` + `opencode mcp list` connected) with config-snapshot rollback; the binary itself is left in place on validation failure and reported (same rule as the T007 package-cache note).",
        existingGate: "Unchanged: any detected `zotpilot --version`, any V2 `mcp.servers.zotpilot`, or any legacy `mcp.zotpilot` entry means an existing installation → report-only `already-present`, zero mutation (T006/T014). ZotPilot's own config (`~/.config/zotpilot/config.json`, API secrets) and ChromaDB state are never ARIA-managed.",
        prohibitions: ["zotpilot upgrade (mutates the installed env)", "zotpilot register / zotpilot install (auto-detect side effects unknown per T006)", "bare pip install without --user (could mutate a shared env)"],
    },
    {
        component: "quota",
        missingPath: "install",
        discovery: "`npm view @slkiser/opencode-quota version` (npm's normal mechanism); only exact-semver Quota 5 proceeds",
        installCommands: ["opencode plugin add @slkiser/opencode-quota@<discovered-5.x>"],
        safety: "Absent-only (plugin list recognized with zero quota rows AND global config with zero quota specs); OpenCode's native installer targets the XDG-contained global config; divergent explicit configDir fails closed (same XDG guard as the T007 upgrade adapter). Post-install validation (plugin list carries quota exactly once + config carries a quota entry + unrelated specs preserved) with config-snapshot rollback.",
        existingGate: "Unchanged: any observed quota target defers to the T007 upgrade-only adapter (identified 5.x + OpenCode 2 + clean dry-run preview, else observed/unmanaged). Setup/sync still never touch Quota (T017 wires setup-direct bootstrap).",
        prohibitions: ["installing on dual-file ambiguity, unparseable config, or unrecognized plugin list (never guessed)", "non-5.x or moving-tag discoveries (fail closed)"],
    },
];
function report(status, installedVersion, detail, mutated = false) {
    return { status, installedVersion, detail, mutated };
}
async function readSingleConfigState(configDir) {
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
        return { kind: "ambiguous", jsonPath, jsoncPath };
    const existing = jsonRaw !== null ? { path: jsonPath, raw: jsonRaw, jsonc: false } : jsoncRaw !== null ? { path: jsoncPath, raw: jsoncRaw, jsonc: true } : null;
    if (existing === null)
        return { kind: "missing" };
    try {
        const text = existing.raw.toString("utf8");
        const parsed = JSON.parse(existing.jsonc ? stripJsoncComments(text) : text);
        return { kind: "single", path: existing.path, raw: existing.raw, parsed, unparseable: false };
    }
    catch {
        return { kind: "single", path: existing.path, raw: existing.raw, parsed: null, unparseable: true };
    }
}
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function classifyLocalMcp(parsed, name, path) {
    if (!isPlainObject(parsed))
        return { kind: "conflicting", reason: `${path}: expected a JSON object at the config root` };
    const mcp = parsed["mcp"];
    if (mcp === undefined)
        return { kind: "absent" };
    if (!isPlainObject(mcp)) {
        return { kind: "conflicting", reason: `${path}: "mcp" is not an object; refusing to write without risking user settings. No file was modified.` };
    }
    const servers = mcp["servers"];
    if (servers !== undefined && !isPlainObject(servers)) {
        return { kind: "conflicting", reason: `${path}: "mcp.servers" is not an object; refusing to write without risking user settings. No file was modified.` };
    }
    const v2 = isPlainObject(servers) ? servers[name] : undefined;
    const legacy = mcp[name];
    if (v2 !== undefined)
        return { kind: "present", shape: "v2" };
    if (legacy !== undefined)
        return { kind: "present", shape: "legacy" };
    return { kind: "absent" };
}
/**
 * ARIA-controlled V2 registration for a local MCP server. Writes ONLY
 * `mcp.servers.<name> = { type: "local", command }` into the single existing
 * `.json`/`.jsonc` file (or creates `opencode.json` when absent), preserving
 * every unrelated key/server. Fail-closed (no write): dual-file ambiguity,
 * conflicting containers, invalid JSON. The upstream installer is never
 * invoked — this file write IS the registration.
 */
async function ensureLocalMcpServer(configDir, name, command) {
    const base = openCodeGlobalDir(configDir);
    const state = await readSingleConfigState(configDir);
    if (state.kind === "ambiguous") {
        return {
            ok: false,
            reason: `Ambiguous global OpenCode config: both ${state.jsonPath} and ${state.jsoncPath} exist. No file was created, modified, or backed up.`,
        };
    }
    let config;
    const targetPath = state.kind === "single" ? state.path : join(base, "opencode.json");
    if (state.kind === "single") {
        if (state.unparseable)
            return { ok: false, reason: `${state.path}: invalid JSON` };
        const classification = classifyLocalMcp(state.parsed, name, state.path);
        if (classification.kind !== "absent") {
            return { ok: false, reason: classification.kind === "conflicting" ? classification.reason : `${state.path}: existing ${classification.shape} ${name} registration observed; leaving untouched` };
        }
        config = state.parsed;
    }
    else {
        config = {};
    }
    if (config["mcp"] === undefined)
        config["mcp"] = {};
    const mcp = config["mcp"];
    if (mcp["servers"] === undefined)
        mcp["servers"] = {};
    const servers = mcp["servers"];
    servers[name] = { type: "local", command };
    try {
        await mkdir(base, { recursive: true });
        await writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        return { ok: true, path: targetPath };
    }
    catch (error) {
        return { ok: false, reason: `${name} config write failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
async function restoreSnapshot(snapshot) {
    try {
        if (snapshot.raw === null) {
            await rm(snapshot.path, { force: true });
        }
        else {
            await writeFile(snapshot.path, snapshot.raw);
        }
        return true;
    }
    catch {
        return false;
    }
}
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function parseExactVersion(output) {
    const version = output.trim();
    return EXACT_SEMVER_RE.test(version) ? version : null;
}
async function mcpConnected(executor, name) {
    try {
        const result = await executor("opencode", ["mcp", "list"]);
        const status = parseMcpList(result.stdout);
        if (name === "codegraph")
            return status.codegraph;
        return status.zotpilot?.connected ?? false;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// CodeGraph — install-if-missing (new, T016)
// ---------------------------------------------------------------------------
export const CODEGRAPH_NPM_PACKAGE = "@colbymchenry/codegraph";
export const CODEGRAPH_MCP_COMMAND = ["codegraph", "serve", "--mcp"];
/** Discover current CodeGraph upstream via npm's normal mechanism (no database). */
export async function discoverCodegraphLatest(executor) {
    try {
        const result = await executor("npm", ["view", CODEGRAPH_NPM_PACKAGE, "version"]);
        const version = parseExactVersion(result.stdout);
        if (version === null)
            return { ok: false, reason: `npm view ${CODEGRAPH_NPM_PACKAGE} version produced no exact release (${result.stdout.trim().slice(0, 80)})` };
        return { ok: true, version };
    }
    catch (error) {
        return { ok: false, reason: `npm view ${CODEGRAPH_NPM_PACKAGE} version failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export async function installCodegraphIfMissing(executor, configDir) {
    const detected = await detectCodeGraph(executor);
    if (detected.found) {
        return report("already-present", detected.version, `CodeGraph ${detected.version ?? "unknown"} already installed; existing installations stay ownership-gated/report-only (T006/T013) with zero mutation`);
    }
    const state = await readSingleConfigState(configDir);
    if (state.kind === "ambiguous") {
        return report("report-only", null, `global opencode.json and opencode.jsonc both exist (${state.jsonPath}); dual-file ambiguity fails closed with neither file mutated`);
    }
    if (state.kind === "single") {
        if (state.unparseable)
            return report("report-only", null, `${state.path}: invalid JSON; refusing to register without risking user settings`);
        const classification = classifyLocalMcp(state.parsed, "codegraph", state.path);
        if (classification.kind === "present") {
            return report("already-present", null, `${state.path}: existing ${classification.shape} codegraph registration observed; ownership-gated/report-only with zero mutation`);
        }
        if (classification.kind === "conflicting")
            return report("report-only", null, classification.reason);
    }
    const discovered = await discoverCodegraphLatest(executor);
    if (!discovered.ok)
        return { status: "install-failed", installedVersion: null, detail: discovered.reason, mutated: false };
    const spec = `${CODEGRAPH_NPM_PACKAGE}@${discovered.version}`;
    try {
        await executor("npm", ["install", "-g", spec]);
    }
    catch (error) {
        return { status: "install-failed", installedVersion: null, detail: `npm install -g ${spec} failed (${error instanceof Error ? error.message : String(error)}); no config file was written`, mutated: false };
    }
    const base = openCodeGlobalDir(configDir);
    const snapshot = state.kind === "single" ? { path: state.path, raw: state.raw } : { path: join(base, "opencode.json"), raw: null };
    const registered = await ensureLocalMcpServer(configDir, "codegraph", CODEGRAPH_MCP_COMMAND);
    if (!registered.ok) {
        return { status: "install-failed", installedVersion: discovered.version, detail: `${registered.reason} (binary ${spec} is installed; only the V2 registration failed)`, mutated: true };
    }
    const verify = await detectCodeGraph(executor);
    const connected = await mcpConnected(executor, "codegraph");
    if (!verify.found || !connected) {
        const rolledBack = await restoreSnapshot(snapshot);
        const problems = [!verify.found ? "codegraph binary not found after install" : null, !connected ? "codegraph not connected in `opencode mcp list`" : null].filter(Boolean).join("; ");
        return {
            status: "validation-failed",
            installedVersion: discovered.version,
            detail: `post-install validation failed (${problems}). ${rolledBack ? `Global config restored (${snapshot.path}).` : `Global config restore failed; ${snapshot.path} is exactly as left.`} The installed binary is left in place and reported, never guessed.`,
            mutated: true,
            rolledBack,
        };
    }
    return { status: "installed", installedVersion: verify.version ?? discovered.version, detail: `CodeGraph ${verify.version ?? discovered.version} installed (${spec}) with native V2 MCP registration; validated via codegraph --version + opencode mcp list`, mutated: true, rolledBack: false };
}
// ---------------------------------------------------------------------------
// ZotPilot — install-if-missing (new, T016)
// ---------------------------------------------------------------------------
export const ZOTPILOT_PIP_PACKAGE = "zotpilot";
export const ZOTPILOT_MCP_COMMAND = ["zotpilot", "mcp", "serve"];
async function detectZotpilot(executor) {
    try {
        const result = await executor("zotpilot", ["--version"]);
        const match = result.stdout.match(/(\d+\.\d+\.\d+(?:[-.]\w+)?)/);
        const version = match?.[1] ?? null;
        if (!version)
            return { found: false, version: null };
        return { found: true, version };
    }
    catch {
        return { found: false, version: null };
    }
}
/** Discover current ZotPilot upstream via pip's normal mechanism (no database). */
export async function discoverZotpilotLatest(executor) {
    try {
        const result = await executor("python3", ["-m", "pip", "index", "versions", ZOTPILOT_PIP_PACKAGE]);
        const line = result.stdout.split("\n").find((candidate) => candidate.trim().toLowerCase().startsWith("available versions:"));
        const first = line?.split(":")[1]?.split(",")[0]?.trim() ?? "";
        if (!EXACT_SEMVER_RE.test(first)) {
            return { ok: false, reason: `pip index versions ${ZOTPILOT_PIP_PACKAGE} produced no exact release` };
        }
        return { ok: true, version: first };
    }
    catch (error) {
        return { ok: false, reason: `pip index versions ${ZOTPILOT_PIP_PACKAGE} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export async function installZotpilotIfMissing(executor, configDir) {
    const detected = await detectZotpilot(executor);
    if (detected.found) {
        return report("already-present", detected.version, `ZotPilot ${detected.version ?? "unknown"} already installed; existing installations stay ownership-gated/report-only (T006/T014) with zero mutation`);
    }
    const state = await readSingleConfigState(configDir);
    if (state.kind === "ambiguous") {
        return report("report-only", null, `global opencode.json and opencode.jsonc both exist (${state.jsonPath}); dual-file ambiguity fails closed with neither file mutated`);
    }
    if (state.kind === "single") {
        if (state.unparseable)
            return report("report-only", null, `${state.path}: invalid JSON; refusing to register without risking user settings`);
        const classification = classifyLocalMcp(state.parsed, "zotpilot", state.path);
        if (classification.kind === "present") {
            return report("already-present", null, `${state.path}: existing ${classification.shape} zotpilot registration observed; ownership-gated/report-only with zero mutation`);
        }
        if (classification.kind === "conflicting")
            return report("report-only", null, classification.reason);
    }
    const discovered = await discoverZotpilotLatest(executor);
    if (!discovered.ok)
        return { status: "install-failed", installedVersion: null, detail: discovered.reason, mutated: false };
    const spec = `${ZOTPILOT_PIP_PACKAGE}==${discovered.version}`;
    try {
        await executor("python3", ["-m", "pip", "install", "--user", spec]);
    }
    catch (error) {
        return { status: "install-failed", installedVersion: null, detail: `pip install --user ${spec} failed (${error instanceof Error ? error.message : String(error)}); no config file was written`, mutated: false };
    }
    const base = openCodeGlobalDir(configDir);
    const snapshot = state.kind === "single" ? { path: state.path, raw: state.raw } : { path: join(base, "opencode.json"), raw: null };
    const registered = await ensureLocalMcpServer(configDir, "zotpilot", ZOTPILOT_MCP_COMMAND);
    if (!registered.ok) {
        return { status: "install-failed", installedVersion: discovered.version, detail: `${registered.reason} (package ${spec} is installed; only the V2 registration failed)`, mutated: true };
    }
    const verify = await detectZotpilot(executor);
    const connected = await mcpConnected(executor, "zotpilot");
    if (!verify.found || !connected) {
        const rolledBack = await restoreSnapshot(snapshot);
        const problems = [!verify.found ? "zotpilot binary not found after install" : null, !connected ? "zotpilot not connected in `opencode mcp list`" : null].filter(Boolean).join("; ");
        return {
            status: "validation-failed",
            installedVersion: discovered.version,
            detail: `post-install validation failed (${problems}). ${rolledBack ? `Global config restored (${snapshot.path}).` : `Global config restore failed; ${snapshot.path} is exactly as left.`} The installed package is left in place and reported, never guessed.`,
            mutated: true,
            rolledBack,
        };
    }
    return { status: "installed", installedVersion: verify.version ?? discovered.version, detail: `ZotPilot ${verify.version ?? discovered.version} installed (${spec}) with native V2 MCP registration; validated via zotpilot --version + opencode mcp list`, mutated: true, rolledBack: false };
}
// ---------------------------------------------------------------------------
// Quota — install-if-missing (new, T016; setup/sync wiring is T017's job)
// ---------------------------------------------------------------------------
/** Discover current Quota upstream via npm's normal mechanism (no database). Only exact Quota 5 proceeds. */
export async function discoverQuotaLatest(executor) {
    try {
        const result = await executor("npm", ["view", QUOTA_PACKAGE_NAME, "version"]);
        const version = parseExactVersion(result.stdout);
        if (version === null)
            return { ok: false, reason: `npm view ${QUOTA_PACKAGE_NAME} version produced no exact release` };
        if (quotaMajor(version) !== QUOTA_MAJOR) {
            return { ok: false, reason: `npm view ${QUOTA_PACKAGE_NAME} version is ${version} (this policy installs only Quota ${QUOTA_MAJOR}); leaving untouched` };
        }
        return { ok: true, version };
    }
    catch (error) {
        return { ok: false, reason: `npm view ${QUOTA_PACKAGE_NAME} version failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
/** Every plugin spec string in the parsed global config (string/tuple/object forms; mirrors quota.ts). */
function allPluginSpecs(parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return [];
    const root = parsed;
    const specs = [];
    for (const key of ["plugins", "plugin"]) {
        const list = root[key];
        if (!Array.isArray(list))
            continue;
        for (const entry of list) {
            if (typeof entry === "string")
                specs.push(entry);
            else if (Array.isArray(entry) && typeof entry[0] === "string")
                specs.push(entry[0]);
            else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
                const pkg = entry["package"];
                if (typeof pkg === "string")
                    specs.push(pkg);
            }
        }
    }
    return specs;
}
export async function installQuotaIfMissing(executor, options = {}) {
    const configDir = options.configDir;
    if (configDir !== undefined && resolve(configDir) !== resolve(openCodeGlobalDir())) {
        return report("report-only", null, "explicit config dir diverges from the effective OpenCode global dir; native installer targeting cannot be verified, leaving Quota untouched");
    }
    let listEntries = null;
    try {
        const result = await executor("opencode", ["plugin", "list"]);
        listEntries = quotaEntriesFromPluginList(result.stdout);
    }
    catch {
        listEntries = null;
    }
    const state = await readSingleConfigState(configDir);
    if (state.kind === "ambiguous") {
        return report("report-only", null, "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated");
    }
    if (listEntries === null && state.kind === "missing") {
        return report("report-only", null, "plugin list unavailable and no global config observed; absence not positively established, leaving Quota untouched");
    }
    const configSpecs = state.kind === "single" && !state.unparseable ? quotaSpecsFromConfig(state.parsed) : [];
    if (state.kind === "single" && state.unparseable) {
        return report("report-only", null, `${state.path}: invalid JSON; refusing to install without risking user settings`);
    }
    const observed = [...(listEntries ?? []).map((entry) => entry.target), ...configSpecs];
    if (observed.length > 0) {
        return report("already-present", null, `quota target already observed (${observed[0]}); existing installations defer to the T007 upgrade-only adapter with zero mutation here`);
    }
    const discovered = await discoverQuotaLatest(executor);
    if (!discovered.ok)
        return { status: "install-failed", installedVersion: null, detail: discovered.reason, mutated: false };
    const spec = `${QUOTA_PACKAGE_NAME}@${discovered.version}`;
    const snapshot = state.kind === "single" ? { path: state.path, raw: state.raw } : null;
    const beforeNonQuota = state.kind === "single" && !state.unparseable ? allPluginSpecs(state.parsed) : null;
    try {
        await executor("opencode", ["plugin", "add", spec]);
    }
    catch (error) {
        return { status: "install-failed", installedVersion: null, detail: `opencode plugin add ${spec} failed (${error instanceof Error ? error.message : String(error)}); no config snapshot needed restoration`, mutated: true };
    }
    let afterEntries = null;
    try {
        const result = await executor("opencode", ["plugin", "list"]);
        afterEntries = quotaEntriesFromPluginList(result.stdout);
    }
    catch {
        afterEntries = null;
    }
    const afterState = await readSingleConfigState(configDir);
    const problems = [];
    if (afterEntries === null) {
        problems.push("post-install plugin list is unavailable or unrecognized; registration surface not positively confirmed");
    }
    else if (afterEntries.length !== 1) {
        problems.push(afterEntries.length === 0 ? "quota plugin is not listed; registration surface missing" : "quota plugin is listed more than once; registration surface ambiguous");
    }
    if (afterState.kind !== "single") {
        if (snapshot !== null)
            problems.push("global config is missing or ambiguous after the install; config surface lost");
    }
    else if (afterState.unparseable) {
        problems.push(`global config is unparseable after the install (${afterState.path}); config surface lost`);
    }
    else {
        if (quotaSpecsFromConfig(afterState.parsed).length === 0)
            problems.push("global config carries no quota entry; config surface missing");
        if (beforeNonQuota !== null) {
            const afterNonQuota = allPluginSpecs(afterState.parsed).filter((entry) => !entry.includes(QUOTA_PACKAGE_NAME));
            const beforeSet = [...beforeNonQuota].sort().join("\0");
            const afterSet = [...afterNonQuota].sort().join("\0");
            if (beforeSet !== afterSet)
                problems.push("unrelated global plugin entries changed during the install");
        }
    }
    if (problems.length > 0) {
        const rolledBack = snapshot === null ? false : await restoreSnapshot({ path: snapshot.path, raw: snapshot.raw });
        return {
            status: "validation-failed",
            installedVersion: discovered.version,
            detail: `install validation failed (${problems.join("; ")}). ${snapshot === null ? "No global config snapshot existed; state is exactly as the installer left it." : rolledBack ? `Global config restored to the pre-install bytes (${snapshot.path}).` : `Global config restore failed; ${snapshot.path} is exactly as the installer left it.`}`,
            mutated: true,
            rolledBack,
        };
    }
    return { status: "installed", installedVersion: discovered.version, detail: `Quota ${discovered.version} installed (${spec}); plugin list carries the quota plugin exactly once and unrelated global entries are preserved`, mutated: true, rolledBack: false };
}
//# sourceMappingURL=bootstrap.js.map