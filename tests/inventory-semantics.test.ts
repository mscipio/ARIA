import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { doctorExitCode, runDoctor, type DoctorReport } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import type { ModelDiscovery } from "../src/model-config.js";
import { openCodeGlobalDir } from "../src/paths.js";
import {
  checkQuotaUpgrade,
  identifyQuotaTarget,
  QUOTA_PLUGIN_ID,
  upgradeQuota,
} from "../src/quota.js";
import {
  checkUpgradeInventory,
  UPGRADE_COMPONENTS,
  type AriaAvailableTarget,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T007 inventory semantics: blockers, action-needed findings, informational
// state, and intentionally unmanaged/unobservable components stay
// distinguishable in the existing vocabulary (no new statuses/severities).
// Quota `@latest` remains an unknown-target and fails closed with no
// mutation anywhere it is inventoried.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let savedHome: string | undefined;
let savedXdg: string | undefined;
let savedWikiDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedWikiDir = process.env.WIKI_DIR;
  delete process.env.WIKI_DIR;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = savedWikiDir;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
  for (const [path, bytes] of before) {
    expect(after.get(path)).toBe(bytes);
  }
}

// ---------------------------------------------------------------------------
// Doctor fixtures: isolated HOME (XDG cleared so HOME resolves), temp
// worktree/agents, healthy probes with a swappable OpenCode version.
// ---------------------------------------------------------------------------

/** Every packaged default route model, with observable variant metadata. */
const DEFAULT_MODELS: ModelDiscovery = {
  models: [
    { id: "opencode-go/muse-spark-1.3-contributor", providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", variants: ["xhigh", "high"], variantsObservable: true },
    { id: "openai/gpt-6-luna", providerID: "openai", modelID: "gpt-6-luna", name: "GPT 6 Luna", variants: ["xhigh"], variantsObservable: true },
    { id: "openai/gpt-6.1-sol", providerID: "openai", modelID: "gpt-6.1-sol", name: "GPT 6.1 Sol", variants: ["high", "medium"], variantsObservable: true },
  ],
};

function doctorExecutor(opencodeVersionOutput: string): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: opencodeVersionOutput, stderr: "" };
    if (invocation === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return {
        stdout: [
          "opencode v1.2.3",
          "mcp:",
          "  engram     connected",
          "  context7   connected",
          "  codegraph  connected",
        ].join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: `unexpected probe: ${invocation}` };
  };
}

async function doctorOptions(opencodeVersionOutput: string): Promise<{ worktree: string; executor: Executor }> {
  const home = await mkdtemp(resolve(tmpdir(), "aria-sem-home-"));
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-sem-wt-"));
  const agentsDir = await mkdtemp(resolve(tmpdir(), "aria-sem-ag-"));
  tempDirs.push(home, worktree, agentsDir);
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  const configDir = resolve(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({
    mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
  }));
  return { worktree, executor: doctorExecutor(opencodeVersionOutput) };
}

async function runSemDoctor(opencodeVersionOutput: string, v2?: { sessionsObserved: number }): Promise<{ report: DoctorReport; agentsDir: string }> {
  const { worktree, executor } = await doctorOptions(opencodeVersionOutput);
  const agentsDir = tempDirs[tempDirs.length - 1] as string;
  const report = await runDoctor({ worktree, agentsDir, executor, discovery: async () => DEFAULT_MODELS, v2 });
  return { report, agentsDir };
}

function finding(report: DoctorReport, area: string, title: string) {
  return report.findings.find((entry) => entry.area === area && entry.title === title);
}

describe("T007 doctor severity categories", () => {
  it("FAILs a below-minimum runtime as a known-incompatible blocker", async () => {
    const { report } = await runSemDoctor("opencode 1.18.34");

    const opencode = finding(report, "dependencies", "OpenCode");
    expect(opencode?.severity).toBe("FAIL");
    expect(opencode?.detail).toContain("below minimum supported 2.0.23");
    expect(opencode?.detail).toContain("known-incompatible");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("WARNs a newer runtime without live evidence as action-needed, never a blocker", async () => {
    const { report } = await runSemDoctor("opencode 2.0.26");

    const opencode = finding(report, "dependencies", "OpenCode");
    expect(opencode?.severity).toBe("WARN");
    expect(opencode?.detail).toContain("2.0.26");
    expect(opencode?.detail).toContain("no live runtime evidence observed");
    expect(opencode?.detail).toContain("not presumed compatible");
    expect(report.findings.filter((entry) => entry.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("WARNs unobservable variant metadata as action-needed rather than failing it", async () => {
    const { worktree, executor } = await doctorOptions("opencode 2.0.23");
    const agentsDir = tempDirs[tempDirs.length - 1] as string;
    await writeFile(resolve(worktree, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-6.1-sol", variant: "high" } },
    }));
    const unobservable: ModelDiscovery = {
      models: DEFAULT_MODELS.models.map((model) => (
        model.id === "openai/gpt-6.1-sol"
          ? { ...model, variants: [], variantsObservable: undefined }
          : model
      )),
    };
    const report = await runDoctor({ worktree, agentsDir, executor, discovery: async () => unobservable });

    const planner = finding(report, "routes/models", "planner");
    expect(planner?.severity).toBe("WARN");
    expect(planner?.detail).toContain("unknown");
    expect(planner?.detail).toContain("not verified");
    expect(report.findings.filter((entry) => entry.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("SKIPs live-runtime lists outside a live session as unobservable, never failed", async () => {
    const { report } = await runSemDoctor("opencode 2.0.23");

    for (const title of ["plugin aria", "agents (11)", "skills (22 live)", "plan tool", "coexistence"]) {
      const entry = finding(report, "runtime", title);
      expect(entry?.severity).toBe("SKIP");
    }
    expect(finding(report, "runtime", "plugin aria")?.detail).toContain("no live OpenCode runtime evidence observed");
    expect(finding(report, "config", "managed agent files")?.severity).toBe("SKIP");
    expect(report.findings.filter((entry) => entry.area === "runtime" && entry.severity === "FAIL")).toHaveLength(0);
  });

  it("PASSes session counts as explicitly informational, not setup truth", async () => {
    const { report } = await runSemDoctor("opencode 2.0.23", { sessionsObserved: 2 });

    const session = finding(report, "runtime", "session/runtime inventory");
    expect(session?.severity).toBe("PASS");
    expect(session?.detail).toContain("2 live session(s) observed");
    expect(session?.detail).toContain("informational; not setup truth");
    // Partial observability stays SKIP: list-unobserved coexistence is not guessed.
    expect(finding(report, "runtime", "coexistence")?.severity).toBe("SKIP");
    expect(report.findings.filter((entry) => entry.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Upgrade fixtures: read-only probe executor plus isolated config dir.
// ---------------------------------------------------------------------------

const LS_REMOTE_SAMPLE = [
  "aaa111\trefs/tags/v1.0.6",
  "bbb222\trefs/tags/v1.0.7",
  "bbb222\trefs/tags/v1.0.7^{}",
  "",
].join("\n");

const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

const QUOTA_SPEC_502 = "@slkiser/opencode-quota@5.0.2";
const QUOTA_LATEST = "@slkiser/opencode-quota@latest";
const QUOTA_FOREIGN = "/home/u/libs/@slkiser/opencode-quota";
const QUOTA_V4 = "@slkiser/opencode-quota@4.10.8";

function pluginList(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

interface UpgradeProbeOutputs {
  lsRemote?: string;
  pluginList?: string;
  mcpList?: string;
  engramVersion?: string;
  codegraphVersion?: string;
}

/** Fake executor serving ONLY read-only upgrade probes; anything else throws. */
function probeExecutor(outputs: UpgradeProbeOutputs, calls: string[]): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "ls-remote") {
      if (outputs.lsRemote === undefined) throw new Error("git ls-remote failed: network unavailable");
      return { stdout: outputs.lsRemote, stderr: "" };
    }
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
      return { stdout: outputs.pluginList ?? "No plugins found", stderr: "" };
    }
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
      if (outputs.mcpList === undefined) throw new Error("opencode mcp list failed");
      return { stdout: outputs.mcpList, stderr: "" };
    }
    if (command === "engram" && args[0] === "version") {
      if (outputs.engramVersion === undefined) throw new Error("engram not found");
      return { stdout: outputs.engramVersion, stderr: "" };
    }
    if (command === "codegraph" && args[0] === "--version") {
      if (outputs.codegraphVersion === undefined) throw new Error("codegraph not found");
      return { stdout: outputs.codegraphVersion, stderr: "" };
    }
    throw new Error(`unexpected mutating/unknown call: ${command} ${args.join(" ")}`);
  };
}

const READ_ONLY_CALLS = new Set([
  "git ls-remote https://github.com/mscipio/ARIA.git",
  "opencode plugin list",
  "opencode mcp list",
  "engram version",
  "codegraph --version",
]);

function expectUpgradeReadOnly(calls: string[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(READ_ONLY_CALLS.has(call), `non-read-only call during inventory: ${call}`).toBe(true);
  }
}

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-sem-upgrade-"));
  tempDirs.push(root);
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  return { root, configDir };
}

const CONNECTED_MCP_LIST = ["MCP Servers", "engram connected", "context7 connected", "codegraph connected"].join("\n");
const CONNECTED_MCP_WITH_ZOTPILOT = [...CONNECTED_MCP_LIST.split("\n"), "zotpilot connected"].join("\n");

function canonicalContext7Config(plugins: unknown[] = []): string {
  return JSON.stringify({
    mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } },
    plugins,
  });
}

describe("T007 upgrade component categories", () => {
  it("distinguishes upgrade-available, remote-healthy, and intentionally unmanaged rows", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(join(configDir, "opencode.json"), canonicalContext7Config([QUOTA_SPEC_502]));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor(
        {
          lsRemote: LS_REMOTE_SAMPLE,
          pluginList: pluginList([[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_SPEC_502]]),
          mcpList: CONNECTED_MCP_WITH_ZOTPILOT,
          engramVersion: "engram 1.20.0",
          codegraphVersion: "codegraph 1.3.1",
        },
        calls,
      ),
      { configDir, currentVersion: "1.0.6" },
    );

    const byName = new Map(result.components.map((row) => [row.component, row]));
    expect(byName.get("aria")?.status).toBe("upgrade-available");
    expect(byName.get("context7")?.status).toBe("remote-healthy");
    for (const name of ["engram", "codegraph", "zotpilot", "quota"] as const) {
      expect(byName.get(name)?.status).toBe("unmanaged-observed");
    }
    expect(byName.get("quota")?.installed).toBe("5.0.2");
    expect(result.selfUpgradeBlocked).toBe(false);
    expectUpgradeReadOnly(calls);
    await expectByteIdentical(root, before);
  });

  it("reports absent components as skipped (informational, nothing to upgrade)", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({}));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: "MCP Servers" }, calls),
      { configDir, currentVersion: "1.0.7" },
    );

    const byName = new Map(result.components.map((row) => [row.component, row]));
    expect(byName.get("aria")?.status).toBe("current");
    for (const name of ["engram", "context7", "codegraph", "zotpilot", "quota"] as const) {
      expect(byName.get(name)?.status).toBe("skipped");
    }
    expect(result.selfUpgradeBlocked).toBe(false);
    expectUpgradeReadOnly(calls);
    await expectByteIdentical(root, before);
  });

  it("blocks ARIA self-upgrade on an unknown target while quota @latest stays unknown-target fail-closed", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(join(configDir, "opencode.json"), canonicalContext7Config([QUOTA_LATEST]));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor(
        {
          pluginList: pluginList([[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_LATEST]]),
          mcpList: CONNECTED_MCP_LIST,
        },
        calls,
      ),
      { configDir, currentVersion: "1.0.6", availableOverride: null },
    );

    const byName = new Map(result.components.map((row) => [row.component, row]));
    expect(byName.get("aria")?.status).toBe("unknown-target");
    expect(result.selfUpgradeBlocked).toBe(true);
    const quota = byName.get("quota");
    expect(quota?.status).toBe("unknown-target");
    expect(quota?.installed).toBeNull();
    expect(quota?.detail).toContain("moving tag");
    expectUpgradeReadOnly(calls);
    await expectByteIdentical(root, before);
  });

  it("leaves foreign-channel and non-5-major quota as unsupported-ownership with zero mutation", async () => {
    for (const spec of [QUOTA_FOREIGN, QUOTA_V4]) {
      const { root, configDir } = await makeIsolatedConfigDir();
      await writeFile(join(configDir, "opencode.json"), canonicalContext7Config([spec]));
      const before = await snapshotTree(root);
      const calls: string[] = [];
      const result = await checkUpgradeInventory(
        probeExecutor(
          {
            pluginList: pluginList([["quota-entry", "5.0.2", spec]]),
            mcpList: CONNECTED_MCP_LIST,
          },
          calls,
        ),
        { configDir, currentVersion: "1.0.7", availableOverride: TARGET_107 },
      );

      const quota = result.components.find((row) => row.component === "quota");
      expect(quota?.status).toBe("unsupported-ownership");
      expect(quota?.installed).toBeNull();
      expectUpgradeReadOnly(calls);
      await expectByteIdentical(root, before);
    }
  });
});

describe("T007 quota @latest stays unknown-target with no mutation", () => {
  it("identifies @latest as unknown-target (pure, never an upgrade target)", () => {
    expect(identifyQuotaTarget([QUOTA_LATEST], [QUOTA_LATEST])).toMatchObject({ kind: "unknown-target" });
    expect(identifyQuotaTarget([QUOTA_LATEST], [])).toMatchObject({ kind: "unknown-target" });
  });

  it("checkQuotaUpgrade reports @latest as unknown-target with only a plugin-list probe and no writes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-sem-quota-"));
    tempDirs.push(root);
    const configDir = resolve(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: [QUOTA_LATEST] }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[0] === "plugin") {
        return { stdout: pluginList([[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_LATEST]]), stderr: "" };
      }
      throw new Error(`unexpected call (updater must never run): ${command} ${args.join(" ")}`);
    };

    const result = await checkQuotaUpgrade(executor, configDir);

    expect(result.status).toBe("unknown-target");
    expect(result.installedSpec).toBeNull();
    expect(result.installedVersion).toBeNull();
    expect(result.detail).toContain("moving tag");
    expect(calls).toEqual(["opencode plugin list"]);
    await expectByteIdentical(root, before);
  });

  it("upgradeQuota leaves an installed @latest untouched: no updater, no writes", async () => {
    const xdg = await mkdtemp(resolve(tmpdir(), "rdc-sem-quota-xdg-"));
    tempDirs.push(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    const dir = openCodeGlobalDir();
    await mkdir(dir, { recursive: true });
    const configPath = resolve(dir, "opencode.json");
    await writeFile(configPath, JSON.stringify({ plugins: [QUOTA_LATEST] }));
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[0] === "plugin") {
        return { stdout: pluginList([[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_LATEST]]), stderr: "" };
      }
      throw new Error(`unexpected call (updater must never run): ${command} ${args.join(" ")}`);
    };

    const result = await upgradeQuota(executor);

    expect(result.status).toBe("unknown-target");
    expect(result.mutated).toBe(false);
    expect(result.resultingSpec).toBeNull();
    expect(calls).toEqual(["opencode plugin list"]);
    expect(calls.some((call) => call.includes("opencode-quota"))).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("covers every quota inventory category without mutation", async () => {
    const cases: Array<{ specs: string[]; rows: Array<[string, string, string]>; status: string }> = [
      { specs: [], rows: [], status: "skipped" },
      { specs: [QUOTA_SPEC_502], rows: [[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_SPEC_502]], status: "unmanaged-observed" },
      { specs: [QUOTA_LATEST], rows: [[QUOTA_PLUGIN_ID, "5.0.2", QUOTA_LATEST]], status: "unknown-target" },
      { specs: [QUOTA_FOREIGN], rows: [["quota-entry", "5.0.2", QUOTA_FOREIGN]], status: "unsupported-ownership" },
    ];
    for (const { specs, rows, status } of cases) {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-sem-quota-cat-"));
      tempDirs.push(root);
      const configDir = resolve(root, "config", "opencode");
      await mkdir(configDir, { recursive: true });
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: specs }));
      const before = await snapshotTree(root);
      const calls: string[] = [];
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "opencode" && args[0] === "plugin") {
          return { stdout: pluginList(rows), stderr: "" };
        }
        throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
      };

      const result = await checkQuotaUpgrade(executor, configDir);

      expect(result.status).toBe(status);
      expect(calls).toEqual(["opencode plugin list"]);
      await expectByteIdentical(root, before);
    }
    expect(UPGRADE_COMPONENTS).toContain("quota");
  });
});
