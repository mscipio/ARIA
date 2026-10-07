import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultAgentsDir } from "../src/agents.js";
import { depsSync, detectContext7, doctor, type Executor } from "../src/deps.js";
import { setup } from "../src/lifecycle.js";
import { openCodeGlobalDir } from "../src/paths.js";
import { defaultGlobalConfigPath } from "../src/setup-config.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Isolated env: empty HOME + fresh XDG root; no production fallback. */
async function isolateXdg() {
  const fakeHome = await mkdtemp(resolve(tmpdir(), "t003-home-"));
  const xdgRoot = await mkdtemp(resolve(tmpdir(), "t003-xdg-"));
  tempDirs.push(fakeHome, xdgRoot);
  process.env.HOME = fakeHome;
  process.env.XDG_CONFIG_HOME = xdgRoot;
  return { fakeHome, xdgRoot, xdgGlobal: join(xdgRoot, "opencode") };
}

function context7Config(variant: "servers" | "legacy" = "servers"): Record<string, unknown> {
  const entry = { type: "remote", url: "https://mcp.context7.com/mcp" };
  return variant === "servers"
    ? { mcp: { servers: { context7: entry } } }
    : { mcp: { context7: entry } };
}

async function writeGlobalConfig(dir: string, config: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

function healthyExecutor(): Executor {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "opencode --version") return { stdout: "2.0.23", stderr: "" };
    if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
    if (key === "codegraph --version") return { stdout: "1.3.1", stderr: "" };
    if (key === "opencode mcp list") {
      return {
        stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"),
        stderr: "",
      };
    }
    throw new Error(`Unexpected command: ${key}`);
  };
}

async function makeFixtureCheckout(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "t003-lifecycle-"));
  tempDirs.push(root);
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
  return root;
}

describe("T003 effective root: Context7 detect/sync/doctor share one root", () => {
  it("isolated-only Context7 is detected via explicit dir and env defaults", async () => {
    const { xdgGlobal } = await isolateXdg();
    await writeGlobalConfig(xdgGlobal, context7Config());

    const executor = healthyExecutor();
    // Explicit injection observes the isolated root.
    expect(await detectContext7(executor, xdgGlobal)).toEqual({ configured: true, connected: true });
    expect((await doctor(executor, xdgGlobal)).context7.configured).toBe(true);
    // Env defaults agree (same effective root via XDG), proving setup+sync+doctor share it.
    expect(openCodeGlobalDir()).toBe(xdgGlobal);
    expect((await detectContext7(executor)).configured).toBe(true);
    expect((await doctor(executor)).context7.configured).toBe(true);
    // Shared-helper defaults coincide.
    expect(defaultGlobalConfigPath()).toBe(join(xdgGlobal, "opencode.json"));
    expect(defaultAgentsDir()).toBe(join(xdgGlobal, "agents"));
  });

  it("REGRESSION production-has + isolated-absent reports absent and sync targets isolated (no false inherit)", async () => {
    const { xdgGlobal } = await isolateXdg();
    // Isolated root is absent (empty mcp, no Context7).
    await writeGlobalConfig(xdgGlobal, { mcp: {} });
    // Simulated production root elsewhere HAS Context7 (never referenced by env).
    const prodRoot = await mkdtemp(resolve(tmpdir(), "t003-prod-"));
    tempDirs.push(prodRoot);
    const prodGlobal = join(prodRoot, "opencode");
    await writeGlobalConfig(prodGlobal, context7Config());

    const executor = healthyExecutor();
    // Isolated checks report absent despite production having Context7.
    expect((await detectContext7(executor, xdgGlobal)).configured).toBe(false);
    expect((await doctor(executor, xdgGlobal)).context7.configured).toBe(false);
    expect((await detectContext7(executor)).configured).toBe(false);
    // Production dir, when named explicitly, does have it (contrast, not inheritance).
    expect((await detectContext7(executor, prodGlobal)).configured).toBe(true);

    // Sync against the isolated root writes the isolated destination
    // file-based (no false inherit from production, no shell).
    const calls: string[] = [];
    const syncExecutor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which") return { stdout: "/tmp/fake-engram", stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: "/tmp/fake-cellar", stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "2.0.23", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
        return { stdout: "engram connected\ncontext7 connected\ncodegraph connected", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const result = await depsSync(syncExecutor, xdgGlobal);
    expect(result.context7.action).toBe("configured");
    expect(calls.some((call) => call.includes("mcp add"))).toBe(false);
    // Actual destination holds Context7; production contrast stays intact.
    expect((await detectContext7(syncExecutor, xdgGlobal)).configured).toBe(true);
    expect((await detectContext7(syncExecutor, prodGlobal)).configured).toBe(true);
  });

  it("explicit injection is authoritative over XDG env", async () => {
    const { xdgGlobal } = await isolateXdg();
    await writeGlobalConfig(xdgGlobal, { mcp: {} });
    const explicit = await mkdtemp(resolve(tmpdir(), "t003-explicit-"));
    tempDirs.push(explicit);
    await writeGlobalConfig(explicit, context7Config());

    const executor = healthyExecutor();
    expect((await detectContext7(executor, explicit)).configured).toBe(true);
    expect((await doctor(executor, explicit)).context7.configured).toBe(true);
    // Env-derived root stays absent: explicit wins, no blending.
    expect((await detectContext7(executor)).configured).toBe(false);
    expect((await doctor(executor)).context7.configured).toBe(false);
  });

  it("REGRESSION explicit write wins over env: explicit updated, env unchanged (jsonc + unrelated preserved)", async () => {
    const { xdgGlobal } = await isolateXdg();
    await writeGlobalConfig(xdgGlobal, { mcp: {} });
    const explicit = await mkdtemp(resolve(tmpdir(), "t003-explicit-write-"));
    tempDirs.push(explicit);
    // Explicit root uses the existing .jsonc format with unrelated config.
    await mkdir(explicit, { recursive: true });
    await writeFile(
      join(explicit, "opencode.jsonc"),
      JSON.stringify({
        mcp: { servers: { engram: { type: "local", command: ["engram", "mcp"] } } },
        unrelated: true,
      }),
    );

    const calls: string[] = [];
    const syncExecutor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which") return { stdout: "/tmp/fake-engram", stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: "/tmp/fake-cellar", stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "2.0.23", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
        return { stdout: "engram connected\ncontext7 connected\ncodegraph connected", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(syncExecutor, explicit);
    expect(result.context7.action).toBe("configured");
    expect(calls.some((call) => call.includes("mcp add"))).toBe(false);
    // Explicit destination updated in place (.jsonc preserved, no .json created).
    const explicitRaw = await readFile(join(explicit, "opencode.jsonc"), "utf8");
    const explicitConfig = JSON.parse(explicitRaw) as {
      mcp?: { servers?: Record<string, unknown> };
      unrelated?: unknown;
    };
    expect(explicitConfig.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
    expect(explicitConfig.mcp?.servers?.engram).toEqual({ type: "local", command: ["engram", "mcp"] });
    expect(explicitConfig.unrelated).toBe(true);
    // Env destination unchanged (still absent).
    expect((await detectContext7(syncExecutor)).configured).toBe(false);
    const envRaw = await readFile(join(xdgGlobal, "opencode.json"), "utf8");
    expect(JSON.parse(envRaw)).toEqual({ mcp: {} });
  });

  it("setup forwards explicit globalConfigPath dirname into depsSyncFn", async () => {
    const checkout = await makeFixtureCheckout();
    const binaryUrl = pathToFileURL(join(checkout, "bin", "aria.mjs")).href;
    const isolated = await mkdtemp(resolve(tmpdir(), "t003-setup-"));
    tempDirs.push(isolated);
    const globalConfigPath = join(isolated, "opencode.json");
    const agentsDir = join(isolated, "agents");

    let seenDir: string | undefined;
    let seenExecutor = false;
    const depsSyncFn = (async (executor: Executor, configDir?: string) => {
      seenExecutor = true;
      seenDir = configDir;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    }) as typeof depsSync;

    const executor: Executor = async (command, args) => {
      if (command === "opencode" && args.join(" ") === "plugin list") return { stdout: "No plugins found", stderr: "" };
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") return { stdout: "ok", stderr: "" };
      throw new Error(`Unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await setup(binaryUrl, executor, depsSyncFn, {
      files: { globalConfigPath, agentsDir },
    });
    expect(result.ok).toBe(true);
    expect(seenExecutor).toBe(true);
    expect(seenDir).toBe(dirname(globalConfigPath));
    expect(seenDir).toBe(isolated);
  });

  it("setup forwards env-derived dir by default (no files override)", async () => {
    const { xdgGlobal } = await isolateXdg();
    const checkout = await makeFixtureCheckout();
    const binaryUrl = pathToFileURL(join(checkout, "bin", "aria.mjs")).href;

    let seenDir: string | undefined;
    const depsSyncFn = (async (_executor: Executor, configDir?: string) => {
      seenDir = configDir;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    }) as typeof depsSync;

    const executor: Executor = async (command, args) => {
      if (command === "opencode" && args.join(" ") === "plugin list") return { stdout: "No plugins found", stderr: "" };
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") return { stdout: "ok", stderr: "" };
      throw new Error(`Unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await setup(binaryUrl, executor, depsSyncFn, {});
    expect(result.ok).toBe(true);
    // Env defaults: dirname(defaultGlobalConfigPath()) === openCodeGlobalDir().
    expect(seenDir).toBe(xdgGlobal);
    expect(seenDir).toBe(openCodeGlobalDir());
    expect(seenDir).toBe(dirname(defaultGlobalConfigPath()));
    // Config phase wrote under the isolated root, not production HOME.
    const written = JSON.parse(await readFile(join(xdgGlobal, "opencode.json"), "utf8")) as {
      plugins?: unknown[];
    };
    expect(Array.isArray(written.plugins)).toBe(true);
  });
});
