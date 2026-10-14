// ---------------------------------------------------------------------------
// T012 — Engram lifecycle adapter (shared by `aria setup` and `aria upgrade`).
//
// Detect installed state (version + install channel: homebrew vs github
// asset), install-if-missing OR update-if-outdated via the demonstrated-safe
// path (detected channel + `engram setup opencode` + the T016 bootstrap
// evidence in `src/bootstrap.ts`), then configure/normalize V2/XDG and
// validate version + MCP connectivity.
//
// - Already-current short-circuits the version update but not the required
//   normalization (`engram setup opencode` + T005 statusline cleanup).
// - T005 statusline cleanup/normalization is REUSED by import from
//   `src/deps.ts`; no duplicate logic lives here.
// - Binding: this adapter is shared — callable directly by `aria setup`
//   (no handoff needed) AND post-handoff by `aria upgrade` via
//   `engramUpgradeComponent` (already-current ARIA needs no self-replacement).
// - XDG-contained: an explicit `configDir` that diverges from the effective
//   OpenCode global dir fails closed as report-only (the native
//   `engram setup opencode` honors only the env-derived root; the Executor
//   carries no env seam, so targeting cannot be verified — same guard as the
//   T007 Quota adapter). Dual `opencode.json` + `opencode.jsonc` ambiguity
//   likewise fails closed with zero mutation (T002).
// - Validation is version + `opencode mcp list` connectivity + statusline
//   absence; the connectivity read alone retries on a bounded,
//   injectable-delay convergence bound (version + statusline stay
//   single-shot) and fails closed after exhaustion. Validation/setup
//   failures restore the snapshotted global config — the four managed JSONs
//   plus the demonstrated `plugins/engram.ts` side effect, byte-precise —
//   where feasible (the installed binary itself is left in place and
//   reported, same rule as the T016 bootstrap + T007 adapters). Unsnapshottable
//   prior state (unreadable/unstatable pre-existing file) fails closed before
//   setup with zero mutation and zero deletion; rollback deletes only
//   proven-absent (ENOENT-stat) files, never unknown state.
// ---------------------------------------------------------------------------
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BOOTSTRAP_EVIDENCE } from "./bootstrap.js";
import { cleanupIncompatibleStatusline, detectEngram, detectEngramSource, detectIncompatibleStatusline, detectMcpConnectivity, syncEngramGitHub, syncEngramHomebrew, } from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
/** Demonstrated-safe missing-install evidence owning this adapter's path (T016). */
export const ENGRAM_BOOTSTRAP_EVIDENCE = BOOTSTRAP_EVIDENCE.find((entry) => entry.component === "engram");
/**
 * Read-only installed-state probe: version via `engram version` plus the
 * install channel via Homebrew-cellar ownership. `unknown` covers every
 * non-Homebrew existing install and takes the checksum-verified GitHub asset
 * path on update (per T016); `missing` means no binary was found. Never
 * mutates.
 */
export async function detectEngramState(executor, fileOps) {
    const detected = await detectEngram(executor);
    if (!detected.found)
        return { found: false, version: null, channel: "missing" };
    const source = fileOps === undefined ? await detectEngramSource(executor) : await detectEngramSource(executor, fileOps);
    const channel = source === "homebrew" ? "homebrew" : "unknown";
    return { found: true, version: detected.version, channel };
}
function managedPaths(base) {
    return [
        join(base, "opencode.json"),
        join(base, "opencode.jsonc"),
        join(base, "cli.json"),
        join(base, "tui.json"),
        // Demonstrated `engram setup opencode` side effect only (isolated
        // scratch-XDG tree-diff 2026-10-14, engram 3.4.0): the OpenCode plugin
        // adapter — created at 54945 bytes when absent, rewritten with identical
        // bytes when present, merged-preserved neighbors otherwise. No other
        // file appeared anywhere in the isolated tree, so no wider scope.
        join(base, "plugins", "engram.ts"),
    ];
}
function defaultDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Default MCP-list convergence: 3 polls/100ms — 1 initial read plus 2
 * additional polls, 200ms worst-case added latency (sub-second total).
 */
const DEFAULT_MCP_CONVERGENCE = { attempts: 3, delayMs: 100 };
/**
 * Bounded `opencode mcp list` connectivity read: returns the first sample
 * reporting Engram connected, else the last sample once the bound is
 * exhausted. ONLY this read retries; the version (`detectEngram`) and
 * statusline checks stay single-shot. Callers fail closed on exhaustion
 * (validation-failed + rollback).
 */
async function pollMcpConnectivity(executor, bound, delay) {
    const attempts = bound.attempts ?? DEFAULT_MCP_CONVERGENCE.attempts;
    const delayMs = bound.delayMs ?? DEFAULT_MCP_CONVERGENCE.delayMs;
    const total = Math.max(1, attempts);
    let last = { engram: false, context7: false, codegraph: false, listFailed: true };
    for (let poll = 1; poll <= total; poll++) {
        if (poll > 1)
            await delay(delayMs);
        const sample = await detectMcpConnectivity(executor);
        if (sample.engram === true)
            return sample;
        last = sample;
    }
    return last;
}
function snapshotErrorMessage(error) {
    if (error instanceof Error) {
        const code = error.code;
        return code ? `${code}: ${error.message}` : error.message;
    }
    return String(error);
}
async function snapshotOneFile(path) {
    // Stat first so genuine absence (ENOENT) is proven by the stat itself —
    // never inferred from a failed read. A stat success means something exists
    // at the path, so a subsequent read failure (EACCES or otherwise) leaves
    // the prior state unsnapshottable (unknown), never absent.
    try {
        await stat(path);
    }
    catch (error) {
        const code = error?.code;
        if (code === "ENOENT")
            return { path, raw: null, state: "absent" };
        // Unstatable (EACCES or other): attempt one read — an unexpected success
        // still yields exact bytes, otherwise the state is unknown.
        try {
            return { path, raw: await readFile(path), state: "present" };
        }
        catch (readError) {
            return { path, raw: null, state: "unknown", error: snapshotErrorMessage(readError) };
        }
    }
    try {
        return { path, raw: await readFile(path), state: "present" };
    }
    catch (error) {
        return { path, raw: null, state: "unknown", error: snapshotErrorMessage(error) };
    }
}
async function snapshotManagedFiles(base) {
    const snapshots = [];
    for (const path of managedPaths(base)) {
        snapshots.push(await snapshotOneFile(path));
    }
    return snapshots;
}
async function restoreSnapshots(snapshots) {
    let ok = true;
    for (const snapshot of snapshots) {
        try {
            if (snapshot.state === "absent") {
                // Deletion is permitted ONLY here: genuine absence was proven by an
                // ENOENT stat before any mutation, so only an invocation-created
                // file can be removed. Unknown prior state is never deleted.
                await rm(snapshot.path, { force: true });
            }
            else if (snapshot.state === "present") {
                await writeFile(snapshot.path, snapshot.raw);
            }
            else {
                ok = false;
            }
        }
        catch {
            ok = false;
        }
    }
    return ok;
}
async function snapshotsChanged(snapshots) {
    for (const snapshot of snapshots) {
        if (snapshot.state === "unknown")
            return true;
        let current = null;
        try {
            current = await readFile(snapshot.path);
        }
        catch {
            current = null;
        }
        if (snapshot.state === "absent" && current === null)
            continue;
        if (snapshot.state === "absent" || current === null)
            return true;
        if (!snapshot.raw.equals(current))
            return true;
    }
    return false;
}
function reportOnly(channel, detail) {
    return {
        status: "report-only",
        installedVersion: null,
        resultingVersion: null,
        channel,
        detail,
        mutated: false,
        mcpConnected: false,
        statuslineAbsent: false,
    };
}
async function tryExec(executor, command, args) {
    try {
        const result = await executor(command, args);
        return { ok: true, stdout: result.stdout, stderr: result.stderr };
    }
    catch (error) {
        return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Shared lifecycle: install-if-missing OR update-if-outdated via the
 * detected channel, then normalize (`engram setup opencode` + T005 cleanup)
 * and validate version + MCP connectivity.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `engramUpgradeComponent`); it takes no handoff payload
 * and performs no ARIA self-replacement.
 */
export async function ensureEngram(executor, options = {}) {
    const configDir = options.configDir;
    const fileOps = options.fileOps;
    // XDG guard: the native `engram setup opencode` honors only the
    // env-derived global root (the Executor carries no env seam), so a
    // divergent explicit dir fails closed with zero executor calls.
    if (configDir !== undefined && resolve(configDir) !== resolve(openCodeGlobalDir())) {
        return reportOnly("unknown", "explicit config dir diverges from the effective OpenCode global dir; native setup targeting cannot be verified, leaving Engram untouched");
    }
    const base = openCodeGlobalDir(configDir);
    const snapshots = await snapshotManagedFiles(base);
    // T006 snapshot guard: when prior state cannot be snapshotted (unstatable
    // or unreadable pre-existing file — EACCES or other non-ENOENT failure),
    // fail closed BEFORE any setup mutation with zero rollback deletion. Only
    // a proven-absent (ENOENT stat) snapshot may later be deleted; unknown
    // state is never removed.
    const unsnapshotted = snapshots.filter((snapshot) => snapshot.state === "unknown");
    if (unsnapshotted.length > 0) {
        const statusline = await detectIncompatibleStatusline(configDir);
        return {
            status: "validation-failed",
            installedVersion: null,
            resultingVersion: null,
            channel: "unknown",
            detail: `pre-change snapshot failed for ${unsnapshotted.map((snapshot) => `${snapshot.path} (${snapshot.error})`).join(", ")}; prior state cannot be safely restored, leaving Engram untouched with zero setup mutation and zero deletion`,
            mutated: false,
            rolledBack: false,
            mcpConnected: false,
            statuslineAbsent: !statusline.present,
        };
    }
    // Dual-file ambiguity (T002): never guess which file is redundant.
    const beforeJson = snapshots[0]?.raw ?? null;
    const beforeJsonc = snapshots[1]?.raw ?? null;
    if (beforeJson !== null && beforeJsonc !== null) {
        const jsonPath = snapshots[0]?.path ?? join(base, "opencode.json");
        const jsoncPath = snapshots[1]?.path ?? join(base, "opencode.jsonc");
        return reportOnly("unknown", `global ${jsonPath} and ${jsoncPath} both exist; dual-file ambiguity fails closed with neither file mutated`);
    }
    const initial = await detectEngramState(executor, fileOps);
    const wasMissing = !initial.found;
    let sync;
    if (wasMissing) {
        const brewProbe = await tryExec(executor, "which", ["brew"]);
        if (brewProbe.ok && brewProbe.stdout.trim() !== "") {
            const installed = await tryExec(executor, "brew", ["install", "--formula", "gentleman-programming/tap/engram"]);
            if (installed.ok) {
                const setup = await tryExec(executor, "engram", ["setup", "opencode"]);
                if (setup.ok) {
                    try {
                        await cleanupIncompatibleStatusline(configDir);
                    }
                    catch {
                        // Best-effort: setup already succeeded; cleanup failure is
                        // surfaced by the statusline validation below, never masked here.
                    }
                }
                else {
                    const rolledBack = await restoreSnapshots(snapshots);
                    const statusline = await detectIncompatibleStatusline(configDir);
                    return {
                        status: "setup-failed",
                        installedVersion: null,
                        resultingVersion: null,
                        channel: "missing",
                        detail: `engram setup opencode failed (${setup.stderr}); no version is established`,
                        mutated: true,
                        rolledBack,
                        mcpConnected: false,
                        statuslineAbsent: !statusline.present,
                    };
                }
                const verify = await detectEngram(executor);
                if (!verify.found) {
                    const rolledBack = await restoreSnapshots(snapshots);
                    const statusline = await detectIncompatibleStatusline(configDir);
                    return {
                        status: "install-failed",
                        installedVersion: null,
                        resultingVersion: null,
                        channel: "missing",
                        detail: "engram not found after brew install; no version is established",
                        mutated: true,
                        rolledBack,
                        mcpConnected: false,
                        statuslineAbsent: !statusline.present,
                    };
                }
                sync = { action: "synced (homebrew)", version: verify.version ?? undefined };
            }
            else {
                const github = fileOps === undefined
                    ? await syncEngramGitHub(executor, undefined, configDir)
                    : await syncEngramGitHub(executor, fileOps, configDir);
                sync = github;
            }
        }
        else {
            const github = fileOps === undefined
                ? await syncEngramGitHub(executor, undefined, configDir)
                : await syncEngramGitHub(executor, fileOps, configDir);
            sync = github;
        }
    }
    else if (initial.channel === "homebrew") {
        sync = await syncEngramHomebrew(executor, configDir);
    }
    else {
        const github = fileOps === undefined
            ? await syncEngramGitHub(executor, undefined, configDir)
            : await syncEngramGitHub(executor, fileOps, configDir);
        sync = github;
    }
    const PRE_MUTATION_ACTIONS = new Set([
        "unsupported-platform",
        "fetch-failed",
        "parse-failed",
        "no-asset",
        "tmpdir-failed",
        "download-failed",
        "checksum-download-failed",
        "checksum-read-failed",
        "checksum-entry-missing",
        "hash-compute-failed",
        "checksum-mismatch",
        "mkdir-failed",
        "extract-failed",
        "find-failed",
        "copy-failed",
        "chmod-failed",
        "replace-failed",
        "brew-update-failed",
    ]);
    const okActions = new Set(["synced (homebrew)", "synced (github)", "already-latest"]);
    if (!okActions.has(sync.action)) {
        const channel = wasMissing ? "missing" : initial.channel;
        const statusline = await detectIncompatibleStatusline(configDir);
        if (PRE_MUTATION_ACTIONS.has(sync.action)) {
            return {
                status: wasMissing ? "install-failed" : "update-failed",
                installedVersion: initial.version,
                resultingVersion: null,
                channel,
                detail: sync.error ?? `Engram ${wasMissing ? "install" : "update"} failed (${sync.action}) with no persistent change`,
                mutated: false,
                mcpConnected: false,
                statuslineAbsent: !statusline.present,
            };
        }
        const rolledBack = await restoreSnapshots(snapshots);
        const kind = sync.action === "setup-failed" ? "setup-failed" : wasMissing ? "install-failed" : "update-failed";
        return {
            status: kind,
            installedVersion: initial.version,
            resultingVersion: null,
            channel,
            detail: `${sync.error ?? `Engram ${wasMissing ? "install" : "update"} failed (${sync.action})`}. Global config ${rolledBack ? "restored to the pre-change bytes" : "restore failed; state is exactly as left"}. The installed binary is left in place and reported, never guessed.`,
            mutated: true,
            rolledBack,
            mcpConnected: false,
            statuslineAbsent: !statusline.present,
        };
    }
    // Post-change validation: version + MCP connectivity + statusline absence.
    // The sync paths already ran best-effort statusline cleanup; one more
    // idempotent pass here guarantees the acceptance invariant without
    // duplicating the removal logic.
    try {
        await cleanupIncompatibleStatusline(configDir);
    }
    catch {
        // Surfaced below via the absence check.
    }
    const final = await detectEngram(executor);
    const mcp = await pollMcpConnectivity(executor, options.mcpConvergence ?? {}, options.delay ?? defaultDelay);
    const statusline = await detectIncompatibleStatusline(configDir);
    const connected = mcp.engram === true;
    const absent = !statusline.present;
    const channel = wasMissing ? (initial.channel === "missing" ? "missing" : initial.channel) : initial.channel;
    if (!final.found || !connected || !absent) {
        const rolledBack = await restoreSnapshots(snapshots);
        const problems = [
            !final.found ? "engram binary not found after change" : null,
            final.found && !final.version ? "engram version not positively identified after change" : null,
            !connected ? (mcp.listFailed === true ? "`opencode mcp list` unavailable; connectivity not positively confirmed" : "engram not connected in `opencode mcp list`") : null,
            !absent ? `incompatible statusline still registered (${statusline.files.join(", ")})` : null,
        ].filter((part) => part !== null);
        return {
            status: "validation-failed",
            installedVersion: initial.version,
            resultingVersion: final.version,
            channel,
            detail: `post-change validation failed (${problems.join("; ")}). ${rolledBack ? "Global config restored to the pre-change bytes." : "Global config restore failed; state is exactly as left."} The installed binary is left in place and reported, never guessed.`,
            mutated: true,
            rolledBack,
            mcpConnected: connected,
            statuslineAbsent: absent,
        };
    }
    const changed = await snapshotsChanged(snapshots);
    const versionChanged = (initial.version ?? null) !== (final.version ?? null);
    if (wasMissing) {
        return {
            status: "installed",
            installedVersion: null,
            resultingVersion: final.version,
            channel,
            detail: `Engram ${final.version ?? "unknown"} installed via the demonstrated-safe ${sync.action === "synced (homebrew)" ? "Homebrew" : "GitHub asset"} path with \`engram setup opencode\`; validated via engram version + opencode mcp list (connected) with the incompatible statusline absent and unrelated entries preserved`,
            mutated: true,
            rolledBack: false,
            mcpConnected: true,
            statuslineAbsent: true,
        };
    }
    if (sync.action === "already-latest" || !versionChanged) {
        return {
            status: "already-current",
            installedVersion: initial.version,
            resultingVersion: final.version,
            channel,
            detail: `Engram ${final.version ?? "unknown"} is already current; version update short-circuited with required normalization applied (setup + statusline cleanup) and validated via engram version + opencode mcp list (connected)`,
            mutated: changed,
            rolledBack: false,
            mcpConnected: true,
            statuslineAbsent: true,
        };
    }
    return {
        status: "upgraded",
        installedVersion: initial.version,
        resultingVersion: final.version,
        channel,
        detail: `Engram ${initial.version ?? "unknown"} upgraded to ${final.version ?? "unknown"} via the detected ${initial.channel === "homebrew" ? "Homebrew" : "GitHub asset"} path with \`engram setup opencode\`; validated via engram version + opencode mcp list (connected) with the incompatible statusline absent and unrelated entries preserved`,
        mutated: true,
        rolledBack: false,
        mcpConnected: true,
        statuslineAbsent: true,
    };
}
/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.engram` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — Engram versions are
 * discovered at runtime (never a version database).
 */
export async function engramUpgradeComponent(ctx) {
    void ctx.target;
    const result = await ensureEngram(ctx.executor, { configDir: ctx.configDir });
    switch (result.status) {
        case "installed":
        case "upgraded":
        case "already-current":
            return { component: "engram", status: "completed", detail: result.detail, mutated: result.mutated };
        case "report-only":
            return { component: "engram", status: "skipped", detail: result.detail, mutated: false };
        case "install-failed":
        case "update-failed":
        case "setup-failed":
        case "validation-failed":
            return {
                component: "engram",
                status: result.rolledBack === true ? "rolled-back" : "unresolved",
                detail: result.detail,
                mutated: true,
            };
    }
}
//# sourceMappingURL=engram.js.map