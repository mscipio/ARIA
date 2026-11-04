import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps";
import {
  checkQuotaUpgrade,
  compareDotted,
  discoverQuotaTarget,
  identifyQuotaTarget,
  observedQuotaSpecs,
  QUOTA_MAJOR,
  QUOTA_MIN_NODE,
  QUOTA_MIN_OPENCODE,
  QUOTA_PLUGIN_ID,
  quotaNodeGate,
  quotaOpenCodeGate,
  upgradeQuota,
} from "../src/quota";
import { installQuotaIfMissing } from "../src/bootstrap";

// Quota 6 adapter. The native OpenCode commands are simulated: `plugin update
// <target>` changes only the Quota entry and its runtime version, as the
// documented command does. Every mutation runs against a temp XDG root.

const PACKAGE = "@slkiser/opencode-quota";

let root: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aria-quota6-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  await mkdir(join(root, "xdg", "opencode"), { recursive: true });
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(root, { recursive: true, force: true });
});

interface SimState {
  listVersion: string;
  latest: string | null;
  nodeVersion: string;
  opencodeVersion: string;
  plugins: unknown[];
  updateBehavior: "apply" | "fail" | "corrupt-unrelated" | "ignore";
}

function configPath(): string {
  return join(root, "xdg", "opencode", "opencode.json");
}

function pluginList(state: SimState): string {
  return [
    "ID                              VERSION  SOURCE",
    `@slkiser/opencode-quota.server  ${state.listVersion}    ${PACKAGE}`,
    "aria                            local    /opt/aria",
    "engram                          local    /home/u/.config/opencode/plugins/engram.ts",
  ].join("\n");
}

/** Simulated OpenCode/npm/node surface; records every call for argv assertions. */
function simulated(state: SimState): { executor: Executor; calls: string[] } {
  const calls: string[] = [];
  const executor: Executor = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    if (command === "node" && args[0] === "--version") return { stdout: `${state.nodeVersion}\n`, stderr: "" };
    if (command === "opencode" && args[0] === "--version") return { stdout: `${state.opencodeVersion}\n`, stderr: "" };
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") return { stdout: pluginList(state), stderr: "" };
    if (command === "npm" && args[0] === "view" && args[1] === PACKAGE && args[2] === "dist-tags") {
      if (state.latest === null) throw new Error("registry unavailable");
      return { stdout: JSON.stringify([{ next: state.latest, latest: state.latest }], null, 2), stderr: "" };
    }
    if (command === "opencode" && args[0] === "plugin" && args[1] === "update") {
      if (args.length !== 3 || args[2] !== PACKAGE) throw new Error(`bare or foreign plugin update refused in test: ${key}`);
      if (state.updateBehavior === "fail") throw new Error("network error during update");
      if (state.updateBehavior === "ignore") return { stdout: "", stderr: "" };
      if (state.latest !== null) state.listVersion = state.latest;
      const current = JSON.parse(await readFile(configPath(), "utf8")) as { plugins: unknown[] };
      current.plugins = state.updateBehavior === "corrupt-unrelated"
        ? current.plugins.filter((entry) => entry !== "/opt/aria").concat(["/opt/other"])
        : current.plugins;
      await writeFile(configPath(), JSON.stringify(current, null, 2));
      return { stdout: "updated", stderr: "" };
    }
    throw new Error(`unexpected in test: ${key}`);
  };
  return { executor, calls };
}

async function writeConfig(plugins: unknown[]): Promise<void> {
  await writeFile(
    configPath(),
    JSON.stringify({ plugins, mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }, provider: { keep: true } }, null, 2),
  );
}

function state(overrides: Partial<SimState> = {}): SimState {
  return {
    listVersion: "6.0.0",
    latest: "6.1.0",
    nodeVersion: "v24.18.0",
    opencodeVersion: "2.2.5",
    plugins: [PACKAGE, "/opt/aria"],
    updateBehavior: "apply",
    ...overrides,
  };
}

const NO_DELAY = { delay: async (_ms: number) => undefined, convergence: { attempts: 2, delayMs: 0 } };

describe("version ordering and runtime gates", () => {
  it("orders dotted versions", () => {
    expect(compareDotted("6.1.0", "6.0.9")).toBeGreaterThan(0);
    expect(compareDotted("6.0.0", "6.0.0")).toBe(0);
    expect(compareDotted("5.9.9", "6.0.0")).toBeLessThan(0);
  });

  it("refuses Node below the Quota 6 terminal-command floor with an explanation", async () => {
    expect(QUOTA_MIN_NODE).toBe("22.13.0");
    const old = await quotaNodeGate(simulated(state({ nodeVersion: "v20.19.0" })).executor);
    expect(old.ok).toBe(false);
    expect(old.ok === false && old.reason).toContain("ARIA declares Node >=20.19");
    expect((await quotaNodeGate(simulated(state({ nodeVersion: "v22.12.9" })).executor)).ok).toBe(false);
    expect((await quotaNodeGate(simulated(state({ nodeVersion: "v22.13.0" })).executor)).ok).toBe(true);
    expect((await quotaNodeGate(simulated(state({ nodeVersion: "v24.18.0" })).executor)).ok).toBe(true);
  });

  it("refuses an undetectable Node runtime instead of assuming compatibility", async () => {
    const executor: Executor = async () => {
      throw new Error("not found");
    };
    expect((await quotaNodeGate(executor)).ok).toBe(false);
  });

  it("requires the documented OpenCode minimum", async () => {
    expect(QUOTA_MIN_OPENCODE).toBe("2.0.26");
    expect((await quotaOpenCodeGate(simulated(state({ opencodeVersion: "2.0.25" })).executor)).ok).toBe(false);
    expect((await quotaOpenCodeGate(simulated(state({ opencodeVersion: "2.0.26" })).executor)).ok).toBe(true);
    expect((await quotaOpenCodeGate(simulated(state({ opencodeVersion: "2.2.5" })).executor)).ok).toBe(true);
  });
});

describe("discovery and identification", () => {
  it("reads the latest release from npm dist-tags, accepting npm's array wrapper", async () => {
    const result = await discoverQuotaTarget(simulated(state({ latest: "6.1.0" })).executor);
    expect(result).toEqual({ ok: true, version: "6.1.0" });
  });

  it("refuses a latest release outside the supported major", async () => {
    const result = await discoverQuotaTarget(simulated(state({ latest: "7.0.0" })).executor);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(`only Quota ${QUOTA_MAJOR}`);
  });

  it("refuses unavailable or malformed dist-tags", async () => {
    expect((await discoverQuotaTarget(simulated(state({ latest: null })).executor)).ok).toBe(false);
    const malformed: Executor = async () => ({ stdout: "not json", stderr: "" });
    expect((await discoverQuotaTarget(malformed)).ok).toBe(false);
  });

  it("identifies an unpinned config entry by the runtime version the plugin list reports", () => {
    const observed = observedQuotaSpecs([{ id: QUOTA_PLUGIN_ID, version: "6.1.0", target: PACKAGE }], [PACKAGE]);
    expect(observed.listSpecs).toEqual([`${PACKAGE}@6.1.0`]);
    expect(identifyQuotaTarget(observed.listSpecs, observed.configSpecs)).toEqual({
      kind: "identified",
      spec: `${PACKAGE}@6.1.0`,
      version: "6.1.0",
    });
  });

  it("fails closed when a config pin disagrees with the runtime version", () => {
    const observed = observedQuotaSpecs([{ id: QUOTA_PLUGIN_ID, version: "6.1.0", target: PACKAGE }], [`${PACKAGE}@6.0.0`]);
    expect(identifyQuotaTarget(observed.listSpecs, observed.configSpecs).kind).toBe("unknown-target");
  });

  it("reports an installed Quota 5 as outside the supported major, not as an update target", async () => {
    await writeConfig([`${PACKAGE}@5.0.3`]);
    const { executor } = simulated(state({ listVersion: "5.0.3" }));
    const check = await checkQuotaUpgrade(executor);
    expect(check.status).toBe("unsupported-ownership");
    expect(check.detail).toContain(`only Quota ${QUOTA_MAJOR}`);
  });

  it("reports a clean system as absent and creates nothing", async () => {
    const empty: Executor = async (command, args) => {
      if (command === "opencode" && args[1] === "list") return { stdout: "No plugins found", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const check = await checkQuotaUpgrade(empty);
    expect(check.status).toBe("skipped");
  });
});

describe("native targeted update", () => {
  it("is a no-op when the installed Quota 6 is already the latest", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const { executor, calls } = simulated(state({ listVersion: "6.1.0", latest: "6.1.0" }));
    const result = await upgradeQuota(executor, NO_DELAY);
    expect(result).toMatchObject({ status: "already-current", mutated: false });
    expect(calls.some((call) => call.startsWith("opencode plugin update"))).toBe(false);
  });

  it("updates an outdated Quota 6 with the targeted native command only", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const { executor, calls } = simulated(state());
    const result = await upgradeQuota(executor, NO_DELAY);
    expect(result).toMatchObject({ status: "upgraded", mutated: true, installedVersion: "6.0.0" });
    expect(result.detail).toContain("6.1.0");
    expect(calls.filter((call) => call.startsWith("opencode plugin update"))).toEqual([
      `opencode plugin update ${PACKAGE}`,
    ]);
    // Never the bare form (which updates every plugin) and never the obsolete Quota CLI.
    expect(calls.some((call) => call === "opencode plugin update")).toBe(false);
    expect(calls.some((call) => call.startsWith("opencode-quota"))).toBe(false);
  });

  it("preserves unrelated plugins, provider settings, and the rest of the config", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const before = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
    await upgradeQuota(simulated(state()).executor, NO_DELAY);
    const after = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
    expect(after.plugins).toEqual(before.plugins);
    expect(after.provider).toEqual({ keep: true });
    expect(after.mcp).toEqual(before.mcp);
  });

  it("never downgrades an installed Quota newer than the discovered release", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const { executor, calls } = simulated(state({ listVersion: "6.2.0", latest: "6.1.0" }));
    const result = await upgradeQuota(executor, NO_DELAY);
    expect(result.status).toBe("unknown-target");
    expect(result.detail).toContain("never downgraded");
    expect(calls.some((call) => call.startsWith("opencode plugin update"))).toBe(false);
  });

  it("refuses to update on Node below the floor, with zero update calls", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const { executor, calls } = simulated(state({ nodeVersion: "v20.19.0" }));
    const result = await upgradeQuota(executor, NO_DELAY);
    expect(result).toMatchObject({ status: "unmanaged-observed", mutated: false });
    expect(result.detail).toContain("ARIA declares Node >=20.19");
    expect(calls.some((call) => call.startsWith("opencode plugin update"))).toBe(false);
  });

  it("refuses to update on an older OpenCode, with zero update calls", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const { executor, calls } = simulated(state({ opencodeVersion: "2.0.20" }));
    const result = await upgradeQuota(executor, NO_DELAY);
    expect(result.status).toBe("unmanaged-observed");
    expect(calls.some((call) => call.startsWith("opencode plugin update"))).toBe(false);
  });

  it("restores the config and reports update-failed when the native update fails", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const bytes = await readFile(configPath(), "utf8");
    const result = await upgradeQuota(simulated(state({ updateBehavior: "fail" })).executor, NO_DELAY);
    expect(result).toMatchObject({ status: "update-failed", mutated: true, rolledBack: true });
    expect(await readFile(configPath(), "utf8")).toBe(bytes);
  });

  it("rolls back when an unrelated plugin entry changed during the update", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const bytes = await readFile(configPath(), "utf8");
    const result = await upgradeQuota(simulated(state({ updateBehavior: "corrupt-unrelated" })).executor, NO_DELAY);
    expect(result.status).toBe("validation-failed");
    expect(result.detail).toContain("unrelated global plugin entries changed");
    expect(await readFile(configPath(), "utf8")).toBe(bytes);
  });

  it("fails validation when the runtime never reaches the target version", async () => {
    await writeConfig([PACKAGE, "/opt/aria"]);
    const result = await upgradeQuota(simulated(state({ updateBehavior: "ignore" })).executor, NO_DELAY);
    expect(result.status).toBe("validation-failed");
    expect(result.detail).toContain("still reports Quota 6.0.0, not 6.1.0");
  });
});

describe("install (optional, consented) on Quota 6", () => {
  it("installs the exact discovered 6.x release through the native plugin add", async () => {
    await writeConfig([]);
    const executed: string[] = [];
    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      executed.push(key);
      if (command === "node") return { stdout: "v24.18.0", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "2.2.5", stderr: "" };
      if (command === "opencode" && args[1] === "list") return { stdout: "No plugins found", stderr: "" };
      if (command === "npm") return { stdout: JSON.stringify([{ latest: "6.1.0" }]), stderr: "" };
      if (command === "opencode" && args[1] === "add") return { stdout: "", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    await installQuotaIfMissing(executor, { delay: async () => undefined, convergence: { attempts: 1, delayMs: 0 } });
    expect(executed).toContain(`opencode plugin add ${PACKAGE}@6.1.0`);
    expect(executed.some((call) => call.includes("plugin add") && call.includes("@5."))).toBe(false);
  });

  it("refuses to install on an unsupported Node, before any plugin add", async () => {
    await writeConfig([]);
    const executed: string[] = [];
    const executor: Executor = async (command, args) => {
      executed.push(`${command} ${args.join(" ")}`);
      if (command === "node") return { stdout: "v20.19.0", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "2.2.5", stderr: "" };
      if (command === "opencode" && args[1] === "list") return { stdout: "No plugins found", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const result = await installQuotaIfMissing(executor, { delay: async () => undefined, convergence: { attempts: 1, delayMs: 0 } });
    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(executed.some((call) => call.includes("plugin add"))).toBe(false);
  });
});
