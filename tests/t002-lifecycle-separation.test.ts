import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CODEGRAPH_MCP_COMMAND } from "../src/bootstrap.js";
import { runSetupDependencies } from "../src/dependencies.js";
import type { Executor } from "../src/deps.js";
import { runDoctor } from "../src/doctor.js";
import { setup } from "../src/lifecycle.js";
import { checkUpgradeInventory, runUpgrade, type AriaAvailableTarget } from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T002 lifecycle separation (focused command-level regressions).
//
// - setup installs a missing required dependency;
// - setup leaves an already-present older dependency untouched;
// - rerun setup on a complete installation is idempotent;
// - doctor performs no writes;
// - upgrade never upgrades Engram/Quota/CodeGraph/ZotPilot/third parties.
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
  const root = await makeTempRoot("rdc-t002-");
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

/** Mutating third-party commands that setup/doctor/upgrade must never run in T002. */
const THIRD_PARTY_MUTATIONS = [
  "brew install",
  "brew upgrade",
  "npm install -g",
  "python3 -m pip install",
  "opencode plugin add",
  "opencode plugin remove",
  "opencode plugin update",
  "opencode-quota update",
  "engram setup",
  "codegraph install",
  "codegraph upgrade",
  "zotpilot upgrade",
  "zotpilot register",
  "zotpilot install",
];

function hasThirdPartyMutation(calls: string[]): boolean {
  return calls.some((call) => THIRD_PARTY_MUTATIONS.some((mutation) => call.startsWith(mutation)));
}

const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

describe("T002 setup installs a missing required dependency", () => {
  it("installs a missing CodeGraph via the existing adapter with no version database", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: [] }));
    const calls: string[] = [];
    let installed = false;
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      // Engram/ZotPilot/Quota present-or-absent stubs: keep them skipped so
      // CodeGraph is the single representative installer.
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "codegraph --version") {
        if (!installed) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (key === "npm view @colbymchenry/codegraph version") return { stdout: "1.4.0\n", stderr: "" };
      if (key.startsWith("npm install -g")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (key === "zotpilot --version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await runSetupDependencies(executor, { configDir });

    const codegraph = result.outcomes.find((outcome) => outcome.component === "codegraph");
    expect(codegraph?.status).toBe("completed");
    expect(codegraph?.mutated).toBe(true);
    expect(calls).toContain("npm install -g @colbymchenry/codegraph@1.4.0");
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.codegraph).toEqual({ type: "local", command: CODEGRAPH_MCP_COMMAND });
  });
});

describe("T002 setup leaves an already-present older dependency untouched", () => {
  it("skips a present older Engram with zero mutating calls even when newer exists", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    // Seed the canonical Context7 remote entry so the reconcile phase is
    // already-current (no mutation); Engram is the representative under test.
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ plugins: [], mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      // Older present Engram: must stay untouched (no brew/curl/setup/update).
      if (key === "engram version") return { stdout: "engram 1.0.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.3.0", stderr: "" };
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "zotpilot --version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (key.startsWith("npm view @colbymchenry/codegraph")) return { stdout: "9.9.9", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await runSetupDependencies(executor, { configDir });

    const engram = result.outcomes.find((outcome) => outcome.component === "engram");
    expect(engram?.status).toBe("skipped");
    expect(engram?.mutated).toBe(false);
    // No version-chasing mutation merely because newer exists.
    expect(calls.some((call) => call.startsWith("brew install") || call.startsWith("brew upgrade"))).toBe(false);
    expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
    expect(calls.some((call) => call.startsWith("engram setup"))).toBe(false);
    expect(hasThirdPartyMutation(calls)).toBe(false);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
  });
});

describe("T002 rerun setup on a complete installation is idempotent", () => {
  it("second run mutates nothing and leaves the tree byte-identical", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        plugins: [],
        mcp: {
          servers: {
            codegraph: { type: "local", command: CODEGRAPH_MCP_COMMAND },
            zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] },
          },
        },
      }),
    );
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.4.0", stderr: "" };
      if (key === "npm view @colbymchenry/codegraph version") return { stdout: "1.4.0", stderr: "" };
      if (key === "zotpilot --version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    const first = await runSetupDependencies(executor, { configDir });
    const before = await snapshotTree(root);
    const secondCalls: string[] = [];
    const secondExecutor: Executor = async (command, args) => {
      secondCalls.push(`${command} ${args.join(" ")}`);
      return executor(command, args);
    };
    const second = await runSetupDependencies(secondExecutor, { configDir });

    for (const outcome of second.outcomes) {
      expect(["completed", "skipped"]).toContain(outcome.status);
      expect(outcome.mutated).toBe(false);
    }
    expect(hasThirdPartyMutation(secondCalls)).toBe(false);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
    void first;
  });
});

describe("T002 doctor performs no writes", () => {
  it("leaves the filesystem byte-identical with no mutating executor calls", async () => {
    const { root } = await makeIsolatedConfigDir();
    const worktree = await makeTempRoot("rdc-t002-doctor-");
    await writeFile(resolve(worktree, "probe.txt"), "probe");
    const beforeWorktree = await snapshotTree(worktree);
    const beforeRoot = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (key === "engram version") throw new Error("not found");
      if (key === "codegraph --version") throw new Error("not found");
      if (key === "zotpilot --version") throw new Error("not found");
      throw new Error(`Unexpected command: ${key}`);
    };

    const report = await runDoctor({ executor, worktree, discovery: async () => ({ models: [] }) });

    expect(Array.isArray(report.findings)).toBe(true);
    expect(hasThirdPartyMutation(calls)).toBe(false);
    const afterWorktree = await snapshotTree(worktree);
    expect([...afterWorktree.keys()].sort()).toEqual([...beforeWorktree.keys()].sort());
    for (const [path, bytes] of beforeWorktree) expect(afterWorktree.get(path)).toBe(bytes);
    const afterRoot = await snapshotTree(root);
    expect([...afterRoot.keys()].sort()).toEqual([...beforeRoot.keys()].sort());
  });
});

describe("R001 complete setup path is install-only with no version-chasing sync", () => {
  it("leaves an older present Engram untouched, never runs brew update/upgrade, and reruns idempotently", async () => {
    const checkoutRoot = await makeTempRoot("rdc-r001-checkout-");
    const binDir = resolve(checkoutRoot, "checkout", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "aria.mjs"), "#!/usr/bin/env node\nconsole.log('ok');");
    const checkout = resolve(checkoutRoot, "checkout");
    const binaryUrl = pathToFileURL(resolve(binDir, "aria.mjs")).href;
    const filesRoot = await makeTempRoot("rdc-r001-files-");
    const files = {
      globalConfigPath: resolve(filesRoot, "opencode.json"),
      agentsDir: resolve(filesRoot, "agents"),
      skillsRoot: resolve(filesRoot, "skills"),
    };
    assertNotCallerGlobalPath(files.globalConfigPath, "R001 globalConfigPath");

    // Already registered (exact local checkout identity) with an OLDER
    // Engram present while a newer upstream exists: setup must not chase it.
    const pluginList = ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n");
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: pluginList, stderr: "" };
      if (key === "engram version") return { stdout: "engram 1.0.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.3.0", stderr: "" };
      if (key === "npm view @colbymchenry/codegraph version") return { stdout: "9.9.9\n", stderr: "" };
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "zotpilot --version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    // Production wiring: the shared install-only lifecycle seam with NO
    // depsSync seam (R001: `bin/aria.mjs` passes nothing there).
    const runProductionSetup = (exec: Executor) =>
      setup(binaryUrl, exec, undefined, {
        files,
        dependenciesFn: async (inner, configDir) => runSetupDependencies(inner, { configDir }),
      });

    const first = await runProductionSetup(executor);

    expect(first.ok).toBe(true);
    expect(first.stage).toBe("complete");
    const engram = first.setup?.dependencies?.outcomes.find((outcome) => outcome.component === "engram");
    expect(engram?.status).toBe("skipped");
    expect(engram?.mutated).toBe(false);
    // The complete path never reaches the version-chasing sync: no brew
    // update/upgrade (and no install fallback), no GitHub release sync.
    expect(calls.some((call) => call.startsWith("brew update") || call.startsWith("brew upgrade"))).toBe(false);
    expect(calls.some((call) => call.startsWith("brew install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
    expect(calls.some((call) => call.startsWith("engram setup"))).toBe(false);
    expect(hasThirdPartyMutation(calls)).toBe(false);
    expect(first.setup?.sync.ok).toBe(true);
    expect(first.setup?.sync.output).toContain("install-if-missing");

    // Rerun on the complete installation: idempotent, byte-identical, still
    // no version-chasing calls.
    const before = await snapshotTree(filesRoot);
    const secondCalls: string[] = [];
    const secondExecutor: Executor = async (command, args) => {
      secondCalls.push(`${command} ${args.join(" ")}`);
      return executor(command, args);
    };
    const second = await runProductionSetup(secondExecutor);

    expect(second.ok).toBe(true);
    expect(second.stage).toBe("complete");
    for (const outcome of second.setup?.dependencies?.outcomes ?? []) {
      expect(outcome.mutated).toBe(false);
    }
    expect(hasThirdPartyMutation(secondCalls)).toBe(false);
    expect(secondCalls.some((call) => call.startsWith("brew update") || call.startsWith("brew upgrade"))).toBe(false);
    expect(secondCalls.some((call) => call.startsWith("curl"))).toBe(false);
    const after = await snapshotTree(filesRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
  });
});

describe("T002 upgrade never upgrades third parties", () => {
  it("read-only inventory and the ARIA-only already-current path run zero third-party mutations", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") {
        return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
      }
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.4.0", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    const check = await checkUpgradeInventory(executor, {
      configDir,
      currentVersion: "1.0.7",
      // R006: already-current requires BOTH registration and CLI at target.
      cliVersion: "1.0.7",
      availableOverride: TARGET_107,
    });
    expect(check.currentVersion).toBe("1.0.7");
    expect(hasThirdPartyMutation(calls)).toBe(false);

    // Production upgrade path (no dependenciesFn seam): ARIA-only with zero
    // third-party mutation on the already-current short-circuit.
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.7",
      // R006: already-current requires BOTH registration and CLI at target.
      cliVersion: "1.0.7",
      availableOverride: TARGET_107,
      approval: { yes: true },
    });
    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(true);
    expect(result.dependencies).toBeUndefined();
    expect(hasThirdPartyMutation(calls)).toBe(false);
  });
});
