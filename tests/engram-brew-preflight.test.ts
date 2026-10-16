import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { depsSync, type Executor, type ExecutorOptions } from "../src/deps.js";
import { ensureEngram } from "../src/engram.js";
import { openCodeGlobalDir } from "../src/paths.js";
import {
  buildEngramPreflightArgv,
  checkEngramHomebrewPreflight,
  checkUpgradeInventory,
  engramPreflightEnv,
  formatEngramPreflightCommand,
  runMigrateUpgrade,
  runUpgrade,
  ENGRAM_HOMEBREW_FORMULA,
  type UpgradeCheckResult,
} from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// v1.0.11 hotfix T003: formula-scoped Engram brew regressions. R002: the
// preflight never gates the ARIA-only upgrade path (dependency failure
// cannot block self-upgrade; the probe does not run there) — it remains a
// fail-closed gate for the newer-CLI migrate path only.
//
// Uses only the existing executor/file-operation seams (no sleeps, no live
// mutation). Proves: never bare `brew upgrade engram`; fully qualified
// `--formula gentleman-programming/tap/engram` is used; no cask, whole-tap,
// or trust command is ever invoked (argv scan across brew calls); the
// preflight never runs during read-only inventory/`--check`, before
// explicit approval, or anywhere on the ARIA-only upgrade path;
// migrate failure/indeterminate stops before transition/continuation with
// an actionable error; migrate success proceeds; non-Homebrew/GitHub paths
// are unchanged; unrelated config is preserved.
// Real formula-only-trust sufficiency is T004's job and is NOT asserted here.
// ---------------------------------------------------------------------------

const FORMULA = "gentleman-programming/tap/engram";
const EXACT_UPGRADE = `brew upgrade --formula ${FORMULA}`;
const EXACT_INSTALL = `brew install --formula ${FORMULA}`;
const EXACT_DRY_RUN = `brew upgrade --formula ${FORMULA} --dry-run`;

interface BrewCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function recordCall(calls: BrewCall[], command: string, args: string[], options?: ExecutorOptions): void {
  calls.push({ command, args: [...args], env: options?.env ? { ...options.env } : undefined });
}

function brewCalls(calls: BrewCall[]): BrewCall[] {
  return calls.filter((call) => call.command === "brew");
}

/** Fail on bare/cask/whole-tap/trust across every brew invocation. */
function expectNoProhibitedBrew(calls: BrewCall[]): void {
  for (const call of brewCalls(calls)) {
    const joined = `${call.command} ${call.args.join(" ")}`;
    expect(joined).not.toBe("brew upgrade engram");
    // Bare upgrade carrying engram without --formula is never allowed.
    if (call.args[0] === "upgrade" && call.args.includes("engram")) {
      expect(call.args).toContain("--formula");
      expect(call.args).toContain(FORMULA);
    }
    for (const arg of call.args) {
      expect(arg).not.toBe("--cask");
      expect(arg.toLowerCase()).not.toContain("cask");
      expect(arg.toLowerCase()).not.toContain("trust");
    }
    expect(call.args[0]).not.toBe("tap");
    expect(call.args[0]).not.toBe("untap");
    expect(call.command.toLowerCase()).not.toContain("trust");
  }
  const joinedAll = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  expect(joinedAll).not.toContain("brew upgrade engram");
  for (const entry of joinedAll) {
    if (entry.startsWith("brew ")) {
      expect(entry).not.toContain("--cask");
      expect(entry.toLowerCase()).not.toContain("trust");
    }
  }
}

function expectZeroAriaMutation(calls: BrewCall[]): void {
  for (const call of calls) {
    const joined = `${call.command} ${call.args.join(" ")}`;
    expect(joined).not.toContain("plugin remove");
    expect(joined).not.toContain("plugin add");
    expect(joined.startsWith("npm exec")).toBe(false);
  }
}

async function makeConfigDirWithContext7(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-"));
  tempDirs.push(root);
  const configDir = resolve(root, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(configDir, "opencode.json"),
    JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true } } }),
  );
  return configDir;
}

function healthyMcpList(): string {
  return ["MCP Servers", "", "codegraph connected", "codegraph serve --mcp", "", "context7 connected", "https://mcp.context7.com/mcp", "", "engram connected", "engram mcp --tools=agent", "", "4 server(s)"].join("\n");
}

async function withTempXdg<T>(action: (xdgConfigHome: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-xdg-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp XDG root");
  const xdgConfigHome = resolve(root, "config");
  await mkdir(resolve(xdgConfigHome, "opencode"), { recursive: true });
  assertNotCallerGlobalPath(xdgConfigHome, "temp XDG_CONFIG_HOME");
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    return await action(xdgConfigHome);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
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

function checkWithEngram(installed: string | null, status: string): UpgradeCheckResult {
  return {
    currentVersion: "1.0.6",
    cliVersion: "1.0.6",
    installedSpec: "github:mscipio/ARIA#v1.0.6",
    available: { kind: "known", target: { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" } },
    selfUpgradeBlocked: false,
    blockReason: null,
    components: [
      { component: "aria", installed: "1.0.6", available: "v1.0.7", status: "upgrade-available", detail: "x" },
      { component: "engram", installed, available: null, status, detail: "x" },
    ],
  } as unknown as UpgradeCheckResult;
}

function homebrewSourceExecutor(calls: BrewCall[], dryRun: { ok: boolean } | { throwText: string } | { throwUnknown: unknown }): Executor {
  return async (command, args, options) => {
    recordCall(calls, command, args, options);
    const key = `${command} ${args.join(" ")}`;
    if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
    if (key === "brew list --formula") return { stdout: "engram", stderr: "" };
    if (key === "which engram") return { stdout: "/Cellar/engram/1.20.0/bin/engram", stderr: "" };
    if (key === "brew --cellar") return { stdout: "/Cellar", stderr: "" };
    if (key === EXACT_DRY_RUN) {
      if ("ok" in dryRun) return { stdout: "", stderr: "" };
      if ("throwText" in dryRun) throw new Error(dryRun.throwText);
      throw dryRun.throwUnknown;
    }
    throw new Error(`unexpected: ${key}`);
  };
}

const LS_REMOTE_107 = ["aaa111\trefs/tags/v1.0.6", "bbb222\trefs/tags/v1.0.7", "bbb222\trefs/tags/v1.0.7^{}", ""].join("\n");

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

/** Full inventory-capable executor with Homebrew Engram plus a scripted dry-run outcome. */
function upgradeWorld(options: { dryRun: "ok" | "fail" | "indeterminate"; engram: "homebrew" | "github" | "missing"; ariaSpec?: string }): { calls: BrewCall[]; executor: Executor } {
  const calls: BrewCall[] = [];
  const ariaSpec = options.ariaSpec ?? "github:mscipio/ARIA#v1.0.6";
  const executor: Executor = async (command, args, opts) => {
    recordCall(calls, command, args, opts);
    const key = `${command} ${args.join(" ")}`;
    if (command === "git" && args[0] === "ls-remote") return { stdout: LS_REMOTE_107, stderr: "" };
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
      return { stdout: pluginTable([["aria", "deadbee", ariaSpec], ["other", "1.0.0", "npm:other@1.0.0"]]), stderr: "" };
    }
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
      return { stdout: ["MCP Servers", "engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
    }
    if (key === "engram version") {
      if (options.engram === "missing") throw new Error("engram not found");
      return { stdout: "engram 1.20.0", stderr: "" };
    }
    if (key === "brew list --formula") {
      return { stdout: options.engram === "homebrew" ? "engram" : "node\nyarn", stderr: "" };
    }
    if (key === "which engram") {
      return { stdout: options.engram === "homebrew" ? "/Cellar/engram/1.20.0/bin/engram" : "/home/u/.local/bin/engram", stderr: "" };
    }
    if (key === "brew --cellar") return { stdout: "/Cellar", stderr: "" };
    if (key === EXACT_DRY_RUN) {
      if (options.dryRun === "ok") return { stdout: "", stderr: "" };
      if (options.dryRun === "fail") throw new Error("brew dry-run failed: formula untrusted");
      throw "indeterminate probe timeout";
    }
    if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
    throw new Error(`unexpected call: ${key}`);
  };
  return { calls, executor };
}

describe("v1.0.11 formula-scoped brew argv (deps + lifecycle)", () => {
  it("depsSync homebrew upgrade uses the exact formula argv, never bare/cask/tap/trust", async () => {
    const configDir = await makeConfigDirWithContext7();
    const { homedir } = await import("node:os");
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const calls: BrewCall[] = [];
    const executor: Executor = async (command, args, options) => {
      recordCall(calls, command, args, options);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: healthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.engram.action).toBe("synced (homebrew)");
    const joined = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(joined).toContain(EXACT_UPGRADE);
    expectNoProhibitedBrew(calls);
    const upgradeCall = brewCalls(calls).find((call) => call.args[0] === "upgrade");
    expect(upgradeCall?.args).toEqual(["upgrade", "--formula", FORMULA]);
  });

  it("depsSync missing-install uses brew install --formula, never bare/cask/tap/trust", async () => {
    const configDir = await makeConfigDirWithContext7();
    const calls: BrewCall[] = [];
    let installed = false;
    const executor: Executor = async (command, args, options) => {
      recordCall(calls, command, args, options);
      const key = `${command} ${args.join(" ")}`;
      if (command === "engram" && args[0] === "version") {
        if (!installed) throw new Error("not found");
        return { stdout: "engram 1.20.0", stderr: "" };
      }
      if (command === "which" && args[0] === "brew") return { stdout: "/opt/homebrew/bin/brew", stderr: "" };
      if (key === EXACT_INSTALL) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") return { stdout: healthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.engram.action).toBe("synced (homebrew)");
    const joined = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(joined).toContain(EXACT_INSTALL);
    expectNoProhibitedBrew(calls);
    const installCall = brewCalls(calls).find((call) => call.args[0] === "install");
    expect(installCall?.args).toEqual(["install", "--formula", FORMULA]);
  });

  it("ensureEngram missing-install uses brew install --formula, never bare/cask/tap/trust", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
      const calls: BrewCall[] = [];
      let installed = false;
      const executor: Executor = async (command, args, options) => {
        recordCall(calls, command, args, options);
        const key = `${command} ${args.join(" ")}`;
        if (command === "engram" && args[0] === "version") {
          if (!installed) throw new Error("not found");
          return { stdout: "engram 1.20.0", stderr: "" };
        }
        if (command === "which" && args[0] === "brew") return { stdout: "/opt/homebrew/bin/brew", stderr: "" };
        if (key === EXACT_INSTALL) {
          installed = true;
          return { stdout: "", stderr: "" };
        }
        if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram connected", "1 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${key}`);
      };

      const result = await ensureEngram(executor);
      expect(result.status).toBe("installed");
      const joined = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
      expect(joined).toContain(EXACT_INSTALL);
      expectNoProhibitedBrew(calls);
    });
  });
});

describe("v1.0.11 preflight probe shape (exact dry-run, process-local env)", () => {
  it("runs exactly brew upgrade --formula <formula> --dry-run with HOMEBREW_NO_AUTO_UPDATE=1 process-locally", async () => {
    expect(ENGRAM_HOMEBREW_FORMULA).toBe(FORMULA);
    expect(buildEngramPreflightArgv()).toEqual(["upgrade", "--formula", FORMULA, "--dry-run"]);
    expect(formatEngramPreflightCommand()).toBe(EXACT_DRY_RUN);
    expect(engramPreflightEnv()).toEqual({ HOMEBREW_NO_AUTO_UPDATE: "1" });

    const hadKey = "HOMEBREW_NO_AUTO_UPDATE" in process.env;
    const hadValue = process.env.HOMEBREW_NO_AUTO_UPDATE;
    const calls: BrewCall[] = [];
    const outcome = await checkEngramHomebrewPreflight(homebrewSourceExecutor(calls, { ok: true }), checkWithEngram("1.20.0", "unmanaged-observed"));
    expect(outcome).toEqual({ ok: true, skipped: false });
    const dryRun = brewCalls(calls).find((call) => call.args.includes("--dry-run"));
    expect(dryRun).toBeDefined();
    expect(dryRun?.command).toBe("brew");
    expect(dryRun?.args).toEqual(["upgrade", "--formula", FORMULA, "--dry-run"]);
    expect(dryRun?.env).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: "1" });
    expectNoProhibitedBrew(calls);
    // Process-local only: never assigned to process.env and never persisted.
    expect("HOMEBREW_NO_AUTO_UPDATE" in process.env).toBe(hadKey);
    if (hadKey) expect(process.env.HOMEBREW_NO_AUTO_UPDATE).toBe(hadValue);
  });

  it("skips without any probe on missing/unknown-target/skipped rows and on non-Homebrew sources", async () => {
    for (const check of [checkWithEngram(null, "skipped"), checkWithEngram(null, "unknown-target"), checkWithEngram("1.20.0", "skipped"), checkWithEngram("1.20.0", "unknown-target")]) {
      const calls: BrewCall[] = [];
      const outcome = await checkEngramHomebrewPreflight(homebrewSourceExecutor(calls, { ok: true }), check);
      expect(outcome).toEqual({ ok: true, skipped: true });
      expect(calls).toEqual([]);
    }

    // Non-Homebrew (GitHub asset) resolves to unknown: no dry-run, unchanged path.
    const githubCalls: BrewCall[] = [];
    const githubExecutor: Executor = async (command, args, options) => {
      recordCall(githubCalls, command, args, options);
      const key = `${command} ${args.join(" ")}`;
      if (key === "engram version") return { stdout: "engram 1.19.0", stderr: "" };
      if (key === "brew list --formula") return { stdout: "node\nyarn", stderr: "" };
      if (key === "which engram") return { stdout: "/home/u/.local/bin/engram", stderr: "" };
      if (key === "brew --cellar") return { stdout: "/Cellar", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    const githubOutcome = await checkEngramHomebrewPreflight(githubExecutor, checkWithEngram("1.19.0", "unmanaged-observed"));
    expect(githubOutcome).toEqual({ ok: true, skipped: true });
    expect(githubCalls.some((call) => call.args.includes("--dry-run"))).toBe(false);
    expectNoProhibitedBrew(githubCalls);
  });
});

describe("v1.0.11 preflight gating (inventory and approval)", () => {
  it("read-only inventory never executes the dry-run probe", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "ok", engram: "homebrew" });
    const { configDir } = await (async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-inv-"));
      tempDirs.push(root);
      const dir = resolve(root, "config", "opencode");
      await mkdir(dir, { recursive: true });
      return { configDir: dir };
    })();
    const before = await snapshotTree(resolve(configDir, "..", ".."));
    const check = await checkUpgradeInventory(executor, { configDir, currentVersion: "1.0.6", availableOverride: { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" } });
    expect(check.components.find((row) => row.component === "engram")?.installed).toBe("1.20.0");
    expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(false);
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).not.toContain(EXACT_DRY_RUN);
    expectNoProhibitedBrew(calls);
    const after = await snapshotTree(resolve(configDir, "..", ".."));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("runUpgrade without explicit approval never executes the preflight", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "ok", engram: "homebrew" });
    const { configDir } = await (async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-appr-"));
      tempDirs.push(root);
      const dir = resolve(root, "config", "opencode");
      await mkdir(dir, { recursive: true });
      return { configDir: dir };
    })();
    const result = await runUpgrade(executor, { configDir, currentVersion: "1.0.6", approval: { yes: false } });
    expect(result.stage).toBe("blocked-approval");
    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(false);
    expectZeroAriaMutation(calls);
    expectNoProhibitedBrew(calls);
  });
});

describe("R002 ARIA-only upgrade carries no dependency preflight (upgrade + migrate)", () => {
  it("upgrade proceeds to the approved handoff despite dry-run failure with zero dependency mutation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-fail-"));
    tempDirs.push(root);
    const configDir = resolve(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    const unrelated = { mcp: { servers: { other: { type: "remote", url: "https://example.invalid/mcp" } } }, plugins: ["unrelated-plugin"] };
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify(unrelated));
    const before = await snapshotTree(root);
    const { calls, executor } = upgradeWorld({ dryRun: "fail", engram: "homebrew" });
    let selfUpgradeCalls = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: async (target, handoff) => {
        selfUpgradeCalls += 1;
        expect(target.spec).toBe("github:mscipio/ARIA#v1.0.7");
        expect(handoff.target.spec).toBe("github:mscipio/ARIA#v1.0.7");
        return { ok: true, detail: "replaced", handoffNote: "new release owns the remainder" };
      },
    });
    // R002: a dependency probe failure never blocks ARIA self-upgrade — the
    // dry-run probe does not even run on this path.
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(selfUpgradeCalls).toBe(1);
    expect("handoff" in result && result.handoff).toBeTruthy();
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).not.toContain(EXACT_DRY_RUN);
    expectZeroAriaMutation(calls);
    expectNoProhibitedBrew(calls);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
  });

  it("upgrade indeterminate probe state proceeds the same way with zero dependency mutation", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "indeterminate", engram: "homebrew" });
    const { configDir } = await (async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-ind-"));
      tempDirs.push(root);
      const dir = resolve(root, "config", "opencode");
      await mkdir(dir, { recursive: true });
      return { configDir: dir };
    })();
    let selfUpgradeCalls = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: async () => {
        selfUpgradeCalls += 1;
        return { ok: true, detail: "replaced", handoffNote: "taken" };
      },
    });
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(selfUpgradeCalls).toBe(1);
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).not.toContain(EXACT_DRY_RUN);
    expectZeroAriaMutation(calls);
    expectNoProhibitedBrew(calls);
  });

  it("upgrade success proceeds to the approved handoff with no dry-run probe", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "ok", engram: "homebrew" });
    const { configDir } = await (async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-ok-"));
      tempDirs.push(root);
      const dir = resolve(root, "config", "opencode");
      await mkdir(dir, { recursive: true });
      return { configDir: dir };
    })();
    let selfUpgradeCalls = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: async (target, handoff) => {
        selfUpgradeCalls += 1;
        expect(target.spec).toBe("github:mscipio/ARIA#v1.0.7");
        expect(handoff.target.spec).toBe("github:mscipio/ARIA#v1.0.7");
        return { ok: true, detail: "replaced", handoffNote: "new release owns the remainder" };
      },
    });
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(selfUpgradeCalls).toBe(1);
    const joined = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    // R002: the ARIA-only upgrade never runs the dependency dry-run probe.
    expect(joined).not.toContain(EXACT_DRY_RUN);
    expectNoProhibitedBrew(calls);
  });

  it("non-Homebrew upgrade skips the probe and still proceeds unchanged", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "ok", engram: "github" });
    const { configDir } = await (async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rdc-preflight-gh-"));
      tempDirs.push(root);
      const dir = resolve(root, "config", "opencode");
      await mkdir(dir, { recursive: true });
      return { configDir: dir };
    })();
    let selfUpgradeCalls = 0;
    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: async () => {
        selfUpgradeCalls += 1;
        return { ok: true, detail: "replaced", handoffNote: "taken" };
      },
    });
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(selfUpgradeCalls).toBe(1);
    expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(false);
    expectNoProhibitedBrew(calls);
  });

  it("migrate failure stops before transition/continuation with zero mutation", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "fail", engram: "homebrew", ariaSpec: "github:mscipio/ARIA#v1.0.7" });
    let migrateCalls = 0;
    const result = await runMigrateUpgrade(executor, {
      migrateFrom: "github:mscipio/ARIA#v1.0.7",
      ownVersion: "1.0.10",
      approval: { yes: true },
      migrateFn: async () => {
        migrateCalls += 1;
        return { ok: true, detail: "must not run" };
      },
    });
    expect(result.stage).toBe("preflight-failed");
    expect(result.ok).toBe(false);
    expect(migrateCalls).toBe(0);
    expect(result.report).toBe("");
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toContain(EXACT_DRY_RUN);
    expectZeroAriaMutation(calls);
    expectNoProhibitedBrew(calls);
    expect(result.detail).toContain(FORMULA);
    expect(result.detail).toContain(formatEngramPreflightCommand());
    expect(result.detail.toLowerCase()).toContain("manually");
  });

  it("migrate success proceeds through transition and continuation after the dry-run", async () => {
    const { calls, executor } = upgradeWorld({ dryRun: "ok", engram: "homebrew", ariaSpec: "github:mscipio/ARIA#v1.0.7" });
    let migrateCalls = 0;
    const result = await runMigrateUpgrade(executor, {
      migrateFrom: "github:mscipio/ARIA#v1.0.7",
      ownVersion: "1.0.10",
      approval: { yes: true },
      migrateFn: async (fromSpec, target) => {
        migrateCalls += 1;
        expect(fromSpec).toBe("github:mscipio/ARIA#v1.0.7");
        expect(target.spec).toBe("github:mscipio/ARIA#v1.0.10");
        return { ok: true, detail: "transitioned", handoffNote: "continued" };
      },
      continuation: {
        components: {
          engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
          context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
          codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
          zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
          quota: async () => ({ component: "quota", status: "skipped", detail: "stubbed", mutated: false }),
        },
        normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
        regenFn: async () => ({ ok: true, detail: "no regen required", mutated: false }),
        depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: false }),
        doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
      },
    });
    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    expect(migrateCalls).toBe(1);
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toContain(EXACT_DRY_RUN);
    expectNoProhibitedBrew(calls);
  });
});
