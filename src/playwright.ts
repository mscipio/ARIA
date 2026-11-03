import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openCodeGlobalDir } from "./paths.js";
import type { Executor } from "./deps.js";
import { stripJsoncComments } from "./deps.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.83";
export const PLAYWRIGHT_MCP_NAME = "playwright";
const packageName = "@playwright/mcp";
const root = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "aria", "playwright-mcp");
const marker = join(root, "aria-managed.json");
const browsers = join(root, "browsers");
const cli = join(root, "node_modules", "@playwright", "mcp", "cli.js");
const packageJson = join(root, "node_modules", "@playwright", "mcp", "package.json");
const browserRegistry = join(root, "node_modules", "playwright-core", "browsers.json");
const launchAdapter = join(dirname(fileURLToPath(import.meta.url)), "playwright-launch.js");

// The pinned MCP is launched directly from this persistent, user-owned prefix;
// the OpenCode command never invokes npm/npx and cannot download on launch.
// Its isolated browser mode discards profile state, but upstream temporary
// profile/output routing is not a task-scratch sandbox and is disclosed in
// the browser-validation guidance.

type State = { version: string | null; managed: boolean; browser: boolean; executable: string | null; issue?: string };

async function findChromiumExecutable(): Promise<string | null> {
  try {
    const registry = JSON.parse(await readFile(browserRegistry, "utf8")) as { browsers?: Array<{ name?: string; revision?: string }> };
    const revisions = (registry.browsers ?? [])
      .filter((browser) => browser.name === "chromium" || browser.name === "chromium-headless-shell")
      .map((browser) => `${browser.name === "chromium-headless-shell" ? "chromium_headless_shell" : "chromium"}-${browser.revision}`);
    const roots = (await readdir(browsers, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && revisions.includes(entry.name))
      .map((entry) => join(browsers, entry.name));
    const executableNames = new Set(["chrome", "chrome.exe", "headless_shell", "chrome-headless-shell", "Chromium"]);
    const visit = async (directory: string, depth: number): Promise<string | null> => {
      if (depth > 8) return null;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = join(directory, entry.name);
        if (entry.isFile() && executableNames.has(entry.name)) {
          try {
            await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
            return candidate;
          } catch { /* not executable */ }
        }
        if (entry.isDirectory()) {
          const found = await visit(candidate, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    for (const browserRoot of roots) {
      const executable = await visit(browserRoot, 0);
      if (executable) return executable;
    }
  } catch { /* package registry or matching browser cache is unavailable */ }
  return null;
}

async function readState(executor: Executor): Promise<State> {
  let managed = false;
  let version: string | null = null;
  let issue: string | undefined;
  try {
    const ownership = JSON.parse(await readFile(marker, "utf8"));
    managed = ownership.owner === "aria" && ownership.package === packageName;
  } catch { /* unmarked installs are observed, never assumed managed */ }
  try {
    const manifest = JSON.parse(await readFile(packageJson, "utf8"));
    version = manifest.version ?? null;
  } catch { /* package absent or unreadable */ }
  let executable: string | null = null;
  let browser = false;
  if (version === PLAYWRIGHT_MCP_VERSION) {
    try {
      executable = await findChromiumExecutable();
      if (executable) {
        browser = true;
        if (process.platform === "linux") {
          const libraries = await executor("ldd", [executable]);
          const report = `${libraries.stdout}\n${libraries.stderr}`.trim();
          if (!libraries.stdout.trim() || libraries.stderr.trim() || /not a dynamic executable/i.test(report)) throw new Error(`ldd did not verify Chromium shared libraries${report ? `: ${report}` : ""}`);
          const missing = report.split(/\r?\n/).filter((line) => line.includes("not found"));
          if (missing.length) {
            browser = false;
            issue = `Chromium executable exists but shared libraries are missing: ${missing.join("; ")}`;
          }
        }
      }
    } catch (error) {
      browser = false;
      issue = `static Chromium executable/library inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (version && version !== PLAYWRIGHT_MCP_VERSION) issue = `installed ${packageName}@${version}, expected ${PLAYWRIGHT_MCP_VERSION}`;
  else if (version === PLAYWRIGHT_MCP_VERSION && !browser && !issue) issue = "pinned MCP package is installed but its matching Chromium executable is missing";
  return { version, managed, browser, executable, issue };
}

async function installBrowser(executor: Executor): Promise<{ ok: boolean; detail: string }> {
  try {
    try {
      const info = await lstat(browsers);
      if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, detail: `browser cache path is not a safe directory: ${browsers}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(browsers, { recursive: true });
    const result = await executor("node", [cli, "install-browser", "chromium"], {
      cwd: root,
      env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
      timeoutMs: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const state = await readState(executor);
    return state.browser
      ? { ok: true, detail: `matching Chromium provisioned at ${browsers}` }
      : { ok: false, detail: state.issue ?? `browser install completed but executable is not present${result.stderr ? `: ${result.stderr}` : ""}` };
  } catch (error) {
    return { ok: false, detail: `Chromium provisioning failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function browserCacheIsAbsentOrEmpty(): Promise<boolean> {
  try {
    const info = await lstat(browsers);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    return (await readdir(browsers)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function ensureInstall(executor: Executor, upgrade: boolean): Promise<{ ok: boolean; mutated: boolean; detail: string }> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, mutated: false, detail: `Playwright install root is not a safe directory: ${root}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, mutated: false, detail: `cannot inspect Playwright install root: ${String(error)}` };
  }
  const state = await readState(executor);
  if (state.version === PLAYWRIGHT_MCP_VERSION) {
    if (!state.browser) {
      if (!state.managed && !(await browserCacheIsAbsentOrEmpty())) {
        return { ok: false, mutated: false, detail: "matching browser is not ready and the existing browser cache is unowned/nonempty; preserving it without replacement" };
      }
      if (upgrade && !state.managed) return { ok: false, mutated: false, detail: "compatible package found but browser cache is incomplete and package ownership is not ARIA-managed; upgrade is report-only" };
      const browser = await installBrowser(executor);
      return { ...browser, mutated: true };
    }
    return { ok: true, mutated: false, detail: `reusing compatible ${packageName}@${PLAYWRIGHT_MCP_VERSION} and matching Chromium` };
  }
  if (state.version && !upgrade) return { ok: false, mutated: false, detail: `${state.issue}; setup leaves the existing package untouched` };
  if (state.version && upgrade && !state.managed) {
    return { ok: false, mutated: false, detail: `${state.issue}; ownership is not positively ARIA-managed, so upgrade is report-only` };
  }
  if (!state.version) {
    if (!state.managed) {
      try {
        const entries = await readdir(root);
        if (entries.length > 0) return { ok: false, mutated: false, detail: `${root} contains unrecognized files; refusing to overwrite ambiguous contents` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, mutated: false, detail: `cannot inspect ${root}: ${String(error)}` };
      }
    }
  }
  try {
    await mkdir(root, { recursive: true });
    await writeFile(marker, JSON.stringify({ owner: "aria", package: packageName, version: PLAYWRIGHT_MCP_VERSION }, null, 2) + "\n", { flag: state.managed ? "w" : "wx" });
    const installed = await executor("npm", ["install", "--prefix", root, "--no-save", "--no-audit", "--no-fund", `${packageName}@${PLAYWRIGHT_MCP_VERSION}`], {
      timeoutMs: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const verified = await readState(executor);
    if (verified.version !== PLAYWRIGHT_MCP_VERSION) return { ok: false, mutated: true, detail: `npm returned without installing the exact pin${installed.stderr ? `: ${installed.stderr}` : ""}` };
    const browser = await installBrowser(executor);
    return { ok: browser.ok, mutated: true, detail: browser.ok ? `installed ${packageName}@${PLAYWRIGHT_MCP_VERSION}; ${browser.detail}` : `${packageName}@${PLAYWRIGHT_MCP_VERSION} installed, but ${browser.detail}` };
  } catch (error) {
    return { ok: false, mutated: true, detail: `pinned ${packageName} setup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function setupPlaywright(executor: Executor): Promise<{ ok: boolean; mutated: boolean; detail: string }> {
  return ensureInstall(executor, false);
}

export async function upgradePlaywright(executor: Executor): Promise<{ ok: boolean; mutated: boolean; detail: string }> {
  const state = await readState(executor);
  if (!state.version) return { ok: false, mutated: false, detail: "Playwright MCP is not installed; missing installs belong to aria setup" };
  if (!state.managed && state.version === PLAYWRIGHT_MCP_VERSION && !state.browser) {
    return { ok: false, mutated: false, detail: "compatible Playwright MCP found but matching browser is missing and package ownership is not ARIA-managed; upgrade is report-only" };
  }
  if (!state.managed && state.version !== PLAYWRIGHT_MCP_VERSION) {
    return { ok: false, mutated: false, detail: `${state.issue}; install ownership is not positively ARIA-managed, so upgrade is report-only` };
  }
  return ensureInstall(executor, true);
}

export async function playwrightState(executor: Executor): Promise<State> {
  return readState(executor);
}

export function playwrightMcpArgs(executable: string, outputDir: string): string[] {
  return ["--headless", "--isolated", "--executable-path", executable, "--output-dir", outputDir];
}

export function runPinnedPlaywrightMcp(executable: string, outputDir: string, worktree: string): Promise<number> {
  const child = spawn(process.execPath, [cli, ...playwrightMcpArgs(executable, outputDir)], {
    cwd: worktree,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdio: "inherit",
  });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function inspectPlaywrightConfig(configDir?: string): Promise<{ registered: boolean; detail: string }> {
  const base = openCodeGlobalDir(configDir);
  const json = join(base, "opencode.json");
  const jsonc = join(base, "opencode.jsonc");
  const [hasJson, hasJsonc] = await Promise.all([access(json).then(() => true, () => false), access(jsonc).then(() => true, () => false)]);
  if (hasJson && hasJsonc) return { registered: false, detail: "global OpenCode JSON/JSONC files are ambiguous" };
  const file = hasJson ? json : hasJsonc ? jsonc : null;
  if (!file) return { registered: false, detail: "not registered" };
  try {
    const config = JSON.parse(stripJsoncComments(await readFile(file, "utf8")));
    const server = config?.mcp?.servers?.[PLAYWRIGHT_MCP_NAME];
    if (!server) return { registered: false, detail: "not registered" };
    if (server.type !== "local" || server.disabled === true || server.enabled !== undefined || server.codemode !== false || !Array.isArray(server.command) || server.command[0] !== "node" || server.command[1] !== launchAdapter || server.cwd !== ".") {
      return { registered: false, detail: "a noncanonical or disabled Playwright server entry exists" };
    }
    return { registered: true, detail: "auto-enabled local V2 MCP entry verified" };
  } catch {
    return { registered: false, detail: `${file} is unreadable or invalid` };
  }
}

export async function syncPlaywrightConfig(configDir?: string): Promise<{ action: string; error?: string }> {
  const base = openCodeGlobalDir(configDir);
  const json = join(base, "opencode.json");
  const jsonc = join(base, "opencode.jsonc");
  let file: string;
  try {
    const [hasJson, hasJsonc] = await Promise.all([access(json).then(() => true, () => false), access(jsonc).then(() => true, () => false)]);
    if (hasJson && hasJsonc) return { action: "conflicting", error: `both ${json} and ${jsonc} exist; refusing to guess which settings to modify` };
    file = hasJson ? json : hasJsonc ? jsonc : json;
    if (hasJson || hasJsonc) {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) return { action: "conflicting", error: `${file} is not a regular config file; no config changed` };
    }
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(stripJsoncComments(await readFile(file, "utf8"))) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { action: "conflicting", error: `${file} is unreadable or invalid; no config changed` };
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return { action: "conflicting", error: `${file} has a non-object root; no config changed` };
    const mcp = config.mcp === undefined ? {} : config.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return { action: "conflicting", error: `${file} mcp entry is not an object; no config changed` };
    const servers = (mcp as Record<string, unknown>).servers === undefined ? {} : (mcp as Record<string, unknown>).servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { action: "conflicting", error: `${file} mcp.servers entry is not an object; no config changed` };
    const current = (servers as Record<string, unknown>)[PLAYWRIGHT_MCP_NAME];
  const executable = await findChromiumExecutable();
  if (!executable) return { action: "conflicting", error: "matching Chromium executable is unavailable; refusing to register an MCP server with an unresolved browser" };
  const desired = { type: "local", command: ["node", launchAdapter], cwd: ".", disabled: false, codemode: false };
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(desired)) return { action: "conflicting", error: `${file} already defines a different playwright server; preserving it without overwrite` };
    config.mcp = { ...(mcp as Record<string, unknown>), servers: { ...(servers as Record<string, unknown>), [PLAYWRIGHT_MCP_NAME]: desired } };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { action: current === undefined ? "configured" : "already-configured" };
  } catch (error) {
    return { action: "failed", error: `Playwright MCP config sync failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
