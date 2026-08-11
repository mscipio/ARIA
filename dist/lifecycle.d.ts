import { depsSync, type Executor } from "./deps.js";
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
export declare function setup(binaryUrl: string, executor?: Executor, depsSyncFn?: typeof depsSync): Promise<LifecycleResult>;
export declare function update(binaryUrl: string, executor?: Executor): Promise<LifecycleResult>;
export { resolveCheckout, parsePluginSpecifiers, run as runInCheckout };
//# sourceMappingURL=lifecycle.d.ts.map