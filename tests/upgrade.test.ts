import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Executor } from "../src/deps.js";
import {
  buildUpgradeHandoff,
  checkUpgradeInventory,
  continueUpgradeInNewRelease,
  describeSyncVsUpgrade,
  discoverAvailableAriaTarget,
  formatUpgradeCheck,
  formatUpgradeReport,
  isHandoffMatch,
  parseAriaRemoteRefs,
  PROCESS_LOCAL_GIT_ENV,
  runUpgrade,
  UPGRADE_COMPONENTS,
  validateAriaTargetForRemoval,
  type AriaAvailableTarget,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T010 upgrade CLI + shared orchestration: read-only inventory, approval
// gating, unknown-target blocking, handoff order/mismatch, per-component
// failure states, and before/after reporting.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-upgrade-"));
  tempDirs.push(root);
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  return { root, configDir };
}

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

const LS_REMOTE_SAMPLE = [
  "aaa111\trefs/tags/v1.0.6",
  "bbb222\trefs/tags/v1.0.7",
  "bbb222\trefs/tags/v1.0.7^{}",
  "ccc333\trefs/heads/main",
  "ddd444\trefs/tags/v1.0.8-rc.1",
  "eee555\trefs/tags/latest",
  "",
].join("\n");

const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

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

function expectReadOnly(calls: string[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(READ_ONLY_CALLS.has(call), `non-read-only call during inventory: ${call}`).toBe(true);
  }
}

const HEALTHY_MCP_LIST = ["MCP Servers", "engram connected", "context7 connected", "codegraph connected"].join("\n");

function pluginList(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

describe("T010 ARIA release discovery", () => {
  it("parses the newest exact vX.Y.Z tag, ignoring deref lines, branches, prereleases, and moving tags", () => {
    expect(parseAriaRemoteRefs(LS_REMOTE_SAMPLE)).toEqual(TARGET_107);
  });

  it("returns null when no exact release tag is observed (never guessed)", () => {
    expect(parseAriaRemoteRefs("aaa\trefs/heads/main\nddd\trefs/tags/v1.0.8-rc.1\neee\trefs/tags/latest\n")).toBeNull();
    expect(parseAriaRemoteRefs("")).toBeNull();
  });

  it("reports unknown (not guessed) when git ls-remote fails", async () => {
    const calls: string[] = [];
    const discovery = await discoverAvailableAriaTarget(probeExecutor({}, calls));
    expect(discovery.kind).toBe("unknown");
    expect(calls).toEqual(["git ls-remote https://github.com/mscipio/ARIA.git"]);
  });

  it("validates the exact target before removal and fails closed on unknown/misshapen targets", () => {
    expect(validateAriaTargetForRemoval(TARGET_107)).toEqual({ ok: true });
    expect(validateAriaTargetForRemoval(null).ok).toBe(false);
    expect(validateAriaTargetForRemoval({ tag: "v1.0.7", version: "1.0.7", spec: "github:evil/ARIA#v1.0.7" }).ok).toBe(false);
    expect(validateAriaTargetForRemoval({ tag: "latest", version: "latest", spec: "github:mscipio/ARIA#latest" }).ok).toBe(false);
  });
});

describe("T010 --check inventory (strictly read-only)", () => {
  it("uses only read-only probes and writes nothing under the XDG-contained config dir", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }),
      "utf8",
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST, engramVersion: "engram 1.20.0", codegraphVersion: "codegraph 1.3.1" }, calls),
      { configDir, currentVersion: "1.0.6" },
    );
    expectReadOnly(calls);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
    expect(result.components.map((row) => row.component)).toEqual([...UPGRADE_COMPONENTS]);
    expect(result.components.find((row) => row.component === "aria")?.status).toBe("upgrade-available");
    expect(result.components.find((row) => row.component === "context7")?.status).toBe("remote-healthy");
  });

  it("reports current AND available ARIA releases plus the Component|Installed|Available|Status table", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls),
      { configDir, currentVersion: "1.0.6" },
    );
    const text = formatUpgradeCheck(result);
    expect(text).toContain("Current release: 1.0.6");
    expect(text).toContain("Available release: v1.0.7 (github:mscipio/ARIA#v1.0.7)");
    for (const token of ["Component", "Installed", "Available", "Status"]) expect(text).toContain(token);
    for (const name of UPGRADE_COMPONENTS) expect(text).toContain(name);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("delegates the quota row to the T007 read-only inventory vocabulary", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const quotaSpec = "@slkiser/opencode-quota@5.0.2";
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugins: [quotaSpec] }), "utf8");
    const calls: string[] = [];
    const result = await checkUpgradeInventory(
      probeExecutor(
        { pluginList: pluginList([["@slkiser/opencode-quota.server", "5.0.2", quotaSpec]]), mcpList: HEALTHY_MCP_LIST },
        calls,
      ),
      { configDir, currentVersion: "1.0.6", availableOverride: TARGET_107 },
    );
    const quota = result.components.find((row) => row.component === "quota");
    expect(quota?.status).toBe("unmanaged-observed");
    expect(quota?.installed).toBe("5.0.2");
  });
});

describe("T010 approval gate and unknown-target block", () => {
  it("requires explicit approval before any mutation", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const result = await runUpgrade(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls),
      { configDir, currentVersion: "1.0.6", approval: { yes: false } },
    );
    expect(result.stage).toBe("blocked-approval");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("--yes");
    expectReadOnly(calls);
  });

  it("blocks self-upgrade with zero mutation when the available target is unknown", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const result = await runUpgrade(probeExecutor({}, calls), { configDir, currentVersion: "1.0.6", approval: { yes: true } });
    expect(result.stage).toBe("blocked-unknown-target");
    expect(result.ok).toBe(false);
    expect(result.check.selfUpgradeBlocked).toBe(true);
    expectReadOnly(calls);
  });

  it("short-circuits already-current with zero mutation", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const result = await runUpgrade(probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls), {
      configDir,
      currentVersion: "1.0.7",
      approval: { yes: true },
    });
    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(true);
    expectReadOnly(calls);
  });
});

describe("T010 handoff order and old-code-stops", () => {
  it("validates the exact target, binds it plus the approved inventory, then stops after handoff", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const seen: Array<{ target: AriaAvailableTarget; componentCount: number }> = [];
    const result = await runUpgrade(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls),
      {
        configDir,
        currentVersion: "1.0.6",
        approval: { yes: true },
        selfUpgradeFn: async (target, handoff) => {
          seen.push({ target, componentCount: handoff.approvedComponents.length });
          const matched = isHandoffMatch(handoff, target, handoff.approvedComponents);
          expect(matched).toEqual({ match: true });
          return { ok: true, detail: "replaced", handoffNote: "new release owns the remainder" };
        },
      },
    );
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target.spec).toBe("github:mscipio/ARIA#v1.0.7");
    expect(result.handoff?.target.spec).toBe("github:mscipio/ARIA#v1.0.7");
    expect([...(result.handoff?.approvedComponents ?? [])].sort()).toEqual([...UPGRADE_COMPONENTS].sort());
    // Old code performs no post-handoff phases: no outcomes/report keys, probes stay read-only.
    expect("outcomes" in result).toBe(false);
    expect("report" in result).toBe(false);
    expectReadOnly(calls);
  });

  it("reports pre-handoff self-upgrade failure exactly with no further phases", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const result = await runUpgrade(
      probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls),
      {
        configDir,
        currentVersion: "1.0.6",
        approval: { yes: true },
        selfUpgradeFn: async () => ({ ok: false, detail: "remove failed: network down", registration: "original registration intact" }),
      },
    );
    expect(result.stage).toBe("self-upgrade-failed");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("original registration intact");
    expect("outcomes" in result).toBe(false);
    expectReadOnly(calls);
  });
});

describe("T010 new-release continuation gate", () => {
  async function matchedHandoff(): Promise<{ target: AriaAvailableTarget; components: string[]; before: Awaited<ReturnType<typeof checkUpgradeInventory>> }> {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const before = await checkUpgradeInventory(probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls), {
      configDir,
      currentVersion: "1.0.6",
    });
    return { target: TARGET_107, components: before.components.map((row) => row.component), before };
  }

  it("stops for fresh approval on target drift with zero component work", async () => {
    const { target, components, before } = await matchedHandoff();
    const handoff = buildUpgradeHandoff(target, before);
    const drifted: AriaAvailableTarget = { tag: "v1.0.8", version: "1.0.8", spec: "github:mscipio/ARIA#v1.0.8" };
    const result = await continueUpgradeInNewRelease(handoff, drifted, components, {
      components: { quota: async () => { throw new Error("component must not run on drift"); } },
    });
    expect(result.stage).toBe("drift-blocked");
    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([]);
    expect(result.report).toBe("");
  });

  it("stops for fresh approval on scope drift with zero component work", async () => {
    const { target, before } = await matchedHandoff();
    const handoff = buildUpgradeHandoff(target, before);
    let called = 0;
    const result = await continueUpgradeInNewRelease(handoff, target, ["aria", "quota"], {
      components: { quota: async () => { called++; return { component: "quota", status: "completed", detail: "x", mutated: true }; } },
    });
    expect(called).toBe(0);
    expect(result.stage).toBe("drift-blocked");
    expect(result.outcomes).toEqual([]);
  });

  it("stops on component failure with per-component states and no global rollback", async () => {
    const { target, components, before } = await matchedHandoff();
    const handoff = buildUpgradeHandoff(target, before);
    const result = await continueUpgradeInNewRelease(handoff, target, components, {
      components: {
        engram: async () => ({ component: "engram", status: "completed", detail: "engram upgraded", mutated: true }),
        context7: async () => ({ component: "context7", status: "unresolved", detail: "context7 boom", mutated: false }),
      },
      depsSyncFn: async () => ({ ok: true, detail: "must not run", mutated: false }),
    });
    expect(result.stage).toBe("component-stopped");
    expect(result.ok).toBe(false);
    const byName = new Map(result.outcomes.map((outcome) => [outcome.component, outcome]));
    // Completed work stays completed (no global transactionality).
    expect(byName.get("engram")?.status).toBe("completed");
    expect(byName.get("context7")?.status).toBe("unresolved");
    // Unattempted work reports skipped, never runs.
    expect(byName.get("quota")?.status).toBe("skipped");
    expect(byName.get("quota")?.detail).toContain("not attempted");
    // Before/after report travels with the stop.
    expect(result.report).toContain("Before:");
    expect(result.report).toContain("After:");
    expect(result.report).toContain("after engram: completed");
  });

  it("completes through stubbed post phases with a before/after report", async () => {
    const { target, components, before } = await matchedHandoff();
    const handoff = buildUpgradeHandoff(target, before);
    const result = await continueUpgradeInNewRelease(handoff, target, components, {
      // T017: continuation defaults are now the real shared lifecycle; stub
      // all five to isolate the post-phase path (pre-T017 only quota needed
      // a stub because the rest defaulted report-only).
      components: {
        engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
        context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
        codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
        zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
        quota: async () => ({ component: "quota", status: "skipped", detail: "nothing installed", mutated: false }),
      },
      normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: true }),
      regenFn: async () => ({ ok: true, detail: "no regen required", mutated: false }),
      depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: true }),
      doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
    });
    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    const report = formatUpgradeReport(before, result.outcomes);
    expect(report).toContain("Before: ARIA 1.0.6");
    expect(report).toContain("After:");
    expect(result.report).toContain("Before:");
  });
});

describe("T010 sync vs upgrade definition and process-local git env", () => {
  it("defines normalize-current sync versus approval-gated upgrade phases in order", () => {
    const definition = describeSyncVsUpgrade();
    expect(definition.sync.idempotent).toBe(true);
    expect(definition.sync.quotaExcluded).toBe(true);
    expect(definition.sync.approvalRequired).toBe(false);
    expect(definition.upgrade.approvalRequired).toBe(true);
    expect(definition.upgrade.phases.indexOf("inventory (read-only --check)")).toBeLessThan(
      definition.upgrade.phases.indexOf("explicit approval (--yes)"),
    );
    expect(definition.upgrade.phases.indexOf("validate ARIA target before removal")).toBeLessThan(
      definition.upgrade.phases.indexOf("T011 self-upgrade plus bounded handoff"),
    );
  });

  it("keeps the git allowlist process-local and never assigns process.env", async () => {
    expect(PROCESS_LOCAL_GIT_ENV).toEqual({ NPM_CONFIG_ALLOW_GIT: "all" });
    const hadKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    await checkUpgradeInventory(probeExecutor({ lsRemote: LS_REMOTE_SAMPLE, mcpList: HEALTHY_MCP_LIST }, calls), {
      configDir,
      currentVersion: "1.0.6",
    });
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadKey);
  });
});
