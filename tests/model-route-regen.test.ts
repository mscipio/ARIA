import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { configureModels, type ModelDiscovery } from "../src/model-config.js";
import { setup } from "../src/lifecycle.js";
import type { Executor } from "../src/deps.js";

// T003 ordering: after a successful route write, managed agents are
// regenerated from freshly resolved routes in the same invocation.

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "aria-t003-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-t003-work-"));
  tempDirs.push(worktree);
  return worktree;
}

function globalAriaPath(home: string): string {
  return resolve(home, ".config", "opencode", "aria.json");
}

function agentsDirFor(home: string): string {
  return resolve(home, ".config", "opencode", "agents");
}

const DISCOVERY: ModelDiscovery = {
  models: [
    {
      id: "opencode-go/muse-spark-1.3-contributor",
      providerID: "opencode-go",
      modelID: "muse-spark-1.3-contributor",
      name: "Spark",
      variants: ["xhigh", "high"],
    },
    {
      id: "openai/gpt-6-luna",
      providerID: "openai",
      modelID: "gpt-6-luna",
      name: "Luna",
      variants: ["xhigh"],
    },
  ],
};

function scriptedInput(answers: string[]) {
  let index = 0;
  return async (_prompt: string) => answers[index++] ?? "";
}

describe("T003 model-route ordering", () => {
  it("regenerates managed agents from new routes in the same configure invocation", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // Unmanaged incumbent + unrelated file must survive.
    const agentsDir = agentsDirFor(home);
    await mkdir(agentsDir, { recursive: true });
    await writeFile(resolve(agentsDir, "coder.md"), "user-owned coder agent\n");
    await writeFile(resolve(agentsDir, "my-helper.md"), "user content\n");

    // Change planner to spark/xhigh (diverges from the packaged luna/xhigh
    // default, so the write is a real route change).
    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERY,
      input: scriptedInput(["2", "planner", "opencode-go/muse-spark-1.3-contributor", "1"]),
      output: () => undefined,
      tty: true,
    });

    expect(result.status).toBe("configured");
    // Agent output matches the newly committed route without a second setup.
    const plannerAgent = await readFile(resolve(agentsDir, "planner.md"), "utf8");
    expect(plannerAgent).toContain('model: "opencode-go/muse-spark-1.3-contributor#xhigh"');
    // Unmanaged backup + unrelated preserved.
    const coderBackup = await readFile(resolve(agentsDir, "coder.md"), "utf8");
    expect(coderBackup).toContain("muse-spark");
    expect(await readFile(resolve(agentsDir, "my-helper.md"), "utf8")).toBe("user content\n");
    // Global route file holds the new assignment.
    const written = JSON.parse(await readFile(globalAriaPath(home), "utf8")) as {
      roles?: Record<string, unknown>;
    };
    expect(written.roles?.planner).toEqual({ model: "opencode-go/muse-spark-1.3-contributor", variant: "xhigh" });
  });

  it("does not rewrite agents when the route write fails", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const agentsDir = agentsDirFor(home);
    // Seed a managed install first via a successful configure, then capture bytes.
    const first = await configureModels(worktree, {
      discovery: async () => DISCOVERY,
      input: scriptedInput(["2", "planner", "opencode-go/muse-spark-1.3-contributor", "1"]),
      output: () => undefined,
      tty: true,
    });
    expect(first.status).toBe("configured");
    const before = await readFile(resolve(agentsDir, "planner.md"), "utf8");

    // Discovery failure: no prompt, no write, agents untouched.
    const failed = await configureModels(worktree, {
      discovery: async () => {
        throw new Error("server down");
      },
      input: scriptedInput([]),
      output: () => undefined,
      tty: true,
    });
    expect(failed.status).toBe("failed");
    expect(await readFile(resolve(agentsDir, "planner.md"), "utf8")).toBe(before);
  });

  it("setup --configure regenerates agents from new routes in the same invocation", async () => {
    const home = await makeHome();
    const checkoutRoot = await mkdtemp(resolve(tmpdir(), "aria-t003-checkout-"));
    tempDirs.push(checkoutRoot);
    const binDir = resolve(checkoutRoot, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "aria.mjs"), "#!/usr/bin/env node\n");
    const binaryUrl = pathToFileURL(resolve(binDir, "aria.mjs")).href;

    const filesRoot = await mkdtemp(resolve(tmpdir(), "aria-t003-files-"));
    tempDirs.push(filesRoot);
    const agentsDir = resolve(filesRoot, "agents");
    const globalConfigPath = resolve(filesRoot, "opencode.json");

    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key.startsWith("opencode plugin add")) return { stdout: "plugin registered", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };
    const okSync = async () => ({
      ok: true as const,
      engram: { action: "ok" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    });

    // Mock configure writes a new global route (HOME-based aria.json, the
    // same file configureModels + resolveSetupAriaConfig share) and reports
    // configured. Lifecycle must regenerate agentsDir from that fresh read.
    // Spark/xhigh diverges from the packaged planner luna/xhigh default, so
    // the agent assertion proves the fresh route was used.
    const configureModelsFn = async () => {
      const dir = resolve(home, ".config", "opencode");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "aria.json"),
        `${JSON.stringify({ roles: { planner: { model: "opencode-go/muse-spark-1.3-contributor", variant: "xhigh" } } }, null, 2)}\n`,
      );
      return { status: "configured" as const, message: "mock configured" };
    };

    const result = await setup(binaryUrl, executor, okSync, {
      configure: true,
      worktree: await makeWorktree(),
      configureModelsFn,
      files: { globalConfigPath, agentsDir, skillsRoot: resolve(filesRoot, "skills") },
    });

    expect(result.ok).toBe(true);
    expect(result.setup?.model?.status).toBe("configured");
    const plannerAgent = await readFile(resolve(agentsDir, "planner.md"), "utf8");
    expect(plannerAgent).toContain('model: "opencode-go/muse-spark-1.3-contributor#xhigh"');
  });

  it("setup --configure leaves agents untouched when configuration fails", async () => {
    const home = await makeHome();
    void home;
    const checkoutRoot = await mkdtemp(resolve(tmpdir(), "aria-t003-checkout2-"));
    tempDirs.push(checkoutRoot);
    const binDir = resolve(checkoutRoot, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "aria.mjs"), "#!/usr/bin/env node\n");
    const binaryUrl = pathToFileURL(resolve(binDir, "aria.mjs")).href;

    const filesRoot = await mkdtemp(resolve(tmpdir(), "aria-t003-files2-"));
    tempDirs.push(filesRoot);
    const agentsDir = resolve(filesRoot, "agents");
    const globalConfigPath = resolve(filesRoot, "opencode.json");

    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key.startsWith("opencode plugin add")) return { stdout: "plugin registered", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };
    const okSync = async () => ({
      ok: true as const,
      engram: { action: "ok" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    });

    // Baseline setup without configure to capture pre-configure agent bytes.
    const baseline = await setup(binaryUrl, executor, okSync, {
      worktree: await makeWorktree(),
      files: { globalConfigPath, agentsDir, skillsRoot: resolve(filesRoot, "skills") },
    });
    expect(baseline.ok).toBe(true);
    const before = await readFile(resolve(agentsDir, "planner.md"), "utf8");

    const failingConfigure = async () => ({
      status: "failed" as const,
      message: "mock failed",
      error: "discovery down",
    });
    const result = await setup(binaryUrl, executor, okSync, {
      configure: true,
      worktree: await makeWorktree(),
      configureModelsFn: failingConfigure,
      files: { globalConfigPath, agentsDir, skillsRoot: resolve(filesRoot, "skills") },
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("model_configuration");
    expect(await readFile(resolve(agentsDir, "planner.md"), "utf8")).toBe(before);
  });
});
