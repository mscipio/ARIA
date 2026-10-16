import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getPackageRoot } from "../src/defaults.js";
import type { Executor } from "../src/deps.js";
import { runDoctor, type DoctorFileOps } from "../src/doctor.js";
import type { ModelDiscovery } from "../src/model-config.js";
import { ROLES } from "../src/routes.js";
import {
  checkUpgradeInventory,
  formatUpgradeCheck,
  runUpgrade,
  type AriaAvailableTarget,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T009 installed-identity guidance: upgrade guidance derives the installed
// spec/version from the positively identified OpenCode plugin registration
// (never the running CLI package version; the CLI stays reporting-only),
// and a foreign-source equal tag never PASSes (upgrade stays
// unknown-target fail-closed, doctor stays WARN unknown).
// ---------------------------------------------------------------------------

const REGISTERED_107 = "github:mscipio/ARIA#v1.0.7";
const TARGET_109: AriaAvailableTarget = {
  tag: "v1.0.9",
  version: "1.0.9",
  spec: "github:mscipio/ARIA#v1.0.9",
};

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

function upgradeExecutor(pluginListStdout: string, lsRemoteStdout: string, calls: string[]): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "ls-remote") return { stdout: lsRemoteStdout, stderr: "" };
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

const LS_REMOTE_THROUGH_109 = ["aaa111\trefs/tags/v1.0.7", "bbb222\trefs/tags/v1.0.9", ""].join("\n");
const LS_REMOTE_THROUGH_108 = ["aaa111\trefs/tags/v1.0.7", "bbb222\trefs/tags/v1.0.8", ""].join("\n");

describe("T009 upgrade guidance follows the registered installation, not the CLI", () => {
  it("names the registered v1.0.7 package for a v1.0.9 target while CLI 1.0.8 stays reporting-only", async () => {
    const calls: string[] = [];
    const check = await checkUpgradeInventory(
      upgradeExecutor(pluginTable([["aria", "842e4ec", REGISTERED_107]]), LS_REMOTE_THROUGH_109, calls),
      { cliVersion: "1.0.8" },
    );

    expect(check.currentVersion).toBe("1.0.7");
    expect(check.cliVersion).toBe("1.0.8");
    expect(check.installedSpec).toBe(REGISTERED_107);
    expect(check.available).toEqual({ kind: "known", target: TARGET_109 });
    expect(check.selfUpgradeBlocked).toBe(false);
    expect(check.components.find((row) => row.component === "aria")?.status).toBe("upgrade-available");

    const text = formatUpgradeCheck(check);
    expect(text).toContain("Current release: 1.0.7");
    expect(text).toContain("Running CLI: 1.0.8");
    // Guidance selects the registered installation — never the CLI version.
    expect(text).toContain(`npm exec --yes --package ${REGISTERED_107} -- aria upgrade --yes`);
    expect(text).not.toContain("github:mscipio/ARIA#v1.0.8");
    expect(text).not.toContain("already current");

    const blockedCalls: string[] = [];
    const blocked = await runUpgrade(
      upgradeExecutor(pluginTable([["aria", "842e4ec", REGISTERED_107]]), LS_REMOTE_THROUGH_109, blockedCalls),
      { cliVersion: "1.0.8", approval: { yes: false } },
    );
    expect(blocked.stage).toBe("blocked-approval");
    expect(blocked.detail).toContain(`npm exec --yes --package ${REGISTERED_107} -- aria upgrade --yes`);
    expect(blocked.detail).not.toContain("#v1.0.8");

    // Read-only: guidance never removes, adds, or execs a package.
    for (const call of [...calls, ...blockedCalls]) {
      expect(call).not.toContain("plugin remove");
      expect(call).not.toContain("plugin add");
      expect(call.startsWith("npm exec")).toBe(false);
    }
  });

  it("does not report already-current when the CLI matches available but the registered installation lags", async () => {
    const calls: string[] = [];
    const executor = upgradeExecutor(
      pluginTable([["aria", "842e4ec", REGISTERED_107]]),
      LS_REMOTE_THROUGH_108,
      calls,
    );
    const check = await checkUpgradeInventory(executor, { cliVersion: "1.0.8" });

    // CLI 1.0.8 equals available v1.0.8, but the registered installation is
    // v1.0.7 — the check must not call it current.
    expect(check.currentVersion).toBe("1.0.7");
    expect(check.components.find((row) => row.component === "aria")?.status).toBe("upgrade-available");
    expect(formatUpgradeCheck(check)).not.toContain("already current");

    const result = await runUpgrade(executor, {
      cliVersion: "1.0.8",
      approval: { yes: true },
      selfUpgradeFn: async () => ({ ok: false, detail: "stub self-upgrade; no mutation" }),
    });
    expect(result.stage).not.toBe("already-current");
  });

  it("fails closed on a foreign-source equal-tag registration (never current, never guided)", async () => {
    const calls: string[] = [];
    const foreign = "github:other/ARIA#v1.0.8";
    const check = await checkUpgradeInventory(
      upgradeExecutor(pluginTable([["aria", "842e4ec", foreign]]), LS_REMOTE_THROUGH_108, calls),
      { cliVersion: "1.0.8" },
    );

    expect(check.currentVersion).toBeNull();
    expect(check.installedSpec).toBeNull();
    expect(check.selfUpgradeBlocked).toBe(true);
    const aria = check.components.find((row) => row.component === "aria");
    expect(aria?.status).toBe("unknown-target");
    expect(aria?.detail).toContain("unapproved source");

    const text = formatUpgradeCheck(check);
    expect(text).toContain("Current release: unknown");
    expect(text).toContain("Running CLI: 1.0.8");
    expect(text).toContain("BLOCKED");
    expect(text).not.toContain("already current");
    // The observed foreign source is reported honestly in Details, but no
    // exact-package invocation is ever offered for it.
    expect(text).not.toContain(`--package ${foreign}`);
  });
});

// ---------------------------------------------------------------------------
// Doctor half: a foreign-source tag matching the CLI version is WARN
// unknown (never PASS).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalXdgConfig: string | undefined;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfig;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const PROBE_MODELS: ModelDiscovery = {
  models: [{
    id: "test/probe",
    providerID: "test",
    modelID: "probe",
    name: "Probe",
    variants: [],
    variantsObservable: true,
  }],
};

/** Read-only fileOps seam pinning the CLI version to an explicit fixture. */
function pinnedCliFileOps(cliVersion: string): DoctorFileOps {
  const packageRoot = getPackageRoot();
  const packageJsonPath = resolve(packageRoot, "package.json");
  return {
    readText: async (path: string) => {
      if (path === packageJsonPath) return JSON.stringify({ version: cliVersion });
      return readFile(path, "utf8");
    },
  };
}

describe("T009 doctor requires approved-source evidence before comparing versions", () => {
  it("reports WARN unknown (never PASS) for a foreign-source tag matching the CLI version", async () => {
    originalHome = process.env.HOME;
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
    const sandbox = await mkdtemp(resolve(tmpdir(), "aria-t009-home-"));
    tempDirs.push(sandbox);
    process.env.HOME = sandbox;
    process.env.XDG_CONFIG_HOME = resolve(sandbox, "config");

    // T002 deterministic CLI fixture: pinned through the read-only fileOps
    // seam, never read from the checkout's package.json.
    const cliVersion = "9.9.9";
    const foreign = `github:other/ARIA#v${cliVersion}`;
    const pluginList = pluginTable([["aria", "842e4ec", foreign]]);

    const worktree = await mkdtemp(resolve(tmpdir(), "aria-t009-worktree-"));
    tempDirs.push(worktree);
    await writeFile(
      resolve(worktree, "aria.json"),
      JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
    );
    const agentsDir = await mkdtemp(resolve(tmpdir(), "aria-t009-agents-"));
    tempDirs.push(agentsDir);

    const executor: Executor = async (command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "opencode plugin list") return { stdout: pluginList, stderr: "" };
      if (invocation === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (invocation === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
      if (invocation === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
      if (invocation === "opencode mcp list") {
        return {
          stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"),
          stderr: "",
        };
      }
      if (invocation === "opencode debug config") return { stdout: "{}", stderr: "" };
      if (command === "zotpilot") throw new Error("zotpilot: command not found");
      throw new Error(`unexpected probe: ${invocation}`);
    };

    const report = await runDoctor({
      worktree,
      agentsDir,
      executor,
      discovery: async () => PROBE_MODELS,
      fileOps: pinnedCliFileOps(cliVersion),
    });

    // The registration itself is still reported as observed …
    const registration = report.findings.find(
      (finding) => finding.area === "identity" && finding.title === "ARIA plugin registration",
    );
    expect(registration?.severity).toBe("PASS");
    expect(registration?.detail).toContain(foreign);

    // … but the equal-tag comparison from an unapproved source never PASSes.
    const comparison = report.findings.find(
      (finding) => finding.area === "identity" && finding.title === "CLI/plugin identity",
    );
    expect(comparison?.severity).toBe("WARN");
    expect(comparison?.detail).toContain("unapproved source");
    expect(comparison?.detail).toContain("not guessed");
    expect(report.findings.filter((finding) => finding.area === "identity" && finding.severity === "FAIL")).toHaveLength(0);
  });
});
