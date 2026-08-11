import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { depsSync, defaultExecutor } from "./deps.js";
// ---------------------------------------------------------------------------
// Checkout resolution (pure function, independent of process.cwd())
// ---------------------------------------------------------------------------
/**
 * Resolve the checkout directory from a binary URL.
 * The binary is assumed to be at `<checkout>/bin/<name>`.
 */
function resolveCheckout(binaryUrl) {
    const binPath = fileURLToPath(binaryUrl);
    const binDir = dirname(binPath);
    const checkout = resolve(binDir, "..");
    return realpath(checkout);
}
// ---------------------------------------------------------------------------
// Local run helper — supports cwd via ExecutorOptions
// ---------------------------------------------------------------------------
async function run(executor, cwd, command, ...args) {
    try {
        const result = await executor(command, args, { cwd });
        return { exitCode: 0, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error.code;
        let exitCode;
        if (typeof code === "number" && Number.isFinite(code) && Number.isInteger(code)) {
            exitCode = code;
        }
        else if (typeof code === "string" && /^\d+$/.test(code)) {
            const parsed = Number.parseInt(code, 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
        }
        else {
            exitCode = null;
        }
        const stdout = typeof error.stdout === "string"
            ? error.stdout.trim()
            : "";
        const stderr = typeof error.stderr === "string"
            ? error.stderr.trim()
            : message;
        return { exitCode, ok: false, stdout, stderr };
    }
}
// ---------------------------------------------------------------------------
// Introspection via opencode debug info
// ---------------------------------------------------------------------------
/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 * Returns the list of plugin specifier strings found in the plugins section
 * and whether a plugins section was recognized at all.
 */
function parsePluginSpecifiers(output) {
    const lines = output.split("\n");
    const specifiers = [];
    let recognized = false;
    let inPlugins = false;
    let headerIndent = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;
        // Detect plugins section header (case-insensitive)
        if (/^plugins\s*:/i.test(trimmed)) {
            inPlugins = true;
            recognized = true;
            headerIndent = indent;
            continue;
        }
        // Exit plugins section when we reach a non-blank line at same or lesser indent
        if (inPlugins && trimmed !== "" && !trimmed.startsWith("- ") && indent <= headerIndent) {
            inPlugins = false;
            continue;
        }
        if (inPlugins && trimmed !== "") {
            // Strip "- " list marker used by real OpenCode debug info output
            const specifier = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
            if (specifier) {
                specifiers.push(specifier);
            }
        }
    }
    return { recognized, specifiers };
}
// ---------------------------------------------------------------------------
// setup — registration + dependency sync
// ---------------------------------------------------------------------------
export async function setup(binaryUrl, executor = defaultExecutor, depsSyncFn = depsSync) {
    const checkout = await resolveCheckout(binaryUrl);
    const pluginUri = pathToFileURL(checkout).href;
    let registrationAction = "failed";
    let registrationDetail;
    // -----------------------------------------------------------------------
    // Phase 1 — Register plugin (idempotent via introspection)
    // -----------------------------------------------------------------------
    // Try introspection first (read-only, never mutates config)
    const infoResult = await run(executor, checkout, "opencode", "debug", "info");
    const introspectionOk = infoResult.ok && infoResult.stdout;
    let usedIntrospection = false;
    if (introspectionOk) {
        const { recognized, specifiers } = parsePluginSpecifiers(infoResult.stdout);
        if (recognized && specifiers.length > 0) {
            usedIntrospection = true;
            // Compare exact URI
            if (specifiers.some((spec) => spec === pluginUri)) {
                registrationAction = "already registered";
                registrationDetail = "plugin already registered (detected via introspection)";
            }
            else {
                // Plugin not registered yet — register it
                const pluginResult = await run(executor, checkout, "opencode", "plugin", pluginUri, "--global");
                if (pluginResult.ok) {
                    registrationAction = "registered";
                }
                else {
                    registrationAction = "failed";
                    registrationDetail = `opencode plugin ${pluginUri} --global failed: ${pluginResult.stderr}`;
                }
            }
        }
        // recognized-empty section → fall through to compatibility fallback
        // Unrecognized format → fall through to compatibility fallback
    }
    // Compatibility fallback when introspection unavailable or format unrecognized
    if (!usedIntrospection) {
        const pluginResult = await run(executor, checkout, "opencode", "plugin", pluginUri, "--global");
        if (pluginResult.ok) {
            registrationAction = "registered";
        }
        else {
            const combined = `${pluginResult.stderr} ${pluginResult.stdout}`.toLowerCase();
            const isDuplicate = combined.includes("already registered") ||
                combined.includes("duplicate") ||
                combined.includes("already exists") ||
                combined.includes("already configured");
            if (isDuplicate) {
                registrationAction = "already registered";
                registrationDetail = "treated as already registered (compatibility fallback)";
            }
            else {
                registrationAction = "failed";
                registrationDetail = `opencode plugin ${pluginUri} --global failed: ${pluginResult.stderr}`;
            }
        }
    }
    // Fail closed — if registration failed, do not proceed to sync
    if (registrationAction === "failed") {
        return {
            ok: false,
            stage: "registration",
            setup: {
                registration: { action: "failed", detail: registrationDetail },
                sync: { ok: false, error: "sync skipped due to registration failure" },
            },
        };
    }
    // -----------------------------------------------------------------------
    // Phase 2 — Sync dependencies (always invoked exactly once after registration check)
    // -----------------------------------------------------------------------
    let syncResult;
    try {
        syncResult = await depsSyncFn(executor);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            stage: "sync",
            setup: {
                registration: { action: registrationAction, detail: registrationDetail },
                sync: { ok: false, error: `depsSync threw: ${message}` },
            },
        };
    }
    const syncOk = syncResult.ok;
    return {
        ok: syncOk,
        stage: syncOk ? "complete" : "sync",
        setup: {
            registration: { action: registrationAction, detail: registrationDetail },
            sync: {
                ok: syncOk,
                output: syncOk ? "all dependencies synchronized" : undefined,
                error: syncOk ? undefined : "one or more dependencies failed to synchronize",
            },
        },
    };
}
// ---------------------------------------------------------------------------
// update — git pull, npm ci, subprocess handoff
// ---------------------------------------------------------------------------
export async function update(binaryUrl, executor = defaultExecutor) {
    const checkout = await resolveCheckout(binaryUrl);
    // -----------------------------------------------------------------------
    // Git precondition — working tree must be clean (including untracked files)
    // -----------------------------------------------------------------------
    const statusResult = await run(executor, checkout, "git", "status", "--porcelain");
    if (!statusResult.ok) {
        return {
            ok: false,
            stage: "git_precondition",
            update: {
                git: { ok: false, error: `git status failed: ${statusResult.stderr}` },
                npm: { ok: false, error: "skipped" },
                handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
            },
        };
    }
    if (statusResult.stdout.trim() !== "") {
        return {
            ok: false,
            stage: "git_precondition",
            update: {
                git: { ok: false, error: "working tree is dirty (uncommitted changes or untracked files)" },
                npm: { ok: false, error: "skipped" },
                handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
            },
        };
    }
    // -----------------------------------------------------------------------
    // Git precondition — upstream must exist
    // -----------------------------------------------------------------------
    const upstreamResult = await run(executor, checkout, "git", "rev-parse", "--abbrev-ref", "@{upstream}");
    if (!upstreamResult.ok) {
        return {
            ok: false,
            stage: "git_precondition",
            update: {
                git: { ok: false, error: `no upstream configured: ${upstreamResult.stderr}` },
                npm: { ok: false, error: "skipped" },
                handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
            },
        };
    }
    // -----------------------------------------------------------------------
    // git pull --ff-only
    // -----------------------------------------------------------------------
    const pullResult = await run(executor, checkout, "git", "pull", "--ff-only");
    if (!pullResult.ok) {
        return {
            ok: false,
            stage: "git_pull",
            update: {
                git: { ok: false, error: `git pull --ff-only failed: ${pullResult.stderr}` },
                npm: { ok: false, error: "skipped" },
                handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
            },
        };
    }
    // -----------------------------------------------------------------------
    // npm ci --omit=dev
    // -----------------------------------------------------------------------
    const npmResult = await run(executor, checkout, "npm", "ci", "--omit=dev");
    if (!npmResult.ok) {
        return {
            ok: false,
            stage: "npm",
            update: {
                git: { ok: true },
                npm: { ok: false, error: `npm ci --omit=dev failed: ${npmResult.stderr}` },
                handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
            },
        };
    }
    // -----------------------------------------------------------------------
    // Handoff — spawn the updated checkout in a new process
    // -----------------------------------------------------------------------
    const binPath = resolve(checkout, "bin", "rdc.mjs");
    const handoffRunResult = await run(executor, checkout, process.execPath, binPath, "deps", "sync");
    const handoffResult = {
        ...handoffRunResult,
        error: handoffRunResult.ok ? undefined : handoffRunResult.stderr || `exit code ${handoffRunResult.exitCode}`,
    };
    if (!handoffResult.ok) {
        return {
            ok: false,
            stage: "handoff",
            update: {
                git: { ok: true },
                npm: { ok: true },
                handoff: handoffResult,
            },
        };
    }
    return {
        ok: true,
        stage: "complete",
        update: {
            git: { ok: true },
            npm: { ok: true },
            handoff: handoffResult,
        },
    };
}
// Expose for testing
export { resolveCheckout, parsePluginSpecifiers, run as runInCheckout };
//# sourceMappingURL=lifecycle.js.map