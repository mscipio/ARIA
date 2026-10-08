import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installCodegraphIfMissing } from "../src/bootstrap.js";
import { ensureCodegraph } from "../src/codegraph.js";
import { depsSync, type Executor } from "../src/deps.js";
import { runSetupDependencies } from "../src/dependencies.js";
import { setup } from "../src/lifecycle.js";
import {
  buildUpgradeHandoff,
  checkUpgradeInventory,
  continueUpgradeInNewRelease,
  runUpgrade,
  type AriaAvailableTarget,
} from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T017 shared dependency lifecycle + setup wiring (seam-based, T019 sandbox).
//
// - `aria setup` invokes the shared adapters DIRECTLY (no handoff).
// - `aria upgrade` handoffs first ONLY when ARIA is outdated; after handoff
//   the target release runs the same lifecycle; already-current runs approved
//   dependencies directly with NO handoff (binding, one representative).
// - `deps sync` chases no versions (one representative: CodeGraph).
// - Ownership gates fail closed report-only; per-component validation rolls
//   back where feasible (one representative each).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp root");
  return root;
}

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await makeTempRoot("rdc-t017-");
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  assertNotCallerGlobalPath(configDir, "configDir");
  return { root, configDir };
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        entries.set(path, await readFile(path, "utf8"));
      } catch {
        await walk(path);
      }
    }
  }
  await walk(root);
  return entries;
}

async function expectByteIdentical(root: string, before: Map<string, string>): Promise<void> {
  const after = await snapshotTree(root);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
}

function stubExecutor(
  responses: Record<string, { stdout?: string; stderr?: string; error?: string }>,
  calls: string[] = [],
): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

async function makeFixtureCheckout(): Promise<{ checkout: string; binaryUrl: string }> {
  const root = await makeTempRoot("rdc-t017-setup-");
  const binDir = resolve(root, "checkout", "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(resolve(binDir, "aria.mjs"), "#!/usr/bin/env node\nconsole.log('ok');");
  const checkout = resolve(root, "checkout");
  return { checkout, binaryUrl: pathToFileURL(resolve(binDir, "aria.mjs")).href };
}

async function tempSetupFiles(): Promise<{ globalConfigPath: string; agentsDir: string; skillsRoot: string }> {
  const root = await makeTempRoot("rdc-t017-files-");
  const files = {
    globalConfigPath: resolve(root, "opencode.json"),
    agentsDir: resolve(root, "agents"),
    skillsRoot: resolve(root, "skills"),
  };
  assertNotCallerGlobalPath(files.globalConfigPath, "setup files.globalConfigPath");
  assertNotCallerGlobalPath(files.agentsDir, "setup files.agentsDir");
  return files;
}

const LS_REMOTE_SAMPLE = [
  "aaa111\trefs/tags/v1.0.6",
  "bbb222\trefs/tags/v1.0.7",
  "bbb222\trefs/tags/v1.0.7^{}",
  "ccc333\trefs/heads/main",
  "",
].join("\n");

const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

const HEALTHY_MCP_LIST = ["MCP Servers", "engram connected", "context7 connected", "codegraph connected"].join("\n");

function pluginListEmpty(): string {
  return "No plugins found";
}

describe("T017 setup invokes shared adapters directly with no handoff", () => {
  it("runs the dependencies seam on the effective config dir and never performs a self-upgrade handoff", async () => {
    const { checkout, binaryUrl } = await makeFixtureCheckout();
    const files = await tempSetupFiles();
    const seen: Array<{ configDir: string }> = [];
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "opencode plugin list": { stdout: pluginListEmpty() },
        [`opencode plugin add ${checkout}`]: { stdout: "plugin registered" },
      },
      calls,
    );
    const mockDepsSync = async () => ({
      ok: true,
      engram: { action: "ok" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    });
    const result = await setup(binaryUrl, executor, mockDepsSync, {
      files,
      dependenciesFn: async (exec, configDir) => {
        seen.push({ configDir });
        // Direct adapter invocation would run here; record the seam call and
        // report success without touching the network (representative wiring
        // proof — adapter internals are covered by T012–T014/T016 suites).
        void exec;
        return { ok: true, outcomes: [{ component: "engram", status: "completed", detail: "stubbed", mutated: false }], report: "stubbed" };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.configDir).toBe(resolve(files.globalConfigPath, ".."));
    expect(result.setup?.dependencies?.ok).toBe(true);
    // No handoff exists on the setup path (setup never self-replaces).
    expect("handoff" in result).toBe(false);
    expect(calls.some((call) => call.startsWith("git ls-remote"))).toBe(false);
  });
});

describe("T017 upgrade handoff ordering and already-current binding", () => {
  it("outdated ARIA takes the handoff without running dependencies in the old release", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "git ls-remote https://github.com/mscipio/ARIA.git": { stdout: LS_REMOTE_SAMPLE },
        "opencode plugin list": { stdout: pluginListEmpty() },
        "opencode mcp list": { stdout: HEALTHY_MCP_LIST },
        "engram version": { error: "engram not found" },
        "codegraph --version": { error: "codegraph not found" },
        "opencode --version": { stdout: "opencode 2.0.23" },
      },
      calls,
    );
    let dependenciesCalled = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: async () => ({ ok: true, detail: "replaced", handoffNote: "new owns remainder" }),
      dependenciesFn: async () => {
        dependenciesCalled++;
        throw new Error("dependencies must not run pre-handoff");
      },
    });
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(dependenciesCalled).toBe(0);
    expect(result.handoff?.target.spec).toBe(TARGET_107.spec);
    expect("dependencies" in result && result.dependencies !== undefined).toBe(false);
  });

  it("already-current ARIA runs approved dependencies directly with NO handoff (binding, one representative)", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "git ls-remote https://github.com/mscipio/ARIA.git": { stdout: LS_REMOTE_SAMPLE },
        "opencode plugin list": { stdout: pluginListEmpty() },
        "opencode mcp list": { stdout: HEALTHY_MCP_LIST },
        "engram version": { error: "engram not found" },
        "codegraph --version": { error: "codegraph not found" },
        "opencode --version": { stdout: "opencode 2.0.23" },
      },
      calls,
    );
    let selfUpgradeCalled = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.7",
      approval: { yes: true },
      selfUpgradeFn: async () => {
        selfUpgradeCalled++;
        return { ok: true, detail: "must not run" };
      },
      dependenciesFn: async () => ({
        ok: true,
        outcomes: [{ component: "quota", status: "completed", detail: "already current", mutated: false }],
        report: "stubbed dependencies completed",
      }),
    });
    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(true);
    expect(selfUpgradeCalled).toBe(0);
    expect(result.handoff).toBeUndefined();
    expect(result.selfUpgrade).toBeUndefined();
    expect(result.dependencies?.outcomes).toHaveLength(1);
    expect(result.dependencies?.outcomes[0]?.component).toBe("quota");
  });

  it("post-handoff continuation runs the shared lifecycle components with per-component states", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "git ls-remote https://github.com/mscipio/ARIA.git": { stdout: LS_REMOTE_SAMPLE },
        "opencode plugin list": { stdout: pluginListEmpty() },
        "opencode mcp list": { stdout: HEALTHY_MCP_LIST },
        "engram version": { error: "engram not found" },
        "codegraph --version": { error: "codegraph not found" },
        "opencode --version": { stdout: "opencode 2.0.23" },
      },
      calls,
    );
    const before = await checkUpgradeInventory(executor, { configDir, currentVersion: "1.0.6" });
    const handoff = buildUpgradeHandoff(TARGET_107, before);
    const result = await continueUpgradeInNewRelease(handoff, TARGET_107, before.components.map((row) => row.component), {
      components: {
        engram: async () => ({ component: "engram", status: "completed", detail: "engram done", mutated: true }),
        context7: async () => ({ component: "context7", status: "completed", detail: "context7 done", mutated: false }),
        codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "report-only", mutated: false }),
        zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "report-only", mutated: false }),
        quota: async () => ({ component: "quota", status: "completed", detail: "quota done", mutated: false }),
      },
      normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
      regenFn: async () => ({ ok: true, detail: "no regen", mutated: false }),
      depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: false }),
      doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
    });
    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    expect(result.report).toContain("Before:");
    expect(result.report).toContain("After:");
  });
});

describe("T017 ownership gate (one representative)", () => {
  it("dual-file ambiguity fails closed report-only with zero mutation and byte-identical files", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));
    await writeFile(resolve(configDir, "opencode.jsonc"), JSON.stringify({ mcp: {} }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "codegraph --version": { error: "codegraph not found" },
        "opencode mcp list": { stdout: HEALTHY_MCP_LIST },
      },
      calls,
    );
    const result = await ensureCodegraph(executor, { configDir });
    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
    await expectByteIdentical(root, before);
  });
});

describe("T017 per-component validation/rollback (one representative)", () => {
  it("failed post-install validation restores the config snapshot", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: [] }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    // No codegraph binary before or after install; npm discovery succeeds but
    // validation (binary + connected) fails → config snapshot restored.
    const executor = stubExecutor(
      {
        "codegraph --version": { error: "codegraph not found" },
        "npm view @colbymchenry/codegraph version": { stdout: "1.3.1" },
        "npm install -g @colbymchenry/codegraph@1.3.1": { stdout: "installed" },
        "opencode mcp list": { stdout: "MCP Servers\ncodegraph disconnected" },
      },
      calls,
    );
    const result = await installCodegraphIfMissing(executor, configDir);
    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    await expectByteIdentical(root, before);
  });
});

describe("T017 deps sync chases no versions (one representative)", () => {
  it("syncCodeGraph path observes without invoking npm version machinery", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: [] }));
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") throw new Error("not brew");
      if (command === "curl") throw new Error("network unavailable");
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.0", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: HEALTHY_MCP_LIST, stderr: "" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const result = await depsSync(executor, configDir);
    expect(calls.some((call) => call.startsWith("npm view") || call.startsWith("npm install"))).toBe(false);
    expect(result.codegraph.action).toBe("observed-not-managed");
  });
});

describe("T017 shared lifecycle orchestration runs all five adapters", () => {
  it("collects per-component outcomes on a clean isolated system without a version database", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor = stubExecutor(
      {
        "engram version": { error: "engram not found" },
        "which brew": { error: "brew not found" },
        "curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100": { error: "network unavailable" },
        "codegraph --version": { error: "codegraph not found" },
        "npm view @colbymchenry/codegraph version": { error: "network unavailable" },
        "zotpilot --version": { error: "zotpilot not found" },
        "opencode mcp list": { stdout: "MCP Servers\n", stderr: "" },
        "opencode plugin list": { stdout: pluginListEmpty(), stderr: "" },
        "npm view @slkiser/opencode-quota version": { error: "network unavailable" },
        "opencode --version": { stdout: "opencode 2.0.23", stderr: "" },
        "python3 -m pip show zotpilot": { error: "not installed" },
      },
      calls,
    );
    const result = await runSetupDependencies(executor, { configDir });
    expect(result.outcomes.map((outcome) => outcome.component).sort()).toEqual(
      ["codegraph", "context7", "engram", "quota", "zotpilot"].sort(),
    );
    expect(result.report).toContain("Dependency lifecycle report");
    // No version database: discovery ran through package-manager probes only.
    expect(calls.some((call) => call.includes("npm view") || call.includes("pip index") || call.includes("api.github.com"))).toBe(true);
  });
});
