// ---------------------------------------------------------------------------
// T014 — ZotPilot lifecycle adapter (shared by `aria setup` and `aria upgrade`).
//
// Consumes the T006 shared evidence gate plus the T016 bootstrap evidence in
// `src/bootstrap.ts` and implements ONLY evidence-supported behavior:
//
// - Clean system (no `zotpilot` binary AND no V2/legacy registration):
//   install-if-missing via the demonstrated-safe ARIA-controlled path —
//   `pip index versions` discovery pinned `==` at install time, user-scoped
//   `python3 -m pip install --user zotpilot==<discovered>` (never a shared
//   env), then ARIA file-based V2 `mcp.servers.zotpilot` registration (the
//   command shape as observed in `opencode mcp list`) with post-install
//   validation (`zotpilot --version` + `opencode mcp list` connected) and
//   config-snapshot rollback. Every mutating `zotpilot` subcommand
//   (`upgrade` / `register` / `install`), every `conda` mutation, every bare
//   `pip install` without `--user`, and every legacy `mcp.zotpilot` write is
//   NEVER invoked.
// - Existing installation with established ownership AND demonstrated-safe
//   mechanism: update-if-outdated ONLY when the install provenance is
//   positively user-scoped (`python3 -m pip show zotpilot` `Location:` inside
//   the invoking user's home with no shared/conda markers) AND the available
//   release is a positively identified exact version newer than the installed
//   one. The update runs ONLY `python3 -m pip install --user
//   zotpilot==<discovered>` (the same user-scoped mechanism as the clean
//   install, never a `zotpilot`/`conda` mutating subcommand) and preserves the
//   direct V2 registration byte-exact (no config rewrite on the update path).
//   Post-update validation is `zotpilot --version` + `opencode mcp list`
//   connected + V2 still present; the binary is left in place and reported on
//   failure (same rule as the T016 bootstrap + T007 adapters).
// - Every other existing/ambiguous installation (shared conda env per T006,
//   unknown provenance, legacy registration, conflicting containers,
//   unparseable JSON, dual-file ambiguity, undiscovered available release,
//   already-current, or available not newer): report-only with zero mutation,
//   never guessed.
// - Pinned permission policy (`src/permissions.ts` researcher ZotPilot
//   read-allow / mutation-ask, no wildcards) and the direct V2 MCP registration
//   are preserved by construction: this adapter never writes agent files and
//   never rewrites a present V2 entry (install creates it once on a clean
//   system; update leaves it byte-exact).
//
// - Binding: shared — callable directly by `aria setup` (no handoff needed)
//   AND post-handoff by `aria upgrade` via `zotpilotUpgradeComponent`.
// - XDG-contained: config reads/writes go through the explicit `configDir`
//   seam (`openCodeGlobalDir(configDir)`); the install path reuses the T016
//   bootstrap mechanism which honors that seam. Dual `opencode.json` +
//   `opencode.jsonc` ambiguity, conflicting containers, and unparseable JSON
//   fail closed with zero mutation (T002).
// - `aria deps sync` still performs no ZotPilot mutation (the report-only
//   gate in `src/deps.ts` is unchanged by this task; T017 owns setup/upgrade
//   wiring).
// ---------------------------------------------------------------------------
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BOOTSTRAP_EVIDENCE, discoverZotpilotLatest, installZotpilotIfMissing, } from "./bootstrap.js";
import { parseMcpList, stripJsoncComments } from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
/** Demonstrated-safe missing-install evidence owning this adapter's install path (T016). */
export const ZOTPILOT_BOOTSTRAP_EVIDENCE = BOOTSTRAP_EVIDENCE.find((entry) => entry.component === "zotpilot");
const ZOTPILOT_PIP_NAME = "zotpilot";
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
    if (jsonRaw !== null) {
        try {
            return { kind: "single", path: jsonPath, parsed: JSON.parse(jsonRaw.toString("utf8")), unparseable: false };
        }
        catch {
            return { kind: "single", path: jsonPath, parsed: null, unparseable: true };
        }
    }
    if (jsoncRaw !== null) {
        try {
            return {
                kind: "single",
                path: jsoncPath,
                parsed: JSON.parse(stripJsoncComments(jsoncRaw.toString("utf8"))),
                unparseable: false,
            };
        }
        catch {
            return { kind: "single", path: jsoncPath, parsed: null, unparseable: true };
        }
    }
    return { kind: "missing" };
}
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * Fail-closed classification of the local ZotPilot registration (read-only,
 * mirrors the T016 bootstrap rules): `absent` only when neither the
 * canonical V2 `mcp.servers.zotpilot` nor the legacy `mcp.zotpilot` shape
 * is present. Any present-but-unidentifiable container is `conflicting`.
 */
function classifyRegistration(parsed) {
    if (!isPlainObject(parsed))
        return "conflicting";
    const mcp = parsed["mcp"];
    if (mcp === undefined)
        return "absent";
    if (!isPlainObject(mcp))
        return "conflicting";
    const servers = mcp["servers"];
    if (servers !== undefined && !isPlainObject(servers))
        return "conflicting";
    const v2 = isPlainObject(servers) ? servers["zotpilot"] : undefined;
    const legacy = mcp["zotpilot"];
    if (v2 !== undefined)
        return "v2";
    if (legacy !== undefined)
        return "legacy";
    return "absent";
}
/** Read-only binary presence/version probe (`zotpilot --version` only; never a mutating subcommand). */
async function detectZotpilotBinary(executor) {
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
/**
 * Positive user-scoped ownership predicate (pure, testable): `user-scoped`
 * ONLY when the `pip show` `Location:` resolves inside the invoking user's
 * home AND carries no shared/conda marker. Shared markers win over the home
 * prefix (a conda env inside the home directory is still a shared env per
 * T006). Anything else is `shared` (positively not user-scoped); probe
 * failures are `unknown` (see `detectZotpilotOwnership`).
 */
export function classifyZotpilotOwnership(location, homeDir) {
    const normalizedLocation = location.trim().toLowerCase();
    const sharedMarkers = ["miniforge", "miniconda", "anaconda", "/envs/", "conda", "/opt/"];
    if (sharedMarkers.some((marker) => normalizedLocation.includes(marker)))
        return "shared";
    const resolvedLocation = resolve(location.trim());
    const resolvedHome = resolve(homeDir);
    if (resolvedLocation === resolvedHome || resolvedLocation.startsWith(`${resolvedHome}/`))
        return "user-scoped";
    return "shared";
}
/**
 * Read-only ownership probe: `python3 -m pip show zotpilot` `Location:`.
 * `unknown` when the probe fails or no `Location:` is positively parsed
 * (never guessed). Never mutates (no `pip install`, no `zotpilot`/`conda`
 * mutating subcommand).
 */
export async function detectZotpilotOwnership(executor, homeDir = homedir()) {
    try {
        const result = await executor("python3", ["-m", "pip", "show", ZOTPILOT_PIP_NAME]);
        const locationLine = result.stdout
            .split("\n")
            .find((line) => line.trim().toLowerCase().startsWith("location:"));
        const location = locationLine?.slice(locationLine.indexOf(":") + 1).trim() ?? "";
        if (!location)
            return { ownership: "unknown", location: null };
        return { ownership: classifyZotpilotOwnership(location, homeDir), location };
    }
    catch {
        return { ownership: "unknown", location: null };
    }
}
/** Read-only MCP connectivity probe (`opencode mcp list` zotpilot row). */
async function mcpConnected(executor) {
    try {
        const result = await executor("opencode", ["mcp", "list"]);
        return parseMcpList(result.stdout).zotpilot?.connected ?? false;
    }
    catch {
        return false;
    }
}
/**
 * Read-only installed-state probe: binary presence/version via
 * `zotpilot --version` plus the V2/legacy registration surface. Never
 * mutates (no pip/zotpilot mutating command, no file write, no ownership
 * probe — ownership is established only on the update-eligible branch).
 */
export async function detectZotpilotState(executor, configDir) {
    const detected = await detectZotpilotBinary(executor);
    const config = await readSingleConfigState(configDir);
    if (config.kind === "ambiguous") {
        return { found: detected.found, version: detected.version, registration: "ambiguous" };
    }
    if (config.kind === "missing") {
        return { found: detected.found, version: detected.version, registration: "absent" };
    }
    if (config.unparseable) {
        return { found: detected.found, version: detected.version, registration: "unparseable", path: config.path };
    }
    return {
        found: detected.found,
        version: detected.version,
        registration: classifyRegistration(config.parsed),
        path: config.path,
    };
}
function reportOnly(installedVersion, availableVersion, detail, mcpConnectedValue, ownership) {
    return {
        status: "report-only",
        installedVersion,
        resultingVersion: null,
        availableVersion,
        detail,
        mutated: false,
        mcpConnected: mcpConnectedValue,
        ownership,
    };
}
function compareSemver(a, b) {
    const parts = (version) => version
        .split("+")[0]
        .split("-")[0]
        .split(".")
        .map((chunk) => Number.parseInt(chunk, 10));
    const left = parts(a);
    const right = parts(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
/**
 * Shared lifecycle: install-if-missing on a clean system via the
 * demonstrated-safe ARIA-controlled path (delegated to the T016 bootstrap
 * mechanism: exact pip `==` spec, user-scoped install, ARIA file-based V2
 * registration, validation with config-snapshot rollback); update-if-outdated
 * ONLY with established user-scoped ownership plus a positively identified
 * newer exact release (user-scoped `pip install --user`, V2 preserved
 * byte-exact, validated); every other installation stays report-only with
 * zero mutation. Mutating `zotpilot` subcommands, `conda` mutations, bare
 * `pip install` without `--user`, and legacy `mcp.zotpilot` writes are never
 * invoked on any path.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `zotpilotUpgradeComponent`); it takes no handoff
 * payload and performs no ARIA self-replacement. ZotPilot's own config
 * (`~/.config/zotpilot/config.json`, API secrets) and ChromaDB state are
 * never ARIA-managed.
 */
export async function ensureZotpilot(executor, options = {}) {
    const configDir = options.configDir;
    const homeDir = options.homeDir ?? homedir();
    const initial = await detectZotpilotState(executor, configDir);
    const connected = await mcpConnected(executor);
    // Fail-closed config surfaces (T002): never guess which file or container
    // is authoritative. Read-only probes above already ran; nothing mutates.
    if (initial.registration === "ambiguous") {
        return reportOnly(initial.version, null, "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated (existing ZotPilot state left untouched, never guessed)", connected, "unknown");
    }
    if (initial.registration === "unparseable") {
        return reportOnly(initial.version, null, `${initial.path ?? "global config"}: invalid JSON; refusing to register without risking user settings (existing ZotPilot state left untouched)`, connected, "unknown");
    }
    if (initial.registration === "conflicting") {
        return reportOnly(initial.version, null, `${initial.path ?? "global config"}: unidentifiable ZotPilot registration container; refusing to write without risking user settings (existing state left untouched)`, connected, "unknown");
    }
    // Legacy preservation: the T006 legacy `mcp.zotpilot` shape is left
    // byte-exact; no V2 entry is manufactured and no installer runs.
    if (initial.registration === "legacy") {
        return reportOnly(initial.version, null, `${initial.path ?? "global config"}: existing legacy zotpilot registration observed; ownership-gated/report-only with zero mutation — no \`pip install\`, no \`zotpilot upgrade/register/install\`, no \`conda\` mutation, no V2 rewrite (legacy preserved byte-exact)`, connected, "unknown");
    }
    // Clean system: delegate to the demonstrated-safe T016 install-if-missing
    // mechanism (exact pip `==` spec + user-scoped install + ARIA file-based V2
    // registration + validation with config-snapshot rollback).
    if (!initial.found && initial.registration === "absent") {
        const installed = await installZotpilotIfMissing(executor, configDir);
        switch (installed.status) {
            case "installed":
                return {
                    status: "installed",
                    installedVersion: null,
                    resultingVersion: installed.installedVersion,
                    availableVersion: installed.installedVersion,
                    detail: installed.detail,
                    mutated: true,
                    rolledBack: false,
                    // The bootstrap mechanism validates `zotpilot --version` plus
                    // `opencode mcp list` connected before reporting installed.
                    mcpConnected: true,
                    ownership: "user-scoped",
                };
            case "already-present":
                // Defensive: the pre-check above found a clean system, so reaching
                // here would mean a concurrent change; stay report-only regardless.
                return reportOnly(null, null, `${installed.detail} (observed during install; leaving untouched with zero further mutation)`, connected, "unknown");
            case "report-only":
                return reportOnly(null, null, installed.detail, connected, "unknown");
            case "install-failed":
                return {
                    status: "install-failed",
                    installedVersion: null,
                    resultingVersion: null,
                    availableVersion: installed.installedVersion,
                    detail: installed.detail,
                    mutated: installed.mutated,
                    mcpConnected: false,
                    ownership: "unknown",
                };
            case "validation-failed":
                return {
                    status: "validation-failed",
                    installedVersion: null,
                    resultingVersion: null,
                    availableVersion: installed.installedVersion,
                    detail: installed.detail,
                    mutated: installed.mutated,
                    rolledBack: installed.rolledBack,
                    mcpConnected: false,
                    ownership: "user-scoped",
                };
        }
    }
    // Existing-install conservatism (T006): ownership and the available release
    // are established read-only before any mutation is considered. The
    // read-only `pip index` discovery reports the available release next to the
    // installed version; it never authorizes a mutation on its own.
    const ownershipProbe = await detectZotpilotOwnership(executor, homeDir);
    let available = null;
    if (initial.found && initial.version !== null) {
        const discovered = await discoverZotpilotLatest(executor);
        if (discovered.ok)
            available = discovered.version;
    }
    // Registration-only existing install (V2 present, no binary): provenance is
    // not positively user-scoped and the binary target is unknown — report-only
    // with no pip calls (never reinstall on guess).
    if (!initial.found && initial.registration === "v2") {
        return reportOnly(null, null, `${initial.path ?? "global config"}: existing V2 zotpilot registration observed with no zotpilot binary; provenance not positively user-scoped, leaving untouched with zero mutation (no \`pip install\`, no \`zotpilot\` subcommand)`, connected, ownershipProbe.ownership);
    }
    // Binary present with no local registration: same conservatism as the
    // CodeGraph adapter — report the available release when known but manufacture
    // nothing (the V2 entry is only created by the clean-system install).
    if (initial.found && initial.registration === "absent") {
        const versionNote = initial.version !== null ? `ZotPilot ${initial.version}` : "ZotPilot (version not positively identified)";
        const availableNote = available !== null ? `; latest upstream is ${available}` : "; available release undiscovered";
        return reportOnly(initial.version, available, `${versionNote} already installed (binary present with no local registration); ownership-gated/report-only with zero mutation — no \`pip install\`, no \`zotpilot upgrade/register/install\`, no \`conda\` mutation${availableNote}`, connected, ownershipProbe.ownership);
    }
    // Version not positively identified: never guess a target.
    if (!initial.found || initial.version === null) {
        return reportOnly(initial.version, available, "ZotPilot installation state is not positively identified (binary missing or version unparseable); report-only with zero mutation — no `pip install`, no `zotpilot upgrade/register/install`, no `conda` mutation", connected, ownershipProbe.ownership);
    }
    // At this point: binary found with an exact version AND a V2 registration.
    // Update ONLY with established user-scoped ownership plus a positively
    // identified newer exact release. Anything else stays report-only.
    if (ownershipProbe.ownership !== "user-scoped") {
        const why = ownershipProbe.ownership === "shared"
            ? `shared install provenance (${ownershipProbe.location ?? "non-user location"}; T006 shared conda envs are never mutated)`
            : "install provenance not positively identified (pip show Location unknown)";
        const availableNote = available !== null
            ? available !== initial.version
                ? `; latest upstream is ${available} but ownership is not positively user-scoped, so no update is attempted`
                : `; latest upstream is also ${available}`
            : "; available release undiscovered";
        return reportOnly(initial.version, available, `ZotPilot ${initial.version} already installed (existing V2 registration${initial.path ? ` (${initial.path})` : ""}); ${why} — report-only with zero mutation, never guessed${availableNote}`, connected, ownershipProbe.ownership);
    }
    if (available === null) {
        return reportOnly(initial.version, null, `ZotPilot ${initial.version} already installed with user-scoped provenance (${ownershipProbe.location}); available release undiscovered via pip index, so no update target is guessed — report-only with zero mutation`, connected, ownershipProbe.ownership);
    }
    if (available === initial.version) {
        return {
            status: "already-current",
            installedVersion: initial.version,
            resultingVersion: initial.version,
            availableVersion: available,
            detail: `ZotPilot ${initial.version} is already current with user-scoped provenance (${ownershipProbe.location}); required normalization already present (direct V2 registration preserved byte-exact, pinned permission policy untouched) and validated via zotpilot --version + opencode mcp list`,
            mutated: false,
            rolledBack: false,
            mcpConnected: connected,
            ownership: ownershipProbe.ownership,
        };
    }
    if (compareSemver(available, initial.version) <= 0) {
        return reportOnly(initial.version, available, `ZotPilot ${initial.version} already installed with user-scoped provenance (${ownershipProbe.location}); latest upstream is ${available} (not newer) — never downgrading, report-only with zero mutation`, connected, ownershipProbe.ownership);
    }
    // Demonstrated-safe update: user-scoped `pip install --user` pinned exact,
    // V2 preserved byte-exact (no config rewrite on this path), then validate.
    const spec = `${ZOTPILOT_PIP_NAME}==${available}`;
    try {
        await executor("python3", ["-m", "pip", "install", "--user", spec]);
    }
    catch (error) {
        return {
            status: "update-failed",
            installedVersion: initial.version,
            resultingVersion: null,
            availableVersion: available,
            detail: `pip install --user ${spec} failed (${error instanceof Error ? error.message : String(error)}); no config file was written, the previous binary is left in place and reported`,
            mutated: true,
            rolledBack: false,
            mcpConnected: false,
            ownership: ownershipProbe.ownership,
        };
    }
    const verify = await detectZotpilotBinary(executor);
    const afterConnected = await mcpConnected(executor);
    const afterState = await detectZotpilotState(executor, configDir);
    const problems = [];
    if (!verify.found)
        problems.push("zotpilot binary not found after update");
    else if (verify.version !== available)
        problems.push(`zotpilot version is ${verify.version ?? "unknown"} after update (expected ${available})`);
    if (!afterConnected)
        problems.push("zotpilot not connected in `opencode mcp list`");
    if (afterState.registration !== "v2")
        problems.push("direct V2 zotpilot registration not preserved after update");
    if (problems.length > 0) {
        return {
            status: "validation-failed",
            installedVersion: initial.version,
            resultingVersion: verify.version,
            availableVersion: available,
            detail: `post-update validation failed (${problems.join("; ")}). No config file was written by the update (V2 preserved by never rewriting it); the installed package is left in place and reported, never guessed.`,
            mutated: true,
            rolledBack: false,
            mcpConnected: afterConnected,
            ownership: ownershipProbe.ownership,
        };
    }
    return {
        status: "updated",
        installedVersion: initial.version,
        resultingVersion: verify.version ?? available,
        availableVersion: available,
        detail: `ZotPilot ${initial.version} updated to ${verify.version ?? available} via user-scoped pip install --user ${spec} with the direct V2 registration preserved byte-exact and the pinned permission policy untouched; validated via zotpilot --version + opencode mcp list`,
        mutated: true,
        rolledBack: false,
        mcpConnected: true,
        ownership: ownershipProbe.ownership,
    };
}
/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.zotpilot` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — ZotPilot releases
 * are discovered at runtime (never a version database).
 */
export async function zotpilotUpgradeComponent(ctx) {
    void ctx.target;
    const result = await ensureZotpilot(ctx.executor, { configDir: ctx.configDir });
    switch (result.status) {
        case "installed":
        case "updated":
        case "already-current":
            return { component: "zotpilot", status: "completed", detail: result.detail, mutated: result.mutated };
        case "report-only":
            return { component: "zotpilot", status: "skipped", detail: result.detail, mutated: false };
        case "install-failed":
        case "update-failed":
        case "validation-failed":
            return {
                component: "zotpilot",
                status: result.rolledBack === true ? "rolled-back" : "unresolved",
                detail: result.detail,
                mutated: true,
            };
    }
}
//# sourceMappingURL=zotpilot.js.map