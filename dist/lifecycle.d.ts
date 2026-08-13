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
    /** Outcome of the optional model-configuration phase; absent unless requested. */
    model?: ModelConfigurationResult;
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
 * Parse the `opencode debug info` output to find registered plugin URIs.
 * Returns the list of plugin specifier strings found in the plugins section
 * and whether a plugins section was recognized at all.
 */
declare function parsePluginSpecifiers(output: string): {
    recognized: boolean;
    specifiers: string[];
};
export declare function setup(binaryUrl: string, executor?: Executor, depsSyncFn?: typeof depsSync, options?: SetupOptions): Promise<LifecycleResult>;
export declare function update(binaryUrl: string, executor?: Executor): Promise<LifecycleResult>;
export { resolveCheckout, parsePluginSpecifiers, run as runInCheckout };
//# sourceMappingURL=lifecycle.d.ts.map