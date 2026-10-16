import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runDepsUpgrades } from "../src/dependencies.js";
import type { Executor } from "../src/deps.js";
import { checkUpgradeInventory, formatDepsUpgradeProposal, runUpgrade, type AriaAvailableTarget } from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T004 deps inventory + confirmation-gated managed upgrades (focused
// public-interface regressions).
//
// - plain inventory is mutation-free (read-only probes only);
// - the unconfirmed `--upgrade` proposal promises no mutation (pure
//   reporting; the dispatcher gates `runDepsUpgrades` on `--yes`);
// - unconfirmed/unmanaged targets are not upgraded (managed-only adapters
//   fail closed to report-only with zero mutation);
// - a confirmed managed outdated target upgrades via the existing adapter;
// - a dependency failure is isolated per component and never blocks the
//   ARIA-only upgrade path (production `aria upgrade` carries no
//   dependenciesFn seam).
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
  const root = await makeTempRoot("rdc-t004-");
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

function expectSameTree(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
}

/** Mutating third-party commands that inventory/proposal/unmanaged paths must never run. */
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

const TARGET_1015: AriaAvailableTarget = {
  tag: "v1.0.15",
  version: "1.0.15",
  spec: "github:mscipio/ARIA#v1.0.15",
};

describe("T004 plain deps inventory is mutation-free", () => {
  it("runs read-only probes only and reports every non-ARIA component", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.3.1", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };

    // Pinned identities: no `git ls-remote`, no installer/updater, no network.
    const check = await checkUpgradeInventory(executor, {
      configDir,
      currentVersion: "1.0.15",
      availableOverride: null,
    });

    const rows = check.components.filter((row) => row.component !== "aria");
    expect(rows.map((row) => row.component).sort()).toEqual(["codegraph", "context7", "engram", "quota", "zotpilot"]);
    for (const row of rows) expect(typeof row.detail).toBe("string");
    expect(hasThirdPartyMutation(calls)).toBe(false);
    expectSameTree(before, await snapshotTree(root));

    // The unconfirmed proposal is pure reporting over the same inventory.
    const proposal = formatDepsUpgradeProposal(check);
    expect(proposal).toContain("ARIA dependency upgrade proposal (read-only; no changes were made)");
    expect(proposal).toContain("`aria deps --upgrade --yes`");
    expect(proposal).toContain("No changes were made.");
    expect(hasThirdPartyMutation(calls)).toBe(false);
    expectSameTree(before, await snapshotTree(root));
  });
});

describe("T004 unmanaged targets stay report-only with zero mutation", () => {
  it("leaves ambiguous/shared/present installs untouched when upgrades run", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    // Dual-file ambiguity fails every file-writing adapter closed.
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: [] }));
    await writeFile(resolve(configDir, "opencode.jsonc"), JSON.stringify({ plugins: [] }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.3.1", stderr: "" };
      if (key === "zotpilot --version") throw new Error("not found");
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await runDepsUpgrades(executor, { configDir });

    expect(result.outcomes.map((outcome) => outcome.component).sort()).toEqual([
      "codegraph",
      "context7",
      "engram",
      "quota",
      "zotpilot",
    ]);
    for (const outcome of result.outcomes) {
      expect(outcome.status).toBe("skipped");
      expect(outcome.mutated).toBe(false);
    }
    expect(result.ok).toBe(true);
    expect(hasThirdPartyMutation(calls)).toBe(false);
    expectSameTree(before, await snapshotTree(root));
  });
});

function seedManagedZotPilotConfig(configDir: string): Promise<void> {
  return writeFile(
    resolve(configDir, "opencode.json"),
    JSON.stringify({
      mcp: {
        servers: {
          zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] },
          context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
        },
      },
    }),
  );
}

function managedZotPilotExecutor(
  calls: string[],
  state: { zpVersion: string; homeDir: string; failInstall: boolean },
): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const key = `${command} ${args.join(" ")}`;
    if (key === "opencode mcp list") return { stdout: "zotpilot connected\ncodegraph connected", stderr: "" };
    if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
    if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (key === "codegraph --version") return { stdout: "codegraph 1.3.1", stderr: "" };
    if (key === "npm view @colbymchenry/codegraph version") throw new Error("network unavailable");
    if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
    if (key === "zotpilot --version") return { stdout: `zotpilot ${state.zpVersion}`, stderr: "" };
    if (key === "python3 -m pip show zotpilot") {
      return {
        stdout: `Name: zotpilot\nVersion: ${state.zpVersion}\nLocation: ${state.homeDir}/.local/lib/python3.12/site-packages`,
        stderr: "",
      };
    }
    if (key === "python3 -m pip index versions zotpilot") {
      return { stdout: "Available versions: 0.5.3, 0.5.2\n  Latest version: 0.5.3", stderr: "" };
    }
    if (key === "python3 -m pip install --user zotpilot==0.5.3") {
      if (state.failInstall) throw new Error("pip exploded");
      state.zpVersion = "0.5.3";
      return { stdout: "Successfully installed", stderr: "" };
    }
    throw new Error(`Unexpected command: ${key}`);
  };
}

describe("T004 confirmed managed upgrade applies via the existing adapter", () => {
  it("upgrades an outdated user-scoped ZotPilot while other components stay untouched", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await seedManagedZotPilotConfig(configDir);
    const configBefore = await readFile(resolve(configDir, "opencode.json"), "utf8");
    const calls: string[] = [];
    const state = { zpVersion: "0.5.2", homeDir: root, failInstall: false };

    const result = await runDepsUpgrades(managedZotPilotExecutor(calls, state), { configDir, homeDir: root });

    const zotpilot = result.outcomes.find((outcome) => outcome.component === "zotpilot");
    expect(zotpilot?.status).toBe("completed");
    expect(zotpilot?.mutated).toBe(true);
    expect(zotpilot?.detail).toContain("0.5.2");
    expect(calls).toContain("python3 -m pip install --user zotpilot==0.5.3");
    // The update path never rewrites config: the direct V2 registration is
    // preserved byte-exact.
    expect(await readFile(resolve(configDir, "opencode.json"), "utf8")).toBe(configBefore);
    for (const outcome of result.outcomes.filter((o) => o.component !== "zotpilot")) {
      expect(outcome.mutated).toBe(false);
    }
    expect(result.ok).toBe(true);
  });
});

describe("R004 confirmation cannot install missing targets", () => {
  it("leaves missing Engram/CodeGraph/ZotPilot/Quota report-only with zero install mutations", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    // Canonical Context7 only: the remote endpoint is already healthy, so
    // the tree stays byte-identical and every package adapter faces a
    // genuinely missing target.
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ plugins: [], mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }),
    );
    const before = await snapshotTree(root);
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
      if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
      throw new Error(`Unexpected command: ${key}`);
    };

    // The confirmed path (`aria deps --upgrade --yes` wiring): missing
    // installs belong to `aria setup`, so nothing may install here.
    const result = await runDepsUpgrades(executor, { configDir });

    expect(result.outcomes.map((outcome) => outcome.component).sort()).toEqual([
      "codegraph",
      "context7",
      "engram",
      "quota",
      "zotpilot",
    ]);
    for (const component of ["engram", "codegraph", "zotpilot", "quota"]) {
      const outcome = result.outcomes.find((entry) => entry.component === component);
      expect(outcome?.status).toBe("skipped");
      expect(outcome?.mutated).toBe(false);
      expect(outcome?.detail).toContain("aria setup");
    }
    const context7 = result.outcomes.find((outcome) => outcome.component === "context7");
    expect(context7?.mutated).toBe(false);
    expect(result.ok).toBe(true);
    // No missing-install path activated: no package install, no brew
    // upgrade, no registration write, no setup/normalize mutation.
    for (const call of calls) {
      expect(call.startsWith("npm install -g")).toBe(false);
      expect(call.startsWith("brew install")).toBe(false);
      expect(call.startsWith("brew upgrade")).toBe(false);
      expect(call.startsWith("python3 -m pip install")).toBe(false);
      expect(call.startsWith("opencode plugin add")).toBe(false);
      expect(call.startsWith("engram setup")).toBe(false);
    }
    expect(hasThirdPartyMutation(calls)).toBe(false);
    expectSameTree(before, await snapshotTree(root));
  });
});

describe("T004 dependency failure is isolated and never blocks ARIA self-upgrade", () => {
  it("reports the failed component while others complete, and the ARIA-only upgrade path stays clean", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await seedManagedZotPilotConfig(configDir);
    const calls: string[] = [];
    const state = { zpVersion: "0.5.2", homeDir: root, failInstall: true };

    const deps = await runDepsUpgrades(managedZotPilotExecutor(calls, state), { configDir, homeDir: root });

    const zotpilot = deps.outcomes.find((outcome) => outcome.component === "zotpilot");
    expect(zotpilot?.status).toBe("unresolved");
    expect(deps.ok).toBe(false);
    // Later components still ran despite the failure.
    expect(deps.outcomes.map((outcome) => outcome.component).sort()).toEqual([
      "codegraph",
      "context7",
      "engram",
      "quota",
      "zotpilot",
    ]);

    // Production `aria upgrade` carries no dependenciesFn seam: the same
    // failing dependency surface cannot block ARIA self-upgrade (verify, do
    // not regress the T002 ARIA-only path).
    const upgradeCalls: string[] = [];
    const upgradeExecutor: Executor = async (command, args) => {
      upgradeCalls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      // R001 bare-CLI convergence probe (read-only verification).
      if (key === "aria --version") return { stdout: "1.0.15", stderr: "" };
      if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (key === "opencode mcp list") {
        return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
      }
      if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph 1.4.0", stderr: "" };
      throw new Error(`Unexpected command: ${key}`);
    };
    const upgraded = await runUpgrade(upgradeExecutor, {
      configDir,
      currentVersion: "1.0.15",
      cliVersion: "1.0.15",
      availableOverride: TARGET_1015,
      approval: { yes: true },
    });
    expect(upgraded.stage).toBe("already-current");
    expect(upgraded.ok).toBe(true);
    expect(upgraded.dependencies).toBeUndefined();
    expect(hasThirdPartyMutation(upgradeCalls)).toBe(false);
  });
});
