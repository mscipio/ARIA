import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSetupDependencies } from "../src/dependencies";
import { declaredMcpNames, discoverIntegrations, formatIntegrationProposal, type IntegrationInventory } from "../src/integrations";
import { parseMcpList, parseMcpServers, type Executor } from "../src/deps";
import { formatDepsUpgradeProposal, type UpgradeCheckResult, type UpgradeComponentRow } from "../src/upgrade";
import { createConsoleServices, optionalPreview } from "../src/management-console";

// Real `opencode mcp list` / `plugin list` / `debug config` shapes observed on
// OpenCode 2.2.5. Every test here runs against a fake executor or a temp root.

const REAL_MCP_LIST = [
  "✓ codegraph   connected",
  "✓ context7    connected",
  "✓ engram      connected",
  "✓ playwright  connected",
  "✓ zotpilot    connected",
].join("\n");

const REAL_PLUGIN_LIST = [
  "ID                              VERSION  SOURCE",
  "@slkiser/opencode-quota.server  6.1.0    @slkiser/opencode-quota",
  "aria                            local    /opt/node_modules/aria",
  "engram                          local    /home/user/.config/opencode/plugins/engram.ts",
].join("\n");

const REAL_DEBUG_CONFIG = JSON.stringify([
  { type: "document", info: { providers: {} } },
  {
    type: "document",
    path: "/home/user/.config/opencode/opencode.jsonc",
    info: {
      mcp: {
        timeout: 5000,
        servers: {
          codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true },
          engram: { type: "local", command: ["engram", "mcp"] },
          zotpilot: { type: "local", command: ["zotpilot"] },
          context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
          playwright: { type: "local", command: ["node", "playwright-launch.js"] },
        },
      },
      plugins: ["@slkiser/opencode-quota", "/opt/node_modules/aria"],
    },
  },
  { type: "directory", path: "/home/user/.config/opencode" },
]);

function row(component: UpgradeComponentRow["component"], status: UpgradeComponentRow["status"], installed: string | null = null, available: string | null = null, detail = `${component} ${status}`): UpgradeComponentRow {
  return { component, installed, available, status, detail };
}

/** A fully-populated inventory for the real environment shape. */
function realInventory(): UpgradeCheckResult {
  return {
    currentVersion: "1.2.0",
    cliVersion: "1.3.4-rc.7",
    installedSpec: "github:mscipio/ARIA#v1.2.0",
    available: { kind: "unknown", reason: "pinned" },
    selfUpgradeBlocked: true,
    blockReason: "unapproved source",
    components: [
      row("aria", "unknown-target", null, null, "unapproved source; self-upgrade blocked"),
      row("engram", "unmanaged-observed", "3.4.0", null, "Engram 3.4.0 observed"),
      row("context7", "remote-healthy", "remote", null, "remote endpoint connected"),
      row("codegraph", "unmanaged-observed", "1.3.1", null, "CodeGraph 1.3.1 observed and non-managed"),
      row("zotpilot", "unmanaged-observed", "mcp-listed", null, "ZotPilot MCP server listed"),
      row("playwright", "current", "0.0.83", "0.0.83", "ARIA-managed Playwright MCP 0.0.83 matches the ARIA pin"),
      row("quota", "unmanaged-observed", "6.1.0", null, "Quota 6.1.0 observed (@slkiser/opencode-quota@6.1.0)"),
    ],
  };
}

/** Executor answering the read-only probes; every other command is recorded and refused. */
function fakeExecutor(answers: Record<string, string | (() => string)>): { executor: Executor; calls: string[] } {
  const calls: string[] = [];
  const executor: Executor = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`refused in test: ${key}`);
    return { stdout: typeof answer === "function" ? answer() : answer, stderr: "" };
  };
  return { executor, calls };
}

const READ_ONLY_ANSWERS = {
  "opencode plugin list": REAL_PLUGIN_LIST,
  "opencode mcp list": REAL_MCP_LIST,
  "opencode debug config": REAL_DEBUG_CONFIG,
};

describe("runtime parsers match the real OpenCode output", () => {
  it("parses every server row, including ARIA-managed Playwright", () => {
    const servers = parseMcpServers(REAL_MCP_LIST);
    expect(servers.map((server) => server.name)).toEqual(["codegraph", "context7", "engram", "playwright", "zotpilot"]);
    expect(servers.every((server) => server.connected)).toBe(true);
  });

  it("keeps the known-server booleans used by bootstrap and CodeGraph validation", () => {
    const status = parseMcpList(REAL_MCP_LIST);
    expect(status).toMatchObject({ engram: true, context7: true, codegraph: true });
    expect(status.zotpilot).toEqual({ listed: true, connected: true });
  });

  it("reads disconnected and error states without treating them as connected", () => {
    const servers = parseMcpServers("✗ codegraph   disconnected\n⚠ zotpilot   error\n✓ engram   connected");
    expect(servers).toEqual([
      { name: "codegraph", status: "disconnected", connected: false },
      { name: "zotpilot", status: "error", connected: false },
      { name: "engram", status: "connected", connected: true },
    ]);
  });

  it("returns no servers for decorative or unrelated output", () => {
    expect(parseMcpServers("MCP Servers\n\nNo servers configured")).toEqual([]);
  });

  it("collects declared MCP names from both the V2 and legacy containers", () => {
    expect(declaredMcpNames(REAL_DEBUG_CONFIG)).toEqual(["codegraph", "context7", "engram", "playwright", "zotpilot"]);
    const legacy = JSON.stringify([{ type: "document", info: { mcp: { legacy: { type: "local", command: ["x"] } } } }]);
    expect(declaredMcpNames(legacy)).toEqual(["legacy"]);
    expect(declaredMcpNames("not json")).toEqual([]);
  });
});

describe("complete discovery", () => {
  it("lists every loaded MCP server and plugin, merged with ARIA's definitions", async () => {
    const { executor } = fakeExecutor(READ_ONLY_ANSWERS);
    const inventory = await discoverIntegrations(executor, { inventory: realInventory() });

    const names = inventory.entries.map((entry) => `${entry.kind}:${entry.name}`).sort();
    expect(names).toEqual([
      "mcp:codegraph",
      "mcp:context7",
      "mcp:engram",
      "mcp:playwright",
      "mcp:zotpilot",
      "plugin:@slkiser/opencode-quota.server",
      "plugin:aria",
      "plugin:engram",
    ]);
    expect(inventory.missingRequired).toEqual([]);
    expect(inventory.missingOptional).toEqual([]);
    expect(inventory.unreported).toEqual([]);
  });

  it("distinguishes ARIA-managed, external, remote, and user-owned integrations", async () => {
    const { executor } = fakeExecutor(READ_ONLY_ANSWERS);
    const inventory = await discoverIntegrations(executor, {
      inventory: realInventory(),
    });
    const byName = Object.fromEntries(inventory.entries.map((entry) => [`${entry.kind}:${entry.name}`, entry]));
    expect(byName["mcp:playwright"]?.ownership).toBe("aria-managed");
    expect(byName["mcp:codegraph"]?.ownership).toBe("external");
    expect(byName["mcp:context7"]?.ownership).toBe("remote");
    expect(byName["mcp:context7"]?.action).toContain("no client-side version");
    expect(byName["mcp:codegraph"]?.action).toContain("adoption");
  });

  it("treats an integration nothing in ARIA defines as user-owned with no action", async () => {
    const extra = REAL_MCP_LIST + "\n✓ my-custom-server   connected";
    const { executor } = fakeExecutor({
      ...READ_ONLY_ANSWERS,
      "opencode mcp list": extra,
      "opencode debug config": REAL_DEBUG_CONFIG,
    });
    const inventory = await discoverIntegrations(executor, { inventory: realInventory() });
    const custom = inventory.entries.find((entry) => entry.name === "my-custom-server");
    expect(custom).toMatchObject({ ownership: "user", component: null, action: "none (not an ARIA dependency)" });
  });

  it("does not claim a declared server is missing when the runtime list is slow, and reports it after one retry", async () => {
    let reads = 0;
    const { executor } = fakeExecutor({
      ...READ_ONLY_ANSWERS,
      "opencode mcp list": () => {
        reads += 1;
        return reads === 1 ? "✓ engram   connected\n✓ context7   connected" : REAL_MCP_LIST.replace(/✓ codegraph.*\n/, "");
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = discoverIntegrations(executor, { inventory: realInventory() });
      await vi.advanceTimersByTimeAsync(5000);
      const inventory = await pending;
      expect(reads).toBe(2);
      // The retry saw playwright and zotpilot; codegraph stayed unreported.
      expect(inventory.unreported).toEqual(["codegraph"]);
      expect(inventory.missingRequired).not.toContain("codegraph");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a required component that is neither declared nor listed as missing", async () => {
    const config = JSON.stringify([{ type: "document", info: { mcp: { servers: { context7: { type: "remote", url: "https://x" } } } } }]);
    const { executor } = fakeExecutor({
      "opencode plugin list": "No plugins found",
      "opencode mcp list": "✓ context7   connected",
      "opencode debug config": config,
    });
    const inventory = await discoverIntegrations(executor, { inventory: realInventory() });
    expect(inventory.missingRequired).toEqual(["engram", "codegraph", "playwright"]);
    expect(inventory.missingOptional).toEqual(["quota", "zotpilot"]);
  });

  it("claims nothing missing when the runtime sources cannot be read", async () => {
    const { executor } = fakeExecutor({});
    const inventory = await discoverIntegrations(executor, { inventory: realInventory() });
    expect(inventory.mcpListOk).toBe(false);
    expect(inventory.pluginListOk).toBe(false);
    expect(inventory.entries).toEqual([]);
    expect(inventory.missingRequired).toEqual([]);
    expect(inventory.missingOptional).toEqual([]);
  });

  it("reports a Quota 6 installation as supported, and a Quota 5 installation as a blocker, never a downgrade", async () => {
    const { executor } = fakeExecutor(READ_ONLY_ANSWERS);
    const supported = await discoverIntegrations(executor, { inventory: realInventory() });
    const quota6 = supported.entries.find((entry) => entry.component === "quota");
    expect(quota6?.version).toBe("6.1.0");
    expect(quota6?.blocker ?? "").not.toContain("outside ARIA");

    const legacy = REAL_PLUGIN_LIST.replace("6.1.0", "5.0.3");
    const { executor: legacyExecutor } = fakeExecutor({ ...READ_ONLY_ANSWERS, "opencode plugin list": legacy });
    const outdated = await discoverIntegrations(legacyExecutor, { inventory: realInventory() });
    const quota5 = outdated.entries.find((entry) => entry.component === "quota");
    expect(quota5?.blocker).toContain("outside ARIA's supported Quota 6.x major");
    expect(quota5?.blocker).toContain("never downgraded");
  });
});

describe("update proposal detail", () => {
  it("shows installed, source, mechanism, action, and blocker for each managed dependency", async () => {
    const { executor } = fakeExecutor(READ_ONLY_ANSWERS);
    const inventory = await discoverIntegrations(executor, { inventory: realInventory() });
    const text = formatIntegrationProposal(inventory);
    expect(text).toContain("codegraph (mcp codegraph)");
    expect(text).toContain("installed: 1.3.1");
    expect(text).toContain("[external]");
    expect(text).toContain("mechanism: npm @colbymchenry/codegraph");
    expect(text).toContain("action:    report-only; updates require an explicit adoption decision");
    expect(text).toContain("blocker:   CodeGraph 1.3.1 observed and non-managed");
    expect(text).toContain("context7 (mcp context7)");
    expect(text).toContain("action:    none (remote endpoint; no client-side version to update)");
  });

  it("states that an ARIA-managed upgrade is proposed by the owning adapter", () => {
    const check = realInventory();
    check.components = [row("playwright", "upgrade-available", "0.0.82", "0.0.83", "ARIA-managed 0.0.82")];
    expect(formatDepsUpgradeProposal(check)).toContain("proposed: upgraded by the owning adapter to 0.0.83 on approval");
  });

  it("states the provider's own update for a confirmed external upgrade, and no action for an unsupported install", () => {
    const check = realInventory();
    check.components = [
      row("engram", "provider-upgrade-available", "3.4.0", "3.6.0", "Engram via Homebrew"),
      row("zotpilot", "unmanaged-observed", "mcp-listed", null, "user-managed"),
    ];
    const text = formatDepsUpgradeProposal(check);
    expect(text).toContain("proposed: updated through the provider's own mechanism to 3.6.0 on approval (ARIA takes no ownership)");
    expect(text).toContain("report-only: no supported update path for this installation");
    expect(text).not.toContain("re-evaluated by the owning adapter");
  });

  it("names missing required and optional components with their consent path", () => {
    const inventory: IntegrationInventory = {
      entries: [],
      declaredMcp: [],
      unreported: ["zotpilot"],
      missingRequired: ["codegraph"],
      missingOptional: ["quota"],
      pluginListOk: true,
      mcpListOk: true,
    };
    const text = formatIntegrationProposal(inventory);
    expect(text).toContain("declared but not reported by the runtime: zotpilot (state unknown; not treated as missing)");
    expect(text).toContain("missing required: codegraph (install with 'aria setup')");
    expect(text).toContain("missing optional: quota (install only with consent: aria setup --install-optional quota)");
  });
});

describe("optional dependencies require consent", () => {
  const home = { homeDir: "" };
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aria-deps-consent-"));
    home.homeDir = join(root, "home");
    await mkdir(home.homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not install a missing Quota or ZotPilot unless consent names it", async () => {
    const { executor, calls } = fakeExecutor({ "opencode plugin list": "No plugins found" });
    // Effective OpenCode root (sandboxed by tests/setup.ts): the native Quota installer refuses explicit dirs it cannot verify.
    const result = await runSetupDependencies(executor, { homeDir: home.homeDir });
    const quota = result.outcomes.find((outcome) => outcome.component === "quota");
    const zotpilot = result.outcomes.find((outcome) => outcome.component === "zotpilot");
    expect(quota).toMatchObject({ status: "skipped", mutated: false });
    expect(quota?.detail).toContain("aria setup --install-optional quota");
    expect(zotpilot).toMatchObject({ status: "skipped", mutated: false });
    expect(zotpilot?.detail).toContain("aria setup --install-optional zotpilot");
    // No optional install (plugin add, npm/pip install) was even attempted.
    expect(calls.some((call) => /install|plugin add/.test(call) && /quota|zotpilot/.test(call))).toBe(false);
    expect(calls.some((call) => call.includes("@slkiser/opencode-quota") && call.includes("npm view"))).toBe(false);
  });

  it("attempts only the consented optional component", async () => {
    const { executor, calls } = fakeExecutor({
      "opencode plugin list": "No plugins found",
      "node --version": "v24.18.0",
      "opencode --version": "2.2.5",
      "npm view @slkiser/opencode-quota dist-tags --json": JSON.stringify([{ latest: "6.1.0" }]),
    });
    const result = await runSetupDependencies(executor, {
      // Effective OpenCode root (sandboxed by tests/setup.ts): the native Quota installer refuses explicit dirs it cannot verify.
      homeDir: home.homeDir,
      optionalInstalls: ["quota"],
    });
    expect(calls.some((call) => call.includes("@slkiser/opencode-quota"))).toBe(true);
    expect(result.outcomes.find((outcome) => outcome.component === "zotpilot")?.detail).toContain("aria setup --install-optional zotpilot");
  });

  it("offers optional installs only when every required component is present", () => {
    const blocked = optionalPreview({
      entries: [],
      declaredMcp: [],
      unreported: [],
      missingRequired: ["engram"],
      missingOptional: ["quota"],
      pluginListOk: true,
      mcpListOk: true,
    });
    expect(blocked).toMatchObject({ applicable: false });
    expect(blocked.lines.join(" ")).toContain("Install them with Run setup / reconciliation first");

    const offered = optionalPreview({
      entries: [],
      declaredMcp: [],
      unreported: [],
      missingRequired: [],
      missingOptional: ["quota"],
      pluginListOk: true,
      mcpListOk: true,
    });
    expect(offered).toMatchObject({ applicable: true });

    const nothing = optionalPreview({
      entries: [],
      declaredMcp: [],
      unreported: [],
      missingRequired: [],
      missingOptional: [],
      pluginListOk: true,
      mcpListOk: true,
    });
    expect(nothing).toMatchObject({ applicable: false });
  });

  it("refuses the console optional install while a required component is missing, with zero install calls", async () => {
    const config = JSON.stringify([{ type: "document", info: { mcp: { servers: { context7: { type: "remote", url: "https://x" } } } } }]);
    const { executor, calls } = fakeExecutor({
      "opencode plugin list": "No plugins found",
      "opencode mcp list": "✓ context7   connected",
      "opencode debug config": config,
      "opencode --version": "2.0.23",
    });
    const services = createConsoleServices({ worktree: root, binaryUrl: "file:///x/bin/aria.mjs", executor });
    const outcome = await services.run("apply-optional");
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join(" ")).toContain("Required dependencies are missing");
    const mutating = calls.filter((call) => /\binstall\b|\badd\b|\bupgrade\b|\bbrew\b/.test(call));
    expect(mutating).toEqual([]);
  });
});

describe("Playwright MCP ownership is inventoried", () => {
  let root: string;
  const previous = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aria-pw-row-"));
    process.env.XDG_DATA_HOME = join(root, "data");
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  async function rowFor(files: { marker?: boolean; version?: string }): Promise<UpgradeComponentRow> {
    const base = join(root, "data", "aria", "playwright-mcp");
    await mkdir(join(base, "node_modules", "@playwright", "mcp"), { recursive: true });
    if (files.marker) await writeFile(join(base, "aria-managed.json"), JSON.stringify({ owner: "aria", package: "@playwright/mcp", version: "0.0.83" }));
    if (files.version) {
      await writeFile(join(base, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ version: files.version }));
    }
    vi.resetModules();
    const upgrade = await import("../src/upgrade");
    const { executor } = fakeExecutor({});
    return upgrade.playwrightInventoryRow(executor);
  }

  it("reports an absent Playwright MCP as skipped, with the ARIA pin", async () => {
    const r = await rowFor({});
    expect(r).toMatchObject({ component: "playwright", status: "skipped", available: "0.0.83" });
  });

  it("reports an ARIA-owned install at the pin as current", async () => {
    const r = await rowFor({ marker: true, version: "0.0.83" });
    expect(r).toMatchObject({ status: "current", installed: "0.0.83" });
  });

  it("reports an ARIA-owned install behind the pin as upgrade-available", async () => {
    const r = await rowFor({ marker: true, version: "0.0.82" });
    expect(r).toMatchObject({ status: "upgrade-available", installed: "0.0.82", available: "0.0.83" });
  });

  it("reports an unmarked install as external and never adopts it automatically", async () => {
    const r = await rowFor({ version: "0.0.84" });
    expect(r.status).toBe("unmanaged-observed");
    expect(r.detail).toContain("not ARIA-owned");
  });
});
