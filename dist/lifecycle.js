import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { depsSync, defaultExecutor } from "./deps.js";
import { configureModels, } from "./model-config.js";
import { defaultAgentsDir, installAgentFiles, rollbackAgentInstall } from "./agents.js";
import { defaultGlobalConfigPath, ensureAriaSetupConfigFile, isSameLocalPluginIdentity, resolveSetupAriaConfig, rollbackSetupConfigFile, } from "./setup-config.js";
import { getPackageSkillsRoot } from "./skills.js";
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
/**
 * Parse V2 `opencode plugin list` output into table entries.
 * Recognized shapes: the `ID  VERSION  SOURCE` header followed by rows, or
 * the literal `No plugins found` (recognized empty). Anything else is
 * unrecognized (never guessed).
 */
function parsePluginList(output) {
    const lines = output.split("\n");
    if (lines.some((line) => line.trim().toLowerCase() === "no plugins found")) {
        return { recognized: true, entries: [] };
    }
    const headerIndex = lines.findIndex((line) => /^\s*ID\s+VERSION\s+SOURCE\s*$/i.test(line));
    if (headerIndex === -1) {
        return { recognized: false, entries: [] };
    }
    const entries = [];
    for (let index = headerIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() === "")
            continue;
        // ID and VERSION contain no spaces; SOURCE is the remainder (paths may
        // contain spaces, e.g. "my project (v2)").
        const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
        if (!match?.[1] || !match[2] || !match[3])
            continue;
        entries.push({ id: match[1], version: match[2], target: match[3].trim() });
    }
    return { recognized: true, entries };
}
/**
 * Local-identity match for `plugin list` SOURCE entries (one consistent
 * T008 rule, owned by `src/setup-config.ts`): an absolute path and its
 * corresponding `file://` URI are one identity. The SOURCE column reports
 * absolute paths for local plugins, so the checkout path compares directly
 * and `file://` equivalence is accepted for config-file forms. Bare npm
 * names, remote URLs, and unrelated specifiers match only on exact
 * equality (existing symlink/realpath behavior preserved: lexical only).
 */
function matchesCurrentPluginTarget(target, checkout, pluginUri) {
    return isSameLocalPluginIdentity(target, checkout) || isSameLocalPluginIdentity(target, pluginUri);
}
/**
 * Interpret a `opencode plugin add <package>` result. Success reports
 * `registered` (or `already registered` when the runtime confirms the spec
 * is already configured). Failure reports `already registered` for duplicate
 * diagnostics, follows the documented local-directory path when the pinned
 * runtime rejects a local path with its exact npm/Git-only message (the
 * check happens before any install or config mutation, so falling through
 * to the supported config-file registration below is side-effect-free), and
 * otherwise fails closed.
 */
function interpretPluginAddResult(pluginResult, packageArg) {
    if (pluginResult.ok) {
        if (`${pluginResult.stdout} ${pluginResult.stderr}`.toLowerCase().includes("already configured")) {
            return { action: "already registered", detail: "plugin already configured (reported by plugin add)" };
        }
        return { action: "registered" };
    }
    const combined = `${pluginResult.stderr} ${pluginResult.stdout}`.toLowerCase();
    const isDuplicate = combined.includes("already registered") ||
        combined.includes("duplicate") ||
        combined.includes("already exists") ||
        combined.includes("already configured");
    if (isDuplicate) {
        return { action: "already registered", detail: "treated as already registered (compatibility fallback)" };
    }
    if (combined.includes("must be an npm registry package or git package specifier")) {
        return {
            action: "registered",
            detail: "plugin add does not install local directories (2.0.23 registry/Git only); proceeding to config-file registration",
        };
    }
    return { action: "failed", detail: `opencode plugin add ${packageArg} failed: ${pluginResult.stderr}` };
}
/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 *
 * @deprecated V1-only. `debug info` does not exist on pinned OpenCode 2.0.23
 * (`debug --help` lists agents/config/paths only; `debug info` fails with
 * `Unknown subcommand "info"`). Kept exported for existing unit coverage;
 * setup now uses {@link parsePluginList} (`opencode plugin list`) plus
 * direct config-file truth and never invokes `debug info`.
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
// Terminal seam helpers for the optional model-configuration phase
// ---------------------------------------------------------------------------
/** Build a `ModelConfigureInput` seam reading one trimmed line from a stream. */
function terminalInput(inputStream, outputStream) {
    return (prompt) => new Promise((resolveInput, rejectInput) => {
        const terminal = createInterface({ input: inputStream, output: outputStream });
        terminal.question(prompt, (answer) => {
            terminal.close();
            resolveInput(answer.trim());
        });
        terminal.on("error", rejectInput);
    });
}
/** Build a `ModelConfigureOutput` seam emitting one line to a stream. */
function terminalOutput(stream) {
    return (text) => {
        stream.write(`${text}\n`);
    };
}
// ---------------------------------------------------------------------------
// setup — registration + dependency sync (+ optional model configuration)
// ---------------------------------------------------------------------------
export async function setup(binaryUrl, executor = defaultExecutor, depsSyncFn = depsSync, options = {}) {
    const checkout = await resolveCheckout(binaryUrl);
    const pluginUri = pathToFileURL(checkout).href;
    // T012: an explicit but empty `--plugin-spec` fails closed before any
    // introspection, registration, or file mutation (registering "nothing" must
    // never silently fall back to the local checkout).
    if (options.pluginSpec !== undefined && options.pluginSpec.length === 0) {
        return {
            ok: false,
            stage: "registration",
            setup: {
                registration: { action: "failed", detail: "--plugin-spec is empty (expected a Git package specifier such as github:mscipio/ARIA#<EXACT_SHA>)" },
                sync: { ok: false, error: "sync skipped due to registration failure" },
            },
        };
    }
    // T012: with `--plugin-spec` the spec is the registration argument AND the
    // config-file plugin identity, verbatim (no `file://` conversion: a Git
    // spec is not a local path, and the config must name the same package the
    // runtime installed so detection stays exactly-once). Without it, the
    // narrowest supported local argument is the absolute checkout directory
    // path (no `file://` scheme, no `--global`, no invented flags).
    const pluginSpec = options.pluginSpec;
    const packageArg = pluginSpec ?? checkout;
    const configPluginIdentity = pluginSpec ?? pluginUri;
    let registrationAction = "failed";
    let registrationDetail;
    // -----------------------------------------------------------------------
    // Phase 1 — Register plugin (idempotent via `plugin list` + config truth)
    // -----------------------------------------------------------------------
    //
    // The registration argument is the explicit T012 `--plugin-spec` verbatim
    // when given (a Git package specifier needs no conversion), otherwise the
    // narrowest supported local package argument (the absolute checkout
    // directory path: no `file://` scheme, no `--global`, no invented flags).
    // `plugin list` SOURCE entries compare directly against that same argument
    // (Git specs by exact equality; local checkouts also accept the
    // corresponding `file://` URI under the one consistent local-identity rule
    // shared with the config file truth).
    // Try introspection first (read-only, never mutates config)
    const listResult = await run(executor, checkout, "opencode", "plugin", "list");
    const introspectionOk = listResult.ok && listResult.stdout;
    let usedIntrospection = false;
    if (introspectionOk) {
        const { recognized, entries } = parsePluginList(listResult.stdout);
        if (recognized) {
            usedIntrospection = true;
            const matchesCurrent = (target) => (pluginSpec !== undefined && target === pluginSpec) ||
                matchesCurrentPluginTarget(target, checkout, pluginUri);
            const currentEntries = entries.filter((entry) => matchesCurrent(entry.target));
            if (currentEntries.length > 0) {
                registrationAction = "already registered";
                registrationDetail = currentEntries.length > 1
                    ? "plugin already registered (detected via plugin list; duplicate observed, no new registration)"
                    : "plugin already registered (detected via plugin list)";
            }
            else if (entries.some((entry) => entry.id === "aria")) {
                // Conflicting-stale: an `aria` ID is listed with a different source.
                // Safe update path: add the current checkout below (config phase
                // preserves the stale entry with backup; nothing is deleted).
                const pluginResult = await run(executor, checkout, "opencode", "plugin", "add", packageArg);
                const interpreted = interpretPluginAddResult(pluginResult, packageArg);
                registrationAction = interpreted.action;
                registrationDetail = interpreted.detail;
            }
            else {
                // Absent — register it
                const pluginResult = await run(executor, checkout, "opencode", "plugin", "add", packageArg);
                const interpreted = interpretPluginAddResult(pluginResult, packageArg);
                registrationAction = interpreted.action;
                registrationDetail = interpreted.detail;
            }
        }
        // Unrecognized format → fall through to compatibility fallback
    }
    // Compatibility fallback when introspection unavailable or format unrecognized
    if (!usedIntrospection) {
        const pluginResult = await run(executor, checkout, "opencode", "plugin", "add", packageArg);
        const interpreted = interpretPluginAddResult(pluginResult, packageArg);
        registrationAction = interpreted.action;
        registrationDetail = interpreted.detail;
    }
    // Fail closed — if registration failed, do not proceed to file phases or sync
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
    const registration = { action: registrationAction, detail: registrationDetail };
    // -----------------------------------------------------------------------
    // Phase 1b — Global V2 config (T008): exact plugin URI, single skills
    // root, depth default 3. T002 discovery selects the canonical existing
    // `opencode.json` / `opencode.jsonc` target (fail closed when both
    // exist); the resolved `configState.path` below is authoritative for
    // reporting and rollback. Preserves unrelated user keys, backs up before
    // replacing, and writes nothing when nothing changed. Fail closed: sync
    // is skipped when the config cannot be ensured.
    // -----------------------------------------------------------------------
    const filesOptions = options.files ?? {};
    const globalConfigPath = filesOptions.globalConfigPath ?? defaultGlobalConfigPath();
    const skillsRoot = filesOptions.skillsRoot ?? getPackageSkillsRoot();
    let configState;
    try {
        configState = await ensureAriaSetupConfigFile({ configPath: globalConfigPath, pluginUri: configPluginIdentity, skillsRoot });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            stage: "config",
            setup: {
                registration: { ...registration },
                sync: { ok: false, error: "sync skipped due to config failure" },
                config: { path: globalConfigPath, changed: false, created: false, detail: message },
            },
        };
    }
    const configPhase = {
        path: configState.path,
        changed: configState.changed,
        created: configState.created,
        backupPath: configState.backupPath,
    };
    // -----------------------------------------------------------------------
    // Phase 1c — Managed agent files (T008): the eleven deterministic files
    // via T003 `installAgentFiles` (ownership markers, user-agent backups,
    // atomic writes). Resolution is project-neutral (defaults plus global
    // overrides only) so CWD project models never bake into global files
    // (T005: project overlays stay runtime-only). Failure rolls back the
    // config write above; sync is skipped.
    // -----------------------------------------------------------------------
    const agentsDir = filesOptions.agentsDir ?? defaultAgentsDir();
    let installed;
    try {
        const resolved = resolveSetupAriaConfig(options.worktree ?? process.cwd());
        installed = await installAgentFiles(resolved, { dir: agentsDir });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Partial-install rollback (T008): installAgentFiles throws before
        // returning rollback state, so accumulated agent changes (replaced
        // files + backups, including a backup-moved-before-failed-replacement
        // exposed as `partialResult`) must be rolled back here too. Config
        // rollback below stays mandatory; both passes are best-effort.
        const partial = error?.partialResult;
        if (partial && (partial.written.length > 0 || Object.keys(partial.backups ?? {}).length > 0)) {
            await rollbackAgentInstall(agentsDir, partial).catch(() => undefined);
        }
        await rollbackSetupConfigFile(configState.path, configState).catch(() => undefined);
        return {
            ok: false,
            stage: "agents",
            setup: {
                registration: { ...registration },
                sync: { ok: false, error: "sync skipped due to agent install failure" },
                config: { ...configPhase, detail: "rolled back due to agent install failure" },
                agents: { dir: agentsDir, version: "", written: 0, unchanged: 0, detail: message },
            },
        };
    }
    const agentsPhase = {
        dir: installed.dir,
        version: installed.version,
        written: installed.written.length,
        unchanged: installed.unchanged.length,
    };
    // T003 effective-root forwarding: setup, sync, dependencies, and doctor
    // share one root. The effective global config dir is
    // dirname(globalConfigPath): explicit SetupFilesOptions stays authoritative,
    // otherwise env defaults via defaultGlobalConfigPath() (XDG_CONFIG_HOME or
    // ~/.config). No CLI flags.
    const effectiveConfigDir = dirname(globalConfigPath);
    // -----------------------------------------------------------------------
    // Phase 1d — Shared dependency lifecycle (T017, optional seam). When a
    // `dependenciesFn` is provided (the `aria setup` CLI always provides the
    // real `runSetupDependencies`), invoke the shared adapters directly on the
    // clean/existing OC2+ install: detect → discover latest → install if
    // missing OR update if safely owned/outdated → normalize → validate. No
    // ARIA self-upgrade handoff runs here on any path. Failure skips sync
    // (fail closed); omission skips the phase with pre-T017 behavior.
    // -----------------------------------------------------------------------
    let dependenciesPhase;
    if (options.dependenciesFn) {
        let dependenciesResult;
        try {
            dependenciesResult = await options.dependenciesFn(executor, effectiveConfigDir);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                stage: "dependencies",
                setup: {
                    registration: { ...registration },
                    sync: { ok: false, error: "sync skipped due to dependencies failure" },
                    config: configPhase,
                    agents: agentsPhase,
                    dependencies: { ok: false, outcomes: [], report: `dependencies threw: ${message}` },
                },
            };
        }
        dependenciesPhase = {
            ok: dependenciesResult.ok,
            outcomes: dependenciesResult.outcomes,
            report: dependenciesResult.report,
        };
        if (!dependenciesResult.ok) {
            return {
                ok: false,
                stage: "dependencies",
                setup: {
                    registration: { ...registration },
                    sync: { ok: false, error: "sync skipped due to dependencies failure" },
                    config: configPhase,
                    agents: agentsPhase,
                    dependencies: dependenciesPhase,
                },
            };
        }
    }
    // -----------------------------------------------------------------------
    // Phase 2 — Sync dependencies (always invoked exactly once after the
    // registration and file phases above)
    // -----------------------------------------------------------------------
    let syncResult;
    try {
        syncResult = await depsSyncFn(executor, effectiveConfigDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            stage: "sync",
            setup: {
                registration: { ...registration },
                sync: { ok: false, error: `depsSync threw: ${message}` },
                config: configPhase,
                agents: agentsPhase,
                dependencies: dependenciesPhase,
            },
        };
    }
    const syncOk = syncResult.ok;
    // -----------------------------------------------------------------------
    // Phase 3 — optional interactive model configuration. Runs only when
    // `--configure` was requested and both registration and sync succeeded;
    // registration/sync failure short-circuiting and ordering are unchanged.
    // -----------------------------------------------------------------------
    if (syncOk && options.configure) {
        const configureModelsFn = options.configureModelsFn ?? configureModels;
        const worktree = options.worktree ?? process.cwd();
        const modelOptions = {};
        if (options.input)
            modelOptions.input = terminalInput(options.input, options.output ?? process.stdout);
        if (options.output)
            modelOptions.output = terminalOutput(options.output);
        if (options.tty !== undefined)
            modelOptions.tty = options.tty;
        let modelResult;
        try {
            modelResult = await configureModelsFn(worktree, modelOptions);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                stage: "model_configuration",
                setup: {
                    registration: { ...registration },
                    sync: { ok: true, output: "all dependencies synchronized" },
                    config: configPhase,
                    agents: agentsPhase,
                    dependencies: dependenciesPhase,
                    model: {
                        status: "failed",
                        message: "Model configuration failed; no changes were persisted.",
                        error: `configureModels threw: ${message}`,
                    },
                },
            };
        }
        // "configured", "unchanged", and non-TTY "skipped" all leave setup
        // healthy; only an explicit discovery/write failure fails the phase.
        if (modelResult.status === "failed") {
            return {
                ok: false,
                stage: "model_configuration",
                setup: {
                    registration: { ...registration },
                    sync: { ok: true, output: "all dependencies synchronized" },
                    config: configPhase,
                    agents: agentsPhase,
                    dependencies: dependenciesPhase,
                    model: modelResult,
                },
            };
        }
        // T003 ordering: after a successful route write, managed agents are
        // regenerated from freshly resolved routes in this same invocation, so
        // agent model/variant values match the newly committed routes without a
        // second setup. Only "configured" regenerates; "unchanged" and "skipped"
        // leave agent files untouched, and "failed" above never reaches here.
        // Resolution is project-neutral (defaults plus global overrides only).
        // Unmanaged/user files survive via installAgentFiles backups.
        if (modelResult.status === "configured") {
            try {
                const fresh = resolveSetupAriaConfig(worktree);
                const refreshed = await installAgentFiles(fresh, { dir: agentsDir });
                const refreshedPhase = {
                    dir: refreshed.dir,
                    version: refreshed.version,
                    written: refreshed.written.length,
                    unchanged: refreshed.unchanged.length,
                };
                return {
                    ok: true,
                    stage: "complete",
                    setup: {
                        registration: { ...registration },
                        sync: { ok: true, output: "all dependencies synchronized" },
                        config: configPhase,
                        agents: refreshedPhase,
                        dependencies: dependenciesPhase,
                        model: modelResult,
                    },
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    ok: false,
                    stage: "model_configuration",
                    setup: {
                        registration: { ...registration },
                        sync: { ok: true, output: "all dependencies synchronized" },
                        config: configPhase,
                        agents: {
                            ...agentsPhase,
                            detail: `managed agents could not be regenerated after model configuration: ${message}`,
                        },
                        dependencies: dependenciesPhase,
                        model: modelResult,
                    },
                };
            }
        }
        return {
            ok: true,
            stage: "complete",
            setup: {
                registration: { ...registration },
                sync: { ok: true, output: "all dependencies synchronized" },
                config: configPhase,
                agents: agentsPhase,
                dependencies: dependenciesPhase,
                model: modelResult,
            },
        };
    }
    return {
        ok: syncOk,
        stage: syncOk ? "complete" : "sync",
        setup: {
            registration: { ...registration },
            sync: {
                ok: syncOk,
                output: syncOk ? "all dependencies synchronized" : undefined,
                error: syncOk ? undefined : "one or more dependencies failed to synchronize",
            },
            config: configPhase,
            agents: agentsPhase,
            dependencies: dependenciesPhase,
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
    const binPath = resolve(checkout, "bin", "aria.mjs");
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
export { resolveCheckout, parsePluginSpecifiers, parsePluginList, run as runInCheckout };
//# sourceMappingURL=lifecycle.js.map