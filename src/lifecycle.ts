import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { depsSync, defaultExecutor, type Executor } from "./deps.js";
import {
  configureModels,
  type ModelConfigurationResult,
  type ModelConfigureInput,
  type ModelConfigureOptions,
  type ModelConfigureOutput,
} from "./model-config.js";
import { defaultAgentsDir, installAgentFiles, rollbackAgentInstall, type AgentInstallResult } from "./agents.js";
import {
  defaultGlobalConfigPath,
  ensureAriaSetupConfigFile,
  isSameLocalPluginIdentity,
  resolveSetupAriaConfig,
  rollbackSetupConfigFile,
  type SetupConfigFileResult,
} from "./setup-config.js";
import { getPackageSkillsRoot } from "./skills.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LifecycleResult {
  ok: boolean;
  stage: string;
  setup?: SetupResult;
  update?: UpdateResult;
}

export interface SetupResult {
  registration: { action: "registered" | "already registered" | "failed"; detail?: string };
  sync: { ok: boolean; output?: string; error?: string };
  /**
   * Outcome of the global V2 config phase (T008). Always present unless
   * registration failed first.
   */
  config?: SetupConfigPhase;
  /**
   * Outcome of the managed agent-file phase (T008). Always present unless
   * registration or config failed first.
   */
  agents?: SetupAgentsPhase;
  /** Outcome of the optional model-configuration phase; absent unless requested. */
  model?: ModelConfigurationResult;
}

/**
 * T008 file-phase outcomes: global `opencode.json` (exact plugin URI,
 * single skills root, depth default 3; unrelated user keys preserved,
 * backup before replace, idempotent) and the eleven managed agent files
 * (via T003 `installAgentFiles`, resolved project-neutral).
 */
export interface SetupConfigPhase {
  path: string;
  changed: boolean;
  created: boolean;
  backupPath?: string;
  detail?: string;
}

export interface SetupAgentsPhase {
  dir: string;
  version: string;
  written: number;
  unchanged: number;
  detail?: string;
}

/**
 * Model-configuration seam for `setup` (defaults to the real `configureModels`),
 * so tests can inject a mock without touching discovery or the interactive UI.
 */
export type ConfigureModelsFn = (
  worktree: string,
  options?: ModelConfigureOptions,
) => Promise<ModelConfigurationResult>;

/**
 * Options for `setup`. All fields are optional: omitting them preserves the
 * fully non-interactive `setup(binaryUrl, executor, depsSyncFn)` behavior.
 */
export interface SetupOptions {
  /** Request the optional model-configuration phase after registration and sync. */
  configure?: boolean;
  /** Worktree passed to model configuration (defaults to `process.cwd()`). */
  worktree?: string;
  /** Terminal input stream for interactive prompts (defaults to `process.stdin`). */
  input?: Readable;
  /** Terminal output stream for prompts (defaults to `process.stdout`). */
  output?: Writable;
  /** Explicit TTY override (defaults to `process.stdin.isTTY`). */
  tty?: boolean;
  /** Model-configuration seam (defaults to the real `configureModels`). */
  configureModelsFn?: ConfigureModelsFn;
  /**
   * T012 Git-package source (`aria setup --plugin-spec <spec>`): explicit
   * `opencode plugin add` package specifier (e.g.
   * `github:mscipio/ARIA#<EXACT_SHA>`). Used verbatim as the registration
   * argument and the config-file plugin identity — never rewritten to a
   * `file://` URI, never given `--global` (2.0.23 documents no such flag for
   * `plugin add`). Absent preserves the local-checkout behavior (absolute
   * checkout path, no `file://` scheme, no invented flags).
   */
  pluginSpec?: string;
  /**
   * T008 file-phase path overrides (all optional; omitted values resolve to
   * the production defaults: global `opencode.json`, global agents dir, and
   * the installed package skills root). Tests point these at temp dirs; no
   * workstation files are touched outside the resolved paths.
   */
  files?: SetupFilesOptions;
}

/**
 * Path overrides for the T008 setup file phases. Every field is optional;
 * omitted fields resolve to the production defaults.
 */
export interface SetupFilesOptions {
  /** Global V2 config path (defaults to `~/.config/opencode/opencode.json`). */
  globalConfigPath?: string;
  /** Managed agent directory (defaults to `~/.config/opencode/agents/`). */
  agentsDir?: string;
  /** Version-locked skills root (defaults to the installed package `skills/`). */
  skillsRoot?: string;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface UpdateResult {
  git: { ok: boolean; error?: string };
  npm: { ok: boolean; error?: string };
  handoff: CommandResult & { error?: string };
}

// ---------------------------------------------------------------------------
// Checkout resolution (pure function, independent of process.cwd())
// ---------------------------------------------------------------------------

/**
 * Resolve the checkout directory from a binary URL.
 * The binary is assumed to be at `<checkout>/bin/<name>`.
 */
function resolveCheckout(binaryUrl: string): Promise<string> {
  const binPath = fileURLToPath(binaryUrl);
  const binDir = dirname(binPath);
  const checkout = resolve(binDir, "..");
  return realpath(checkout);
}

// ---------------------------------------------------------------------------
// Local run helper — supports cwd via ExecutorOptions
// ---------------------------------------------------------------------------

async function run(
  executor: Executor,
  cwd: string,
  command: string,
  ...args: string[]
): Promise<CommandResult> {
  try {
    const result = await executor(command, args, { cwd });
    return { exitCode: 0, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: number | string }).code;
    let exitCode: number | null;
    if (typeof code === "number" && Number.isFinite(code) && Number.isInteger(code)) {
      exitCode = code;
    } else if (typeof code === "string" && /^\d+$/.test(code)) {
      const parsed = Number.parseInt(code, 10);
      exitCode = Number.isFinite(parsed) ? parsed : null;
    } else {
      exitCode = null;
    }
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout.trim()
      : "";
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : message;
    return { exitCode, ok: false, stdout, stderr };
  }
}

// ---------------------------------------------------------------------------
// Introspection via `opencode plugin list` (V2, pinned 2.0.23)
// ---------------------------------------------------------------------------
//
// Pinned 2.0.23 contract (isolated `opencode` 2.0.23 binary, exact `--help`
// evidence; workstation 1.18.34 untouched):
// - `opencode plugin --help` lists subcommands
//   list/add/check/update/remove (no bare `plugin <module>` V1 form; bare
//   `plugin file://...` fails with `Unknown subcommand`).
// - `opencode plugin add --help` shows
//   `USAGE opencode plugin add [flags] <package>` with
//   `package string npm registry or Git package specifier` and no `--global`
//   flag (`plugin add ... --global` fails with `Unrecognized flag: --global`).
// - `opencode debug --help` lists subcommands agents/config/paths only;
//   `debug info` fails with `Unknown subcommand "info"`.
// - `opencode plugin list --help` shows `USAGE opencode plugin list [flags]`
//   with an optional `--builtin` flag. Its table output (see
//   `packages/cli/src/commands/handlers/plugin/list.ts` `format()`) is a
//   `ID  VERSION  SOURCE` header followed by one row per plugin, or the
//   literal `No plugins found` when empty. Local entries report VERSION
//   `local` and SOURCE as the absolute filesystem path (via `fileURLToPath`,
//   never a `file://` URI); TUI-only entries use ID `-`.
// - `plugin add` installs npm/Git specs only (see
//   `packages/cli/src/commands/handlers/plugin/add.ts` plus
//   `packages/util/src/npm.ts` `parse()`: only npm-package-arg `version`,
//   `range`, `tag`, and `git` types are installable; `directory`/`file`/
//   `link` specs fail with
//   `Plugin target must be an npm registry package or Git package specifier`
//   before any install or config mutation). Local directories therefore
//   register through the global-config `plugins[]` file truth (see
//   `packages/core/src/config/plugin/source.ts` `scan()` + `localSource()`:
//   `file://`, absolute-path, and `./`/`../` entries all resolve to local),
//   which T008 `ensureAriaSetupConfigFile` already writes with backup.
// - `plugin add` already targets the global configuration (its description
//   is `Install a plugin and add it to the global configuration`), so no
//   `--global` flag exists or is passed (no invented flags).
//
// Registration therefore uses `opencode plugin add <package>` with the T012
// `--plugin-spec` verbatim when given (a Git spec installs directly, no
// conversion), otherwise the narrowest local argument (the absolute checkout
// directory path: no `file://` scheme, no `--global`, no invented flags).
// When the pinned runtime rejects that local path with its exact npm/Git-only
// message, setup proceeds to the supported config-file local registration
// below instead of failing closed on an expected CLI limitation; every other
// registration error still fails closed before any file mutation or sync.

/**
 * V2 `opencode plugin list` table entry (ID/VERSION/SOURCE columns).
 */
export interface PluginListEntry {
  id: string;
  version: string;
  /** SOURCE column: absolute local path for local plugins, package spec otherwise. */
  target: string;
}

/**
 * Parse V2 `opencode plugin list` output into table entries.
 * Recognized shapes: the `ID  VERSION  SOURCE` header followed by rows, or
 * the literal `No plugins found` (recognized empty). Anything else is
 * unrecognized (never guessed).
 */
function parsePluginList(output: string): { recognized: boolean; entries: PluginListEntry[] } {
  const lines = output.split("\n");
  if (lines.some((line) => line.trim().toLowerCase() === "no plugins found")) {
    return { recognized: true, entries: [] };
  }
  const headerIndex = lines.findIndex((line) => /^\s*ID\s+VERSION\s+SOURCE\s*$/i.test(line));
  if (headerIndex === -1) {
    return { recognized: false, entries: [] };
  }
  const entries: PluginListEntry[] = [];
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    // ID and VERSION contain no spaces; SOURCE is the remainder (paths may
    // contain spaces, e.g. "my project (v2)").
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!match?.[1] || !match[2] || !match[3]) continue;
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
function matchesCurrentPluginTarget(target: string, checkout: string, pluginUri: string): boolean {
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
function interpretPluginAddResult(
  pluginResult: CommandResult,
  packageArg: string,
): { action: "registered" | "already registered" | "failed"; detail?: string } {
  if (pluginResult.ok) {
    if (`${pluginResult.stdout} ${pluginResult.stderr}`.toLowerCase().includes("already configured")) {
      return { action: "already registered", detail: "plugin already configured (reported by plugin add)" };
    }
    return { action: "registered" };
  }
  const combined = `${pluginResult.stderr} ${pluginResult.stdout}`.toLowerCase();
  const isDuplicate =
    combined.includes("already registered") ||
    combined.includes("duplicate") ||
    combined.includes("already exists") ||
    combined.includes("already configured");
  if (isDuplicate) {
    return { action: "already registered", detail: "treated as already registered (compatibility fallback)" };
  }
  if (combined.includes("must be an npm registry package or git package specifier")) {
    return {
      action: "registered",
      detail:
        "plugin add does not install local directories (2.0.23 registry/Git only); proceeding to config-file registration",
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
function parsePluginSpecifiers(output: string): { recognized: boolean; specifiers: string[] } {
  const lines = output.split("\n");
  const specifiers: string[] = [];
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
function terminalInput(inputStream: Readable, outputStream: Writable): ModelConfigureInput {
  return (prompt) =>
    new Promise((resolveInput, rejectInput) => {
      const terminal = createInterface({ input: inputStream, output: outputStream });
      terminal.question(prompt, (answer) => {
        terminal.close();
        resolveInput(answer.trim());
      });
      terminal.on("error", rejectInput);
    });
}

/** Build a `ModelConfigureOutput` seam emitting one line to a stream. */
function terminalOutput(stream: Writable): ModelConfigureOutput {
  return (text) => {
    stream.write(`${text}\n`);
  };
}

// ---------------------------------------------------------------------------
// setup — registration + dependency sync (+ optional model configuration)
// ---------------------------------------------------------------------------

export async function setup(
  binaryUrl: string,
  executor: Executor = defaultExecutor,
  depsSyncFn: typeof depsSync = depsSync,
  options: SetupOptions = {},
): Promise<LifecycleResult> {
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

  let registrationAction: SetupResult["registration"]["action"] = "failed";
  let registrationDetail: string | undefined;

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

      const matchesCurrent = (target: string): boolean =>
        (pluginSpec !== undefined && target === pluginSpec) ||
        matchesCurrentPluginTarget(target, checkout, pluginUri);
      const currentEntries = entries.filter((entry) => matchesCurrent(entry.target));
      if (currentEntries.length > 0) {
        registrationAction = "already registered";
        registrationDetail = currentEntries.length > 1
          ? "plugin already registered (detected via plugin list; duplicate observed, no new registration)"
          : "plugin already registered (detected via plugin list)";
      } else if (entries.some((entry) => entry.id === "aria")) {
        // Conflicting-stale: an `aria` ID is listed with a different source.
        // Safe update path: add the current checkout below (config phase
        // preserves the stale entry with backup; nothing is deleted).
        const pluginResult = await run(executor, checkout, "opencode", "plugin", "add", packageArg);
        const interpreted = interpretPluginAddResult(pluginResult, packageArg);
        registrationAction = interpreted.action;
        registrationDetail = interpreted.detail;
      } else {
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

  const registration = { action: registrationAction, detail: registrationDetail } as const;

  // -----------------------------------------------------------------------
  // Phase 1b — Global V2 config (T008): exact plugin URI, single skills
  // root, depth default 3. Preserves unrelated user keys, backs up before
  // replacing, and writes nothing when nothing changed. Fail closed: sync
  // is skipped when the config cannot be ensured.
  // -----------------------------------------------------------------------

  const filesOptions = options.files ?? {};
  const globalConfigPath = filesOptions.globalConfigPath ?? defaultGlobalConfigPath();
  const skillsRoot = filesOptions.skillsRoot ?? getPackageSkillsRoot();

  let configState: SetupConfigFileResult;
  try {
    configState = await ensureAriaSetupConfigFile({ configPath: globalConfigPath, pluginUri: configPluginIdentity, skillsRoot });
  } catch (error) {
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
  const configPhase: SetupConfigPhase = {
    path: globalConfigPath,
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
  let installed: AgentInstallResult;
  try {
    const resolved = resolveSetupAriaConfig(options.worktree ?? process.cwd());
    installed = await installAgentFiles(resolved, { dir: agentsDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Partial-install rollback (T008): installAgentFiles throws before
    // returning rollback state, so accumulated agent changes (replaced
    // files + backups, including a backup-moved-before-failed-replacement
    // exposed as `partialResult`) must be rolled back here too. Config
    // rollback below stays mandatory; both passes are best-effort.
    const partial = (error as { partialResult?: AgentInstallResult } | null | undefined)?.partialResult;
    if (partial && (partial.written.length > 0 || Object.keys(partial.backups ?? {}).length > 0)) {
      await rollbackAgentInstall(agentsDir, partial).catch(() => undefined);
    }
    await rollbackSetupConfigFile(globalConfigPath, configState).catch(() => undefined);
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
  const agentsPhase: SetupAgentsPhase = {
    dir: installed.dir,
    version: installed.version,
    written: installed.written.length,
    unchanged: installed.unchanged.length,
  };

  // -----------------------------------------------------------------------
  // Phase 2 — Sync dependencies (always invoked exactly once after the
  // registration and file phases above)
  // -----------------------------------------------------------------------

  let syncResult: Awaited<ReturnType<typeof depsSync>>;
  try {
    syncResult = await depsSyncFn(executor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stage: "sync",
      setup: {
        registration: { ...registration },
        sync: { ok: false, error: `depsSync threw: ${message}` },
        config: configPhase,
        agents: agentsPhase,
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
    const modelOptions: ModelConfigureOptions = {};
    if (options.input) modelOptions.input = terminalInput(options.input, options.output ?? process.stdout);
    if (options.output) modelOptions.output = terminalOutput(options.output);
    if (options.tty !== undefined) modelOptions.tty = options.tty;

    let modelResult: ModelConfigurationResult;
    try {
      modelResult = await configureModelsFn(worktree, modelOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: "model_configuration",
        setup: {
          registration: { ...registration },
          sync: { ok: true, output: "all dependencies synchronized" },
          config: configPhase,
          agents: agentsPhase,
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
          model: modelResult,
        },
      };
    }

    return {
      ok: true,
      stage: "complete",
      setup: {
        registration: { ...registration },
        sync: { ok: true, output: "all dependencies synchronized" },
        config: configPhase,
        agents: agentsPhase,
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
    },
  };
}

// ---------------------------------------------------------------------------
// update — git pull, npm ci, subprocess handoff
// ---------------------------------------------------------------------------

export async function update(
  binaryUrl: string,
  executor: Executor = defaultExecutor,
): Promise<LifecycleResult> {
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
  const handoffResult: UpdateResult["handoff"] = {
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
