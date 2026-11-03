export declare function resolvePlaywrightRuntimeOutput(worktree: string): Promise<string>;
/**
 * Direct stdio launcher for Playwright MCP. It does not inspect plan/task
 * state; automatic MCP output goes to a unique canonical scratch unplanned
 * directory. Persistent task captures are supplied explicit task-scratch
 * paths by the Visualizer workflow. This is a launcher, not a protocol proxy.
 */
export declare function launchPlaywrightMcp(): Promise<number>;
//# sourceMappingURL=playwright-launch.d.ts.map