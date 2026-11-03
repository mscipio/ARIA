import type { Executor } from "./deps.js";
export declare const PLAYWRIGHT_MCP_VERSION = "0.0.83";
export declare const PLAYWRIGHT_MCP_NAME = "playwright";
type State = {
    version: string | null;
    managed: boolean;
    browser: boolean;
    executable: string | null;
    issue?: string;
};
export declare function setupPlaywright(executor: Executor): Promise<{
    ok: boolean;
    mutated: boolean;
    detail: string;
}>;
export declare function upgradePlaywright(executor: Executor): Promise<{
    ok: boolean;
    mutated: boolean;
    detail: string;
}>;
export declare function playwrightState(executor: Executor): Promise<State>;
export declare function playwrightMcpArgs(executable: string, outputDir: string): string[];
export declare function runPinnedPlaywrightMcp(executable: string, outputDir: string, worktree: string): Promise<number>;
export declare function inspectPlaywrightConfig(configDir?: string): Promise<{
    registered: boolean;
    detail: string;
}>;
export declare function syncPlaywrightConfig(configDir?: string): Promise<{
    action: string;
    error?: string;
}>;
export {};
//# sourceMappingURL=playwright.d.ts.map