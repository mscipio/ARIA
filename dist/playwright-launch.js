import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExecutor } from "./deps.js";
import { PLAYWRIGHT_MCP_VERSION, playwrightState, runPinnedPlaywrightMcp } from "./playwright.js";
import { createScratchRunDir } from "./scratch.js";
export async function resolvePlaywrightRuntimeOutput(worktree) {
    if (!worktree.trim())
        throw new Error("Playwright MCP requires an explicit OpenCode project working directory");
    return createScratchRunDir(worktree, "playwright-mcp");
}
/**
 * Direct stdio launcher for Playwright MCP. It does not inspect plan/task
 * state; automatic MCP output goes to a unique canonical scratch runtime
 * directory. Persistent task captures are supplied explicit task-scratch
 * paths by the Visualizer workflow. This is a launcher, not a protocol proxy.
 */
export async function launchPlaywrightMcp() {
    // `mcp.servers.playwright.cwd: "."` pins this process to OpenCode's current
    // project context; the scratch helper validates it before routing output.
    // There is no cwd fallback or plan/task dependency.
    const worktree = process.cwd();
    const outputDir = await resolvePlaywrightRuntimeOutput(worktree);
    const state = await playwrightState(defaultExecutor);
    if (state.version !== PLAYWRIGHT_MCP_VERSION || !state.browser || !state.executable) {
        throw new Error(`Pinned Playwright MCP/Chromium is not statically ready: ${state.issue ?? "package/browser missing or library inspection unavailable"}`);
    }
    // Directly executes the pinned local CLI. No npm/npx invocation or
    // launch-time downloads occur; automatic MCP outputs stay under scratch.
    return runPinnedPlaywrightMcp(state.executable, outputDir, worktree);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    launchPlaywrightMcp().then((code) => { process.exitCode = code; }, (error) => {
        console.error(`Playwright MCP launch refused: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=playwright-launch.js.map