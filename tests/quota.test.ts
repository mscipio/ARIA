import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { depsSync, type Executor } from "../src/deps.js";
import { openCodeGlobalDir } from "../src/paths.js";
import {
  checkQuotaUpgrade,
  describeQuotaSpec,
  identifyQuotaTarget,
  QUOTA_PLUGIN_ID,
  quotaEntriesFromPluginList,
  quotaSpecsFromConfig,
  upgradeQuota,
} from "../src/quota.js";

// ---------------------------------------------------------------------------
// T007 Quota dual policy: setup/sync exclusion + upgrade-only adapter.
//
// - Setup and `deps sync` never install, upgrade, or mutate Quota state.
// - `aria upgrade` (this adapter) upgrades an already-installed Quota 5 ONLY
//   through a positively identified target plus a demonstrated-safe native
//   update, preserving TUI+server surfaces; unknown/unsafe targets stay
//   observed/unmanaged with zero mutation.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Snapshot every file's bytes under a directory (recursive). */
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

const QUOTA_SPEC_502 = "@slkiser/opencode-quota@5.0.2";

function pluginList(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

function quotaRow(version = "5.0.2", source: string = QUOTA_SPEC_502): [string, string, string] {
  return [QUOTA_PLUGIN_ID, version, source];
}

function configWithPlugins(plugins: unknown[]): string {
  return JSON.stringify({
    mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } },
    plugins,
  });
}

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-quota-"));
  tempDirs.push(root);
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  return { root, configDir };
}

function healthySyncExecutor(calls: string[]): Executor {
  const home = homedir();
  const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
  const healthyList = [
    "MCP Servers",
    "engram connected", "engram mcp --tools=agent",
    "context7 connected", "https://mcp.context7.com/mcp",
    "codegraph connected", "codegraph serve --mcp",
    "3 server(s)",
  ].join("\n");
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
    if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
    if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
    if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
    if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
    if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
    if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
    if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
    if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: healthyList, stderr: "" };
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
}

function hasQuotaCall(calls: string[]): boolean {
  return calls.some((call) => call.toLowerCase().includes("quota") || call.includes("@slkiser"));
}

describe("T007 setup/sync exclusion", () => {
  it("depsSync carries no quota plan and invokes no quota commands", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), configWithPlugins(["github:mscipio/ARIA#abc"]));
    const calls: string[] = [];

    const result = await depsSync(healthySyncExecutor(calls), configDir);

    expect("quota" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["codegraph", "context7", "engram", "health", "ok"]);
    expect(hasQuotaCall(calls)).toBe(false);
  });

  it("depsSync leaves an isolated config with a quota entry byte-identical", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      configWithPlugins(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];

    await depsSync(healthySyncExecutor(calls), configDir);

    expect(hasQuotaCall(calls)).toBe(false);
    await expectByteIdentical(root, before);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written.plugins).toEqual(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]);
  });
});

describe("T007 quota target identification (pure)", () => {
  it("classifies npm specs and rejects forks and foreign channels", () => {
    expect(describeQuotaSpec(QUOTA_SPEC_502)).toEqual({ spec: QUOTA_SPEC_502, channel: "npm", version: "5.0.2" });
    expect(describeQuotaSpec("@slkiser/opencode-quota")).toEqual({
      spec: "@slkiser/opencode-quota",
      channel: "npm",
      version: null,
    });
    expect(describeQuotaSpec("@slkiser/opencode-quota@latest")).toEqual({
      spec: "@slkiser/opencode-quota@latest",
      channel: "npm",
      version: "latest",
    });
    expect(describeQuotaSpec("github:foo/opencode-quota#abc")).toBeNull();
    expect(describeQuotaSpec("/home/u/libs/@slkiser/opencode-quota")).toEqual({
      spec: "/home/u/libs/@slkiser/opencode-quota",
      channel: "foreign",
      version: null,
    });
    expect(describeQuotaSpec("/home/u/quota")).toBeNull();
    expect(describeQuotaSpec("@slkiser/opencode-quota-extra@1.0.0")).toBeNull();
    expect(describeQuotaSpec("github:mscipio/ARIA#abc")).toBeNull();
  });

  it("identifies exactly one exact 5.x spec and fails closed otherwise", () => {
    expect(identifyQuotaTarget([QUOTA_SPEC_502], [QUOTA_SPEC_502])).toEqual({
      kind: "identified",
      spec: QUOTA_SPEC_502,
      version: "5.0.2",
    });
    expect(identifyQuotaTarget([], [])).toEqual({ kind: "absent" });
    expect(identifyQuotaTarget(["@slkiser/opencode-quota"], [])).toMatchObject({ kind: "unknown-target" });
    expect(identifyQuotaTarget(["@slkiser/opencode-quota@latest"], [])).toMatchObject({ kind: "unknown-target" });
    expect(identifyQuotaTarget(["/home/u/libs/@slkiser/opencode-quota"], [])).toMatchObject({
      kind: "unsupported-ownership",
    });
    expect(identifyQuotaTarget(["@slkiser/opencode-quota@4.10.8"], [])).toMatchObject({ kind: "unsupported-ownership" });
    expect(identifyQuotaTarget([QUOTA_SPEC_502], ["@slkiser/opencode-quota@5.0.3"])).toMatchObject({
      kind: "unknown-target",
    });
  });

  it("parses plugin list quota rows and rejects unrecognized output", () => {
    expect(quotaEntriesFromPluginList(pluginList([["aria", "local", "/repo"], quotaRow()]))).toEqual([
      { id: QUOTA_PLUGIN_ID, version: "5.0.2", target: QUOTA_SPEC_502 },
    ]);
    expect(quotaEntriesFromPluginList("No plugins found")).toEqual([]);
    expect(quotaEntriesFromPluginList("garbage output")).toBeNull();
  });

  it("reads quota specs from string, tuple, and package-object entries", () => {
    expect(
      quotaSpecsFromConfig({
        plugins: [QUOTA_SPEC_502, ["github:mscipio/ARIA#abc", {}], { package: "@slkiser/opencode-quota@5.0.1" }],
      }),
    ).toEqual([QUOTA_SPEC_502, "@slkiser/opencode-quota@5.0.1"]);
    expect(quotaSpecsFromConfig({ plugin: [QUOTA_SPEC_502] })).toEqual([QUOTA_SPEC_502]);
    expect(quotaSpecsFromConfig({ plugins: ["github:mscipio/ARIA#abc"] })).toEqual([]);
    expect(quotaSpecsFromConfig(null)).toEqual([]);
  });
});

describe("T007 checkQuotaUpgrade (read-only)", () => {
  function checkExecutor(listStdout: string | null): { calls: string[]; executor: Executor } {
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[0] === "plugin") {
        if (listStdout === null) throw new Error("opencode plugin list failed");
        return { stdout: listStdout, stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    return { calls, executor };
  }

  it("reports skipped when nothing is installed and creates no files", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const { calls, executor } = checkExecutor(pluginList([]));

    const result = await checkQuotaUpgrade(executor, configDir);

    expect(result.status).toBe("skipped");
    expect(calls).toEqual(["opencode plugin list"]);
    expect((await snapshotTree(root)).size).toBe(0);
  });

  it("reports unmanaged-observed for identified Quota 5 without mutation", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      configWithPlugins(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]),
    );
    const before = await snapshotTree(root);
    const { calls, executor } = checkExecutor(pluginList([quotaRow()]));

    const result = await checkQuotaUpgrade(executor, configDir);

    expect(result.status).toBe("unmanaged-observed");
    expect(result.installedSpec).toBe(QUOTA_SPEC_502);
    expect(result.installedVersion).toBe("5.0.2");
    expect(calls).toEqual(["opencode plugin list"]);
    await expectByteIdentical(root, before);
  });

  it("fails closed on dual-file ambiguity with neither file mutated", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), configWithPlugins([QUOTA_SPEC_502]));
    await writeFile(resolve(configDir, "opencode.jsonc"), configWithPlugins([QUOTA_SPEC_502]));
    const before = await snapshotTree(root);
    const { calls, executor } = checkExecutor(pluginList([quotaRow()]));

    const result = await checkQuotaUpgrade(executor, configDir);

    expect(result.status).toBe("unknown-target");
    expect(calls).toEqual(["opencode plugin list"]);
    await expectByteIdentical(root, before);
  });

  it("reports unsupported-ownership for a foreign channel with zero mutation", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const foreign = "/home/u/libs/@slkiser/opencode-quota";
    await writeFile(resolve(configDir, "opencode.json"), configWithPlugins([foreign]));
    const before = await snapshotTree(root);
    const { calls, executor } = checkExecutor(pluginList([["quota-local", "5.0.2", foreign]]));

    const result = await checkQuotaUpgrade(executor, configDir);

    expect(result.status).toBe("unsupported-ownership");
    expect(calls).toEqual(["opencode plugin list"]);
    await expectByteIdentical(root, before);
  });
});

describe("T007 upgradeQuota (gated)", () => {
  let savedXdg: string | undefined;

  beforeEach(async () => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    const root = await mkdtemp(resolve(tmpdir(), "rdc-quota-xdg-"));
    tempDirs.push(root);
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  async function seedGlobalConfig(plugins: unknown[]): Promise<string> {
    const dir = openCodeGlobalDir();
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, "opencode.json");
    await writeFile(path, configWithPlugins(plugins));
    return path;
  }

  interface UpgradeScenario {
    listOutputs: string[];
    openCodeVersion: string | null;
    previewOk: boolean;
    apply: () => Promise<void>;
  }

  function upgradeExecutor(scenario: UpgradeScenario, calls: string[]): Executor {
    let lists = 0;
    return async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[0] === "plugin") {
        const output = scenario.listOutputs[Math.min(lists, scenario.listOutputs.length - 1)];
        lists += 1;
        if (output === undefined) throw new Error("opencode plugin list failed");
        return { stdout: output, stderr: "" };
      }
      if (command === "opencode" && args[0] === "--version") {
        if (scenario.openCodeVersion === null) throw new Error("opencode not found");
        return { stdout: scenario.openCodeVersion, stderr: "" };
      }
      if (command === "opencode-quota" && args[0] === "update" && args[1] === "--dry-run") {
        if (!scenario.previewOk) throw new Error("preview failed: unparseable config");
        return {
          stdout: [
            "Responsible OpenCode Quota update preview",
            "Safe changes this command can make:",
            "  edit <config> (1 package replacement)",
            "No configuration or package-cache changes have been made yet.",
          ].join("\n"),
          stderr: "",
        };
      }
      if (command === "opencode-quota" && args[0] === "update" && args[1] === "--yes") {
        await scenario.apply();
        return { stdout: "OpenCode Quota update complete.", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
  }

  const noApply: () => Promise<void> = async () => {
    throw new Error("updater must not run on a gated path");
  };

  it("skips when nothing is installed with zero mutation", async () => {
    const configPath = await seedGlobalConfig(["github:mscipio/ARIA#abc"]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor({ listOutputs: [pluginList([])], openCodeVersion: "opencode 2.0.23", previewOk: true, apply: noApply }, calls),
    );

    expect(result.status).toBe("skipped");
    expect(result.mutated).toBe(false);
    expect(hasQuotaCall(calls)).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("leaves unversioned targets report-only with zero mutation", async () => {
    const configPath = await seedGlobalConfig(["@slkiser/opencode-quota"]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([[QUOTA_PLUGIN_ID, "5.0.2", "@slkiser/opencode-quota"]])],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: noApply,
        },
        calls,
      ),
    );

    expect(result.status).toBe("unknown-target");
    expect(result.mutated).toBe(false);
    expect(hasQuotaCall(calls)).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("leaves Quota 5 untouched on OpenCode 1 (native updater would pin @4)", async () => {
    const configPath = await seedGlobalConfig(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([quotaRow()])],
          openCodeVersion: "opencode 1.18.35",
          previewOk: true,
          apply: noApply,
        },
        calls,
      ),
    );

    expect(result.status).toBe("unmanaged-observed");
    expect(result.installedVersion).toBe("5.0.2");
    expect(result.mutated).toBe(false);
    expect(hasQuotaCall(calls)).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("stays report-only when the native preview is unavailable", async () => {
    const configPath = await seedGlobalConfig([QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([quotaRow()])],
          openCodeVersion: "opencode 2.0.23",
          previewOk: false,
          apply: noApply,
        },
        calls,
      ),
    );

    expect(result.status).toBe("unmanaged-observed");
    expect(result.mutated).toBe(false);
    expect(calls).not.toContain("opencode-quota update --yes");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("upgrades identified Quota 5 and preserves TUI+server surfaces", async () => {
    const configPath = await seedGlobalConfig(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [
            pluginList([quotaRow()]),
            pluginList([[QUOTA_PLUGIN_ID, "5.0.3", "@slkiser/opencode-quota@latest"]]),
          ],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: async () => {
            // Simulate the native updater rewriting the exact pin to the moving spec.
            const raw = await readFile(configPath, "utf8");
            await writeFile(configPath, raw.replace(QUOTA_SPEC_502, "@slkiser/opencode-quota@latest"));
          },
        },
        calls,
      ),
    );

    expect(result.status).toBe("upgraded");
    expect(result.mutated).toBe(true);
    expect(result.installedSpec).toBe(QUOTA_SPEC_502);
    expect(result.resultingSpec).toBe("@slkiser/opencode-quota@latest");
    expect(calls).toContain("opencode-quota update --dry-run");
    expect(calls).toContain("opencode-quota update --yes");
    expect(await readFile(configPath, "utf8")).not.toBe(before);
    // Surfaces preserved: quota entry kept, unrelated entries byte-level preserved.
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.plugins).toEqual(["github:mscipio/ARIA#abc", "@slkiser/opencode-quota@latest"]);
    expect(written.mcp.servers.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
  });

  it("reports already-current when the native update changes nothing", async () => {
    const configPath = await seedGlobalConfig(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];
    const list = pluginList([quotaRow()]);

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [list, list],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: async () => {},
        },
        calls,
      ),
    );

    expect(result.status).toBe("already-current");
    expect(result.mutated).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("rolls the global config back when validation fails", async () => {
    const configPath = await seedGlobalConfig(["github:mscipio/ARIA#abc", QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([quotaRow()]), "No plugins found"],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: async () => {
            // Simulated breakage: the quota entry is dropped from the config.
            const raw = JSON.parse(await readFile(configPath, "utf8"));
            raw.plugins = ["github:mscipio/ARIA#abc"];
            await writeFile(configPath, JSON.stringify(raw));
          },
        },
        calls,
      ),
    );

    expect(result.status).toBe("validation-failed");
    expect(result.rolledBack).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("rolls the global config back when the native apply fails", async () => {
    const configPath = await seedGlobalConfig([QUOTA_SPEC_502]);
    const before = await readFile(configPath, "utf8");
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([quotaRow()])],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: async () => {
            await writeFile(configPath, "{ partial write");
            throw new Error("update crashed mid-apply");
          },
        },
        calls,
      ),
    );

    expect(result.status).toBe("update-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("refuses a mutating update against a divergent explicit config dir", async () => {
    await seedGlobalConfig([QUOTA_SPEC_502]);
    const other = await mkdtemp(resolve(tmpdir(), "rdc-quota-other-"));
    tempDirs.push(other);
    const calls: string[] = [];

    const result = await upgradeQuota(
      upgradeExecutor(
        {
          listOutputs: [pluginList([quotaRow()])],
          openCodeVersion: "opencode 2.0.23",
          previewOk: true,
          apply: noApply,
        },
        calls,
      ),
      { configDir: other },
    );

    expect(result.status).toBe("unmanaged-observed");
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
  });
});
