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
  /** Outcome of the optional model-configuration phase; absent unless requested. */
  model?: ModelConfigurationResult;
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
// Introspection via opencode debug info
// ---------------------------------------------------------------------------

/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 * Returns the list of plugin specifier strings found in the plugins section
 * and whether a plugins section was recognized at all.
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

  let registrationAction: SetupResult["registration"]["action"] = "failed";
  let registrationDetail: string | undefined;

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
      } else {
        // Plugin not registered yet — register it
        const pluginResult = await run(executor, checkout, "opencode", "plugin", pluginUri, "--global");
        if (pluginResult.ok) {
          registrationAction = "registered";
        } else {
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
    } else {
      const combined = `${pluginResult.stderr} ${pluginResult.stdout}`.toLowerCase();
      const isDuplicate =
        combined.includes("already registered") ||
        combined.includes("duplicate") ||
        combined.includes("already exists") ||
        combined.includes("already configured");
      if (isDuplicate) {
        registrationAction = "already registered";
        registrationDetail = "treated as already registered (compatibility fallback)";
      } else {
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

  let syncResult: Awaited<ReturnType<typeof depsSync>>;
  try {
    syncResult = await depsSyncFn(executor);
  } catch (error) {
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
          registration: { action: registrationAction, detail: registrationDetail },
          sync: { ok: true, output: "all dependencies synchronized" },
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
          registration: { action: registrationAction, detail: registrationDetail },
          sync: { ok: true, output: "all dependencies synchronized" },
          model: modelResult,
        },
      };
    }

    return {
      ok: true,
      stage: "complete",
      setup: {
        registration: { action: registrationAction, detail: registrationDetail },
        sync: { ok: true, output: "all dependencies synchronized" },
        model: modelResult,
      },
    };
  }

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
export { resolveCheckout, parsePluginSpecifiers, run as runInCheckout };
