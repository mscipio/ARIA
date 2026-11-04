import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSetupDependencies } from "../src/dependencies";
import type { Executor } from "../src/deps";
import { codegraphProviderState, codegraphProvenance, parseCodegraphLatest, upgradeCodegraphExternal } from "../src/codegraph";
import { checkUpgradeInventory } from "../src/upgrade";

// Provider-supported updates for externally installed Engram and CodeGraph.
// Provenance is built on disk (a real symlink into an npm global prefix, a real
// Homebrew-style cellar), and every upgrade command is a simulated executor.

let root: string;
const ANSI_LATEST = "\u001b[1mCodeGraph\u001b[0m  current \u001b[36mv1.3.1\u001b[0m  latest \u001b[36mv1.6.2\u001b[0m";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aria-provider-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Lay out an npm global CodeGraph install and a PATH entry symlinked into it. */
async function npmGlobalCodegraph(): Promise<{ npmRoot: string; binary: string }> {
  const npmRoot = join(root, "npm", "lib", "node_modules");
  const packageDir = join(npmRoot, "@colbymchenry", "codegraph", "dist", "bin");
  await mkdir(packageDir, { recursive: true });
  const target = join(packageDir, "codegraph.js");
  await writeFile(target, "#!/usr/bin/env node\n");
  await mkdir(join(root, "bin"), { recursive: true });
  const binary = join(root, "bin", "codegraph");
  await symlink(target, binary);
  return { npmRoot, binary };
}

/** A codegraph binary outside the npm global package (e.g. a checkout). */
async function foreignCodegraph(): Promise<string> {
  const dir = join(root, "checkout");
  await mkdir(dir, { recursive: true });
  const binary = join(dir, "codegraph");
  await writeFile(binary, "#!/bin/sh\n");
  return binary;
}

interface CodegraphSim {
  version: string;
  latest: string;
  upgradeEffect: "apply" | "ignore" | "fail";
  npmRoot: string;
  binary: string;
}

function codegraphExecutor(sim: CodegraphSim, calls: string[]): Executor {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    if (command === "which" && args[0] === "codegraph") return { stdout: `${sim.binary}\n`, stderr: "" };
    if (command === "npm" && args[0] === "root") return { stdout: `${sim.npmRoot}\n`, stderr: "" };
    if (command === "codegraph" && args[0] === "--version") return { stdout: `${sim.version}\n`, stderr: "" };
    if (command === "codegraph" && args[0] === "upgrade" && args[1] === "--check") return { stdout: ANSI_LATEST, stderr: "" };
    if (command === "codegraph" && args[0] === "upgrade") {
      if (sim.upgradeEffect === "fail") throw new Error("EACCES: permission denied");
      if (sim.upgradeEffect === "apply" && args[1] !== undefined) sim.version = args[1];
      return { stdout: "", stderr: "" };
    }
    if (command === "npm" && args[0] === "view") return { stdout: `${sim.latest}\n`, stderr: "" };
    throw new Error(`unexpected in test: ${key}`);
  };
}

describe("CodeGraph provenance and provider state", () => {
  it("parses the upstream --check line through ANSI styling", () => {
    expect(parseCodegraphLatest(ANSI_LATEST)).toBe("1.6.2");
    expect(parseCodegraphLatest("nothing here")).toBeNull();
  });

  it("recognises an npm-global install by resolving the binary into the package", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const provenance = await codegraphProvenance(codegraphExecutor({ version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary }, []));
    expect(provenance.npmGlobal).toBe(true);
  });

  it("refuses a binary that does not resolve into the npm global package", async () => {
    const npmRoot = join(root, "npm", "lib", "node_modules");
    await mkdir(npmRoot, { recursive: true });
    const binary = await foreignCodegraph();
    const provenance = await codegraphProvenance(codegraphExecutor({ version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary }, []));
    expect(provenance.npmGlobal).toBe(false);
    expect(provenance.detail).toContain("not eligible");
  });

  it("reports installed and latest versions read-only", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const calls: string[] = [];
    const state = await codegraphProviderState(codegraphExecutor({ version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary }, calls));
    expect(state).toMatchObject({ installed: "1.3.1", latest: "1.6.2", npmGlobal: true });
    expect(calls.some((call) => call.startsWith("codegraph upgrade ") && !call.includes("--check"))).toBe(false);
  });
});

describe("explicit CodeGraph upgrade", () => {
  it("runs the upstream upgrade for the exact release and verifies the installed version", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary };
    const calls: string[] = [];
    const result = await upgradeCodegraphExternal(codegraphExecutor(sim, calls), "1.6.2");
    expect(result).toMatchObject({ status: "completed", mutated: true });
    expect(calls).toContain("codegraph upgrade 1.6.2");
    expect(result.detail).toContain("MCP registration untouched");
  });

  it("reports unresolved, never success, when the installed version does not change", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "ignore", npmRoot, binary };
    const result = await upgradeCodegraphExternal(codegraphExecutor(sim, []), "1.6.2");
    expect(result.status).toBe("unresolved");
    expect(result.detail).toContain("did not claim success");
  });

  it("reports unresolved with the upstream error when the upgrade command fails", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "fail", npmRoot, binary };
    const result = await upgradeCodegraphExternal(codegraphExecutor(sim, []), "1.6.2");
    expect(result).toMatchObject({ status: "unresolved", mutated: true });
    expect(result.detail).toContain("permission denied");
  });

  it("never runs an upgrade for a non-exact target or a non-npm install", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const calls: string[] = [];
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary };
    expect((await upgradeCodegraphExternal(codegraphExecutor(sim, calls), "latest")).status).toBe("skipped");
    expect(calls.some((call) => call.startsWith("codegraph upgrade"))).toBe(false);

    const foreign = await foreignCodegraph();
    const foreignSim: CodegraphSim = { ...sim, binary: foreign };
    const foreignCalls: string[] = [];
    const result = await upgradeCodegraphExternal(codegraphExecutor(foreignSim, foreignCalls), "1.6.2");
    expect(result).toMatchObject({ status: "skipped", mutated: false });
    expect(foreignCalls.some((call) => call.startsWith("codegraph upgrade 1.6.2"))).toBe(false);
  });

  it("setup never invokes the provider upgrade, even when a newer CodeGraph exists", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary };
    const calls: string[] = [];
    const base = codegraphExecutor(sim, calls);
    const executor: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "upgrade" && args[1] !== "--check") {
        calls.push(`setup-saw ${command} ${args.join(" ")}`);
      }
      try {
        return await base(command, args);
      } catch {
        return { stdout: "", stderr: "" };
      }
    };
    await runSetupDependencies(executor, { configDir: join(root, "config"), homeDir: join(root, "home") });
    expect(calls.some((call) => call.startsWith("setup-saw"))).toBe(false);
  });
});

describe("inventory with provider discovery", () => {
  it("offers a CodeGraph update only when discovery is requested, and labels it external", async () => {
    const { npmRoot, binary } = await npmGlobalCodegraph();
    const sim: CodegraphSim = { version: "1.3.1", latest: "1.6.2", upgradeEffect: "apply", npmRoot, binary };

    const offline = await checkUpgradeInventory(codegraphExecutor(sim, []), { availableOverride: null });
    const offlineRow = offline.components.find((row) => row.component === "codegraph");
    expect(offlineRow?.status).toBe("unmanaged-observed");

    const calls: string[] = [];
    const checked = await checkUpgradeInventory(codegraphExecutor(sim, calls), { availableOverride: null, discoverProviders: true });
    const row = checked.components.find((candidate) => candidate.component === "codegraph");
    expect(row).toMatchObject({ status: "provider-upgrade-available", installed: "1.3.1", available: "1.6.2" });
    expect(row?.detail).toContain("codegraph upgrade 1.6.2");
    expect(calls).toContain("codegraph upgrade --check");
  });

  it("reports an Engram Homebrew update from the formula, with the brew mechanism", async () => {
    const cellar = join(root, "cellar");
    const binDir = join(cellar, "engram", "3.4.0", "bin");
    await mkdir(binDir, { recursive: true });
    const realBinary = join(binDir, "engram");
    await writeFile(realBinary, "#!/bin/sh\n");
    await mkdir(join(root, "path"), { recursive: true });
    const pathBinary = join(root, "path", "engram");
    await symlink(realBinary, pathBinary);

    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      if (command === "engram" && args[0] === "version") return { stdout: "engram v3.4.0\n", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: `${pathBinary}\n`, stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram\n", stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${cellar}\n`, stderr: "" };
      if (command === "brew" && args[0] === "info") {
        return { stdout: JSON.stringify({ formulae: [{ versions: { stable: "3.6.0" } }] }), stderr: "" };
      }
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1\n", stderr: "" };
      if (command === "npm" && args[0] === "root") return { stdout: join(root, "none") + "\n", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      throw new Error(`unexpected in test: ${key}`);
    };

    const checked = await checkUpgradeInventory(executor, { availableOverride: null, discoverProviders: true });
    const row = checked.components.find((candidate) => candidate.component === "engram");
    expect(row).toMatchObject({ status: "provider-upgrade-available", installed: "3.4.0", available: "3.6.0" });
    expect(row?.detail).toContain("brew upgrade to 3.6.0");
    expect(calls.some((call) => call.startsWith("brew info --json=v2 gentleman-programming/tap/engram"))).toBe(true);
  });
});

describe("parser safety", () => {
  it("returns no latest release for unrelated output", () => {
    expect(parseCodegraphLatest("CodeGraph is up to date")).toBeNull();
  });
});
