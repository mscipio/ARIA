import type { Readable, Writable } from "node:stream";
import { depsSync, type Executor } from "./deps.js";
import { type ModelConfigurationResult, type ModelConfigureOptions } from "./model-config.js";
export interface LifecycleResult {
    ok: boolean;
    stage: string;
    setup?: SetupResult;
    update?: UpdateResult;
}
export interface SetupResult {
    registration: {
        action: "registered" | "already registered" | "failed";
        detail?: string;
    };
    sync: {
        ok: boolean;
        output?: string;
        error?: string;
    };
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
export type ConfigureModelsFn = (worktree: string, options?: ModelConfigureOptions) => Promise<ModelConfigurationResult>;
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
    git: {
        ok: boolean;
        error?: string;
    };
    npm: {
        ok: boolean;
        error?: string;
    };
    handoff: CommandResult & {
        error?: string;
    };
}
/**
 * Resolve the checkout directory from a binary URL.
 * The binary is assumed to be at `<checkout>/bin/<name>`.
 */
declare function resolveCheckout(binaryUrl: string): Promise<string>;
declare function run(executor: Executor, cwd: string, command: string, ...args: string[]): Promise<CommandResult>;
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
declare function parsePluginList(output: string): {
    recognized: boolean;
    entries: PluginListEntry[];
};
/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 *
 * @deprecated V1-only. `debug info` does not exist on pinned OpenCode 2.0.23
 * (`debug --help` lists agents/config/paths only; `debug info` fails with
 * `Unknown subcommand "info"`). Kept exported for existing unit coverage;
 * setup now uses {@link parsePluginList} (`opencode plugin list`) plus
 * direct config-file truth and never invokes `debug info`.
 */
declare function parsePluginSpecifiers(output: string): {
    recognized: boolean;
    specifiers: string[];
};
export declare function setup(binaryUrl: string, executor?: Executor, depsSyncFn?: typeof depsSync, options?: SetupOptions): Promise<LifecycleResult>;
export declare function update(binaryUrl: string, executor?: Executor): Promise<LifecycleResult>;
export { resolveCheckout, parsePluginSpecifiers, parsePluginList, run as runInCheckout };
//# sourceMappingURL=lifecycle.d.ts.map