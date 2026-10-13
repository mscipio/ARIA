import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { classifySetupIdentity, gateStandaloneSync, setup } from "../src/lifecycle.js";
import { checkAlreadyCurrentCliIdentity, runUpgrade, type AriaAvailableTarget } from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

/**
 * T010 mutation-gating regression coverage (smallest representative set):
 * - bootstrap-over-existing Git registration: a TUI-only `-` row carrying
 *   an approved Git source is never classified absent, so `setup()` from a
 *   dev checkout cannot bootstrap over it;
 * - already-current dependency path: a running CLI that is not positively
 *   the registered installation (e.g. CLI 1.0.8 vs registered v1.0.7)
 *   fails closed before the dependency seam runs, while a matching CLI
 *   still runs and the approved exact-target handoff is preserved;
 * - standalone sync dispatch: the same checkout-vs-registration identity
 *   blocks sync on a definite mismatch before any mutation.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-t010-gate-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFixtureCheckout(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
  return root;
}

function binaryUrl(checkout: string): string {
  return pathToFileURL(resolve(checkout, "bin", "aria.mjs")).href;
}

type Call = { command: string; args: string[]; options?: { cwd?: string } };

function collectingExecutor(responses: Record<string, { stdout?: string; stderr?: string; error?: string }>): {
  executor: Executor;
  calls: Call[];
} {
  const calls: Call[] = [];
  const executor: Executor = async (command, args, options) => {
    calls.push({ command, args, options });
    const response = responses[`${command} ${args.join(" ")}`];
    if (!response) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { executor, calls };
}

const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

async function setupFiles() {
  const dir = await tempDir();
  const files = {
    globalConfigPath: join(dir, "opencode.json"),
    agentsDir: join(dir, "agents"),
    skillsRoot: "/opt/aria-checkout/skills",
  };
  assertNotCallerGlobalPath(files.globalConfigPath, "setup files.globalConfigPath");
  assertNotCallerGlobalPath(files.agentsDir, "setup files.agentsDir");
  return files;
}

describe("T010 bootstrap-over-existing Git registration", () => {
  it("classifies a TUI-only Git-source row as mismatch, never absent", () => {
    const gate = classifySetupIdentity(
      [{ id: "-", version: "842e4ec", target: "github:mscipio/ARIA#v1.0.7" }],
      () => false,
    );
    expect(gate.kind).toBe("mismatch");
    expect(gate.detail).toContain("definite mismatch");
    expect(gate.detail).toContain("aria upgrade --yes");
  });

  it("blocks setup bootstrap over an existing `- github:...` registration before any write", async () => {
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const listed = ["ID  VERSION  SOURCE", "-  842e4ec  github:mscipio/ARIA#v1.0.7"].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    }, { worktree: await tempDir(), files });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.action).toBe("failed");
    expect(result.setup!.registration.detail).toContain("definite mismatch");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(result.setup?.config).toBeUndefined();
    expect(syncCalled).toBe(false);
    await expect(readFile(files.globalConfigPath, "utf8")).rejects.toThrow();
  });
});

describe("T010 already-current CLI/plugin identity gate", () => {
  function upgradeExecutor(pluginListStdout: string, calls: string[]): Executor {
    return async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "ls-remote") {
        return { stdout: "bbb222\trefs/tags/v1.0.7\n", stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
        return { stdout: pluginListStdout, stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
        return { stdout: "MCP Servers", stderr: "" };
      }
      if (command === "engram") throw new Error("engram not found");
      if (command === "codegraph") throw new Error("codegraph not found");
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
  }

  function pluginTable(rows: Array<[string, string, string]>): string {
    return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
  }

  it("blocks the dependency seam on CLI 1.0.8 vs registered v1.0.7 with zero mutation", async () => {
    const calls: string[] = [];
    const executor = upgradeExecutor(pluginTable([["aria", "842e4ec", TARGET_107.spec]]), calls);
    let seamCalled = 0;
    const result = await runUpgrade(executor, {
      cliVersion: "1.0.8",
      availableOverride: TARGET_107,
      approval: { yes: true },
      dependenciesFn: async () => {
        seamCalled++;
        return { ok: true, outcomes: [], report: "must not run" };
      },
    });

    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(false);
    expect(seamCalled).toBe(0);
    expect(result.dependencies).toBeUndefined();
    expect(result.detail).toContain("definite mismatch");
    expect(result.detail).toContain("No changes were made");
    // Pure helper agrees: CLI 1.0.8 vs installed 1.0.7 fails closed.
    expect(checkAlreadyCurrentCliIdentity(result.check).ok).toBe(false);
  });

  it("runs the seam when CLI positively matches the registered installation", async () => {
    const calls: string[] = [];
    const executor = upgradeExecutor(pluginTable([["aria", "842e4ec", TARGET_107.spec]]), calls);
    let seamCalled = 0;
    const result = await runUpgrade(executor, {
      cliVersion: "1.0.7",
      availableOverride: TARGET_107,
      approval: { yes: true },
      dependenciesFn: async () => {
        seamCalled++;
        return { ok: true, outcomes: [], report: "stubbed dependencies completed" };
      },
    });

    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(true);
    expect(seamCalled).toBe(1);
    expect(result.dependencies?.report).toContain("stubbed dependencies completed");
  });

  it("preserves the approved exact-target handoff when CLI differs (upgrade-available)", async () => {
    const calls: string[] = [];
    const target109: AriaAvailableTarget = {
      tag: "v1.0.9",
      version: "1.0.9",
      spec: "github:mscipio/ARIA#v1.0.9",
    };
    const executor = upgradeExecutor(
      pluginTable([["aria", "842e4ec", "github:mscipio/ARIA#v1.0.7"]]),
      calls,
    );
    let seamCalled = 0;
    const result = await runUpgrade(executor, {
      cliVersion: "1.0.8",
      availableOverride: target109,
      approval: { yes: true },
      selfUpgradeFn: async () => ({ ok: true, detail: "replaced", handoffNote: "new release owns remainder" }),
      dependenciesFn: async () => {
        seamCalled++;
        throw new Error("dependencies must not run pre-handoff");
      },
    });

    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(seamCalled).toBe(0);
    expect(result.handoff?.target.spec).toBe(target109.spec);
  });
});

describe("T010 standalone sync identity gate", () => {
  it("blocks sync on a definite Git mismatch before any mutation", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor, calls } = collectingExecutor({
      "opencode plugin list": {
        stdout: ["ID  VERSION  SOURCE", "aria  842e4ec  github:mscipio/ARIA#v1.0.7"].join("\n"),
      },
    });

    const gate = await gateStandaloneSync(executor, binaryUrl(checkout));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toContain("definite mismatch");
    // Fail-before-mutation: only the read-only list probe ran.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(" ")).toContain("plugin list");
  });

  it("blocks sync over a TUI-only Git-source row (never absent)", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "opencode plugin list": {
        stdout: ["ID  VERSION  SOURCE", "-  842e4ec  github:mscipio/ARIA#v1.0.7"].join("\n"),
      },
    });

    const gate = await gateStandaloneSync(executor, binaryUrl(checkout));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toContain("definite mismatch");
  });

  it("allows sync when the checkout matches or registration is positively absent", async () => {
    const checkout = await makeFixtureCheckout();
    const matching = collectingExecutor({
      "opencode plugin list": {
        stdout: ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n"),
      },
    });
    await expect(gateStandaloneSync(matching.executor, binaryUrl(checkout))).resolves.toMatchObject({ ok: true });

    const absent = collectingExecutor({ "opencode plugin list": { stdout: "No plugins found" } });
    await expect(gateStandaloneSync(absent.executor, binaryUrl(checkout))).resolves.toMatchObject({ ok: true });

    const unknown = collectingExecutor({ "opencode plugin list": { stdout: "something unexpected" } });
    await expect(gateStandaloneSync(unknown.executor, binaryUrl(checkout))).resolves.toMatchObject({ ok: false });
  });
});
