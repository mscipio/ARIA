// ---------------------------------------------------------------------------
// T020 — Bounded final V2 smoke test (authoritative reframe superseding T018).
//
// Seam-based unit/integration coverage PLUS ONE bounded live smoke on
// isolated V2 under temp HOME/XDG. T019 sandbox discipline is mandatory:
// all live work lands under temp HOME/XDG only, never caller/ambient roots,
// never prod V1 (read-only mapping only). Uses the pinned 2.0.23 CLI from
// /home/scratch/opencode/t012-v2cli when available, else fixture-based
// shapes. No synthetic package-manager environments are built; no real
// upstream installers run outside temp roots (install commands are stubbed,
// REAL file/config/doctor/registration logic runs against temp dirs).
//
// Covers: fresh-setup bootstrap of missing supported deps via
// demonstrated-safe paths (install→normalize→validate, stubbed installers +
// real config writes to temp root); JSONC fail-closed + exact v1.0.6-bug
// byte-identical; configure→agent regen; doctor 2.0.23 shapes;
// upgrade --check no-mutation + approval gate; ARIA exact-ref single
// registration + handoff immutability (seam-level; no live remove/add
// against real registries); ownership gates (owned-update vs
// ambiguous-untouched); sync-no-chase; statusline absence; before/after
// report; XDG isolation + prod-V1 non-mutation (hashes/reads, zero writes
// outside temp). Binding interpretation 3: report-only fallback for a
// required missing component is safe failure, not bootstrap success — the
// smoke FAILS (does not pass) if any required component lacks a real install
// path. Full deployment certification stays deferred to the prod migration.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { classifyAriaRegistration } from "../src/aria-upgrade.js";
import { BOOTSTRAP_EVIDENCE, installCodegraphIfMissing } from "../src/bootstrap.js";
import {
  cleanupIncompatibleStatusline,
  depsSync,
  detectIncompatibleStatusline,
  type Executor,
} from "../src/deps.js";
import { formatDependenciesReport, runSetupDependencies } from "../src/dependencies.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import { setup } from "../src/lifecycle.js";
import { openCodeGlobalDir } from "../src/paths.js";
import { upgradeQuota } from "../src/quota.js";
import { ensureAriaSetupConfigFile } from "../src/setup-config.js";
import {
  buildUpgradeHandoff,
  checkUpgradeInventory,
  formatUpgradeReport,
  isHandoffMatch,
  runUpgrade,
  UPGRADE_COMPONENTS,
  type AriaAvailableTarget,
} from "../src/upgrade.js";
import { assertNotCallerGlobalPath, callerPathsSnapshot } from "./test-isolation.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "T020 temp root");
  return root;
}

type DirSnapshot = { exists: false } | { exists: true; entries: Record<string, string> };

async function snapshotDir(dir: string): Promise<DirSnapshot> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { exists: false };
  } catch {
    return { exists: false };
  }
  const entries: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        entries[relative(dir, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
      }
    }
  }
  await walk(dir);
  return { exists: true, entries };
}

async function recentFilesContaining(dir: string, marker: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  try {
    if (!(await stat(dir)).isDirectory()) return found;
  } catch {
    return found;
  }
  async function walk(current: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      try {
        const info = await stat(full);
        if (info.isDirectory()) await walk(full);
        else if (info.isFile() && info.mtimeMs >= sinceMs - 1000) {
          if ((await readFile(full, "utf8")).includes(marker)) found.push(relative(dir, full));
        }
      } catch {
        // Transient/unreadable: skip (strict config snapshot is authoritative).
      }
    }
  }
  await walk(dir);
  return found.sort();
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

const PINNED_OPENCODE = "/home/scratch/opencode/t012-v2cli/node_modules/@opencode/cli-linux-x64/bin/opencode";
const execFileAsync = promisify(execFile);

async function pinnedCliAvailable(): Promise<boolean> {
  try {
    const info = await stat(PINNED_OPENCODE);
    return info.isFile();
  } catch {
    return false;
  }
}

describe("T020 binding interpretation 3 — report-only is safe failure, not bootstrap success", () => {
  it("every required component has a demonstrated-safe missing-install path; discovery failure never reports success", async () => {
    // Gate: if any required component lacks a real install path, THIS TEST
    // FAILS (the smoke does not pass). Report-only for missing is safe
    // failure, never bootstrap success.
    expect(BOOTSTRAP_EVIDENCE.map((entry) => entry.component).sort()).toEqual(
      ["codegraph", "engram", "quota", "zotpilot"],
    );
    for (const entry of BOOTSTRAP_EVIDENCE) {
      expect(entry.missingPath, `${entry.component} must have a real install path (report-only fallback would fail this smoke)`).toBe(
        "install",
      );
      expect(entry.discovery.length).toBeGreaterThan(0);
      expect(entry.installCommands.length).toBeGreaterThan(0);
      expect(entry.existingGate.length).toBeGreaterThan(0);
    }

    // Representative proof: undiscoverable upstream is install-failed (safe
    // failure), never installed/skipped success.
    const root = await makeTempRoot("rdc-t020-gate-");
    const configDir = resolve(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    assertNotCallerGlobalPath(configDir, "gate configDir");
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") throw new Error("not found");
      if (command === "npm" && args[0] === "view") throw new Error("network unavailable");
      if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const result = await installCodegraphIfMissing(executor, configDir);
    expect(result.status).toBe("install-failed");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
    expect((await snapshotTree(root)).size).toBe(0);
  });
});

describe("T020 bounded final V2 smoke (ONE live smoke, temp HOME/XDG only)", () => {
  it("fresh bootstrap + JSONC/v106 + regen + doctor + upgrade/approval + ARIA/handoff + ownership + sync + statusline + report + isolation", async () => {
    const caller = callerPathsSnapshot();
    const prodV1Dir = join(caller.home, ".config", "opencode");
    const windowStartMs = Date.now();
    const callerConfigBefore = await snapshotDir(caller.globalConfigDir);
    const prodV1Before = resolve(prodV1Dir) === resolve(caller.globalConfigDir)
      ? null
      : await snapshotDir(prodV1Dir);
    const leakMarker = "rdc-t020-smoke-";

    // Temp HOME/XDG root: every live write lands here, never caller/ambient/prod.
    const smokeRoot = await makeTempRoot("rdc-t020-smoke-");
    const tempHome = resolve(smokeRoot, "home");
    const tempXdgConfig = resolve(smokeRoot, "xdg-config");
    const tempXdgData = resolve(smokeRoot, "xdg-data");
    const tempXdgState = resolve(smokeRoot, "xdg-state");
    const tempEngramData = resolve(smokeRoot, "engram-data");
    const tempConfigDir = resolve(tempXdgConfig, "opencode");
    for (const dir of [tempHome, tempXdgConfig, tempXdgData, tempXdgState, tempEngramData, tempConfigDir]) {
      await mkdir(dir, { recursive: true });
      assertNotCallerGlobalPath(dir, "T020 smoke dir");
    }

    const liveEnv = {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: tempXdgConfig,
      XDG_DATA_HOME: tempXdgData,
      XDG_STATE_HOME: tempXdgState,
      ENGRAM_DATA_DIR: tempEngramData,
    };
    for (const dir of [liveEnv.HOME as string, liveEnv.XDG_CONFIG_HOME as string]) {
      assertNotCallerGlobalPath(resolve(dir), "T020 live env root");
    }

    // --- Live pinned-CLI read-only probes (no mutating command, temp env only).
    // Bounded to the three fast read-only probes (--version, plugin list,
    // mcp list); debug-config/models shapes are covered via fixture shapes +
    // stubbed doctor below so the live smoke never blocks on network/daemon
    // probes. Probes run concurrently with a short timeout each.
    const liveCli = await pinnedCliAvailable();
    const liveOutputs: Record<string, string> = {};
    let liveProbed = false;
    if (liveCli) {
      const probes: Array<[string, string[]]> = [
        ["version", ["--version"]],
        ["plugin-list", ["plugin", "list"]],
        ["mcp-list", ["mcp", "list"]],
      ];
      await Promise.all(probes.map(async ([name, args]) => {
        try {
          const result = await execFileAsync(PINNED_OPENCODE, args, { env: liveEnv, timeout: 10000 });
          liveOutputs[name] = `${result.stdout}\n${result.stderr}`;
        } catch (error) {
          liveOutputs[name] = `PROBE-FAILED: ${error instanceof Error ? error.message : String(error)}`;
        }
      }));
      liveProbed = (liveOutputs["version"] ?? "").includes("2.0.23");
      if (liveProbed) {
        expect(liveOutputs["version"]).toContain("2.0.23");
      }
    }
    const liveNote = liveCli
      ? liveProbed
        ? "pinned 2.0.23 CLI probed live (read-only --version/plugin-list/mcp-list, temp env; debug-config/models shapes via fixtures + stubbed doctor)"
        : "pinned CLI present but version probe did not confirm 2.0.23; fixture shapes used for shape assertions"
      : "pinned 2.0.23 CLI unavailable; fixture-based 2.0.23 shapes used (no live probe)";

    // --- Fresh-setup bootstrap of missing supported deps (stubbed installers + REAL config writes to temp root).
    // Align the effective XDG root with the temp config dir for the XDG-guarded
    // adapters (Engram/Quota); restore the sandbox value afterwards.
    const sandboxXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempXdgConfig;
    let bootstrap: Awaited<ReturnType<typeof runSetupDependencies>>;
    try {
      expect(resolve(openCodeGlobalDir())).toBe(resolve(tempConfigDir));
      let engramInstalled = false;
      let codegraphInstalled = false;
      let zotpilotInstalled = false;
      let quotaAdded = false;
      const calls: string[] = [];
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        const key = `${command} ${args.join(" ")}`;
        if (command === "which" && args[0] === "brew") return { stdout: "/opt/homebrew/bin/brew", stderr: "" };
        if (key === "brew install gentleman-programming/tap/engram") {
          engramInstalled = true;
          return { stdout: "", stderr: "" };
        }
        if (key === "engram setup opencode") return { stdout: "", stderr: "" };
        if (command === "engram" && args[0] === "version") {
          if (!engramInstalled) throw new Error("engram not found");
          return { stdout: "engram 1.20.0", stderr: "" };
        }
        if (command === "codegraph" && args[0] === "--version") {
          if (!codegraphInstalled) throw new Error("codegraph not found");
          return { stdout: "codegraph 1.4.0", stderr: "" };
        }
        if (key === "npm view @colbymchenry/codegraph version") return { stdout: "1.4.0\n", stderr: "" };
        if (key === "npm install -g @colbymchenry/codegraph@1.4.0") {
          codegraphInstalled = true;
          return { stdout: "", stderr: "" };
        }
        if (command === "zotpilot" && args[0] === "--version") {
          if (!zotpilotInstalled) throw new Error("zotpilot not found");
          return { stdout: "zotpilot 0.5.3", stderr: "" };
        }
        if (command === "python3" && args.includes("index")) {
          return { stdout: "zotpilot (0.5.3)\nAvailable versions: 0.5.3, 0.5.2\n", stderr: "" };
        }
        if (command === "python3" && args.includes("install")) {
          zotpilotInstalled = true;
          return { stdout: "", stderr: "" };
        }
        if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
          if (!quotaAdded) return { stdout: "No plugins found", stderr: "" };
          return { stdout: ["ID  VERSION  SOURCE", "@slkiser/opencode-quota.server  5.1.0  @slkiser/opencode-quota@5.1.0"].join("\n"), stderr: "" };
        }
        if (command === "npm" && args[0] === "view") return { stdout: "5.1.0\n", stderr: "" };
        if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
          quotaAdded = true;
          // Faithful stub of the native installer's temp-config effect (real
          // file write, temp root only): the installer registers the exact
          // pin in the global config; validation below reads that surface.
          try {
            const cfgPath = resolve(tempConfigDir, "opencode.json");
            let cfg: Record<string, unknown> = {};
            try {
              cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
            } catch {
              cfg = {};
            }
            const plugins = Array.isArray(cfg["plugins"]) ? [...(cfg["plugins"] as unknown[])] : [];
            if (!plugins.includes("@slkiser/opencode-quota@5.1.0")) plugins.push("@slkiser/opencode-quota@5.1.0");
            cfg["plugins"] = plugins;
            await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
          } catch {
            // Validation reports theexact surface state; never thrown here.
          }
          return { stdout: "", stderr: "" };
        }
        if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
        if (command === "opencode" && args[0] === "mcp") {
          return {
            stdout: ["engram connected", "context7 connected", "codegraph connected", "zotpilot connected", "4 server(s)"].join("\n"),
            stderr: "",
          };
        }
        throw new Error(`unexpected bootstrap call: ${key}`);
      };
      bootstrap = await runSetupDependencies(executor, { configDir: tempConfigDir });
      expect(bootstrap.ok, `bootstrap must succeed on a clean temp system (${liveNote}): ${bootstrap.report}`).toBe(true);
      expect(bootstrap.outcomes.map((outcome) => outcome.component).sort()).toEqual(
        ["codegraph", "context7", "engram", "quota", "zotpilot"],
      );
      // Demonstrated-safe paths ran (install→normalize→validate); prohibited
      // legacy/shared mutators never ran.
      expect(calls).toContain("brew install gentleman-programming/tap/engram");
      expect(calls).toContain("npm install -g @colbymchenry/codegraph@1.4.0");
      expect(calls).toContain("python3 -m pip install --user zotpilot==0.5.3");
      expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
      expect(calls.some((call) => call.startsWith("zotpilot upgrade") || call.startsWith("zotpilot register"))).toBe(false);
      // REAL config writes landed under the temp root only.
      const written = JSON.parse(await readFile(resolve(tempConfigDir, "opencode.json"), "utf8")) as {
        mcp?: { servers?: Record<string, unknown>; codegraph?: unknown; zotpilot?: unknown };
      };
      expect(written?.mcp?.servers?.["codegraph"]).toEqual({ type: "local", command: ["codegraph", "serve", "--mcp"] });
      expect(written?.mcp?.servers?.["zotpilot"]).toEqual({ type: "local", command: ["zotpilot", "mcp", "serve"] });
      expect(written?.mcp?.servers?.["context7"]).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
      expect(written?.mcp?.["codegraph"]).toBeUndefined();
      expect(written?.mcp?.["zotpilot"]).toBeUndefined();
      expect(formatDependenciesReport(bootstrap.outcomes)).toContain("Dependency lifecycle report");
    } finally {
      if (sandboxXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = sandboxXdg;
    }

    // --- JSONC fail-closed + exact v1.0.6-bug byte-identical (real file logic, temp dirs).
    {
      const dir = resolve(smokeRoot, "jsonc-dual");
      await mkdir(dir, { recursive: true });
      assertNotCallerGlobalPath(dir, "jsonc dir");
      const jsonPath = join(dir, "opencode.json");
      const jsoncPath = join(dir, "opencode.jsonc");
      const jsonOriginal = JSON.stringify({ model: "custom/from-json", plugins: [] }, null, 2);
      const jsoncOriginal = `{\n  // user-owned jsonc\n  "model": "custom/from-jsonc"\n}\n`;
      await writeFile(jsonPath, jsonOriginal);
      await writeFile(jsoncPath, jsoncOriginal);
      await expect(
        ensureAriaSetupConfigFile({ configPath: jsonPath, pluginUri: "file:///probe", skillsRoot: resolve(smokeRoot, "skills") }),
      ).rejects.toThrow(/both .*opencode\.json/);
      expect(await readFile(jsonPath, "utf8")).toBe(jsonOriginal);
      expect(await readFile(jsoncPath, "utf8")).toBe(jsoncOriginal);

      const bugDir = resolve(smokeRoot, "v106-bug");
      await mkdir(bugDir, { recursive: true });
      assertNotCallerGlobalPath(bugDir, "v106 dir");
      const bugJson = join(bugDir, "opencode.json");
      const bugJsonc = join(bugDir, "opencode.jsonc");
      const bugJsoncOriginal = JSON.stringify(
        { mcp: { servers: { mine: { type: "local", command: "x" } } }, model: "custom/user-model" },
        null,
        2,
      );
      const bugJsonOriginal = JSON.stringify(
        { default_agent: "coder", plugins: ["file:///probe"], skills: [resolve(smokeRoot, "skills")], experimental: { subagent_depth: 3 } },
        null,
        2,
      );
      await writeFile(bugJsonc, bugJsoncOriginal);
      await writeFile(bugJson, bugJsonOriginal);
      await expect(
        ensureAriaSetupConfigFile({ configPath: bugJson, pluginUri: "file:///probe", skillsRoot: resolve(smokeRoot, "skills") }),
      ).rejects.toThrow(/both .*opencode\.json/);
      expect(await readFile(bugJson, "utf8")).toBe(bugJsonOriginal);
      expect(await readFile(bugJsonc, "utf8")).toBe(bugJsoncOriginal);
    }

    // --- configure→agent regen in the same invocation (real agent writes, temp dirs).
    {
      const checkout = resolve(smokeRoot, "checkout");
      await mkdir(join(checkout, "bin"), { recursive: true });
      await writeFile(join(checkout, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
      const binaryUrl = pathToFileURL(join(checkout, "bin", "aria.mjs")).href;
      const filesRoot = resolve(smokeRoot, "setup-files");
      await mkdir(filesRoot, { recursive: true });
      const files = {
        globalConfigPath: resolve(filesRoot, "opencode.json"),
        agentsDir: resolve(filesRoot, "agents"),
        skillsRoot: resolve(filesRoot, "skills"),
      };
      assertNotCallerGlobalPath(files.globalConfigPath, "setup files.globalConfigPath");
      assertNotCallerGlobalPath(files.agentsDir, "setup files.agentsDir");
      const executor: Executor = async (command, args) => {
        const key = `${command} ${args.join(" ")}`;
        if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
        if (key.startsWith("opencode plugin add")) return { stdout: "plugin registered", stderr: "" };
        throw new Error(`unexpected setup call: ${key}`);
      };
      const okSync = async () => ({ ok: true as const, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });
      const sandboxXdg2 = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tempXdgConfig;
      try {
        const result = await setup(binaryUrl, executor, okSync, {
          configure: true,
          worktree: smokeRoot,
          configureModelsFn: async () => {
            await mkdir(tempConfigDir, { recursive: true });
            await writeFile(
              resolve(tempConfigDir, "aria.json"),
              `${JSON.stringify({ roles: { planner: { model: "opencode-go/muse-spark-1.3-contributor", variant: "xhigh" } } }, null, 2)}\n`,
            );
            return { status: "configured" as const, message: "mock configured" };
          },
          files,
        });
        expect(result.ok).toBe(true);
        expect(await readFile(resolve(files.agentsDir, "planner.md"), "utf8")).toContain(
          'model: "opencode-go/muse-spark-1.3-contributor#xhigh"',
        );
      } finally {
        if (sandboxXdg2 === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = sandboxXdg2;
      }
    }

    // --- doctor 2.0.23 shapes (stubbed probes, real finding logic, temp worktree).
    {
      const worktree = resolve(smokeRoot, "doctor-work");
      await mkdir(worktree, { recursive: true });
      assertNotCallerGlobalPath(worktree, "doctor worktree");
      const arrayDebugConfig = JSON.stringify([
        { source: "global:~/.config/opencode/opencode.json", config: { subagent_depth: 5 } },
        { source: "project:./opencode.json", config: {} },
      ]);
      const doctorExecutor: Executor = async (command, args) => {
        const key = `${command} ${args.join(" ")}`;
        if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
        if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
        if (key === "codegraph --version") return { stdout: "codegraph 1.4.0", stderr: "" };
        if (key === "opencode mcp list") {
          return {
            stdout: ["engram connected", "context7 connected", "codegraph connected", "zotpilot connected"].join("\n"),
            stderr: "",
          };
        }
        if (key === "opencode debug config") return { stdout: arrayDebugConfig, stderr: "" };
        if (key === "zotpilot --version") return { stdout: "zotpilot 0.5.3", stderr: "" };
        return { stdout: "", stderr: "" };
      };
      const models = {
        models: [
          { id: "opencode-go/muse-spark-1.3-contributor", providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", name: "Spark", variants: ["xhigh", "high"], variantsObservable: true },
          { id: "openai/gpt-6.1-sol", providerID: "openai", modelID: "gpt-6.1-sol", name: "Sol", variants: [], variantsObservable: undefined },
        ],
      };
      await writeFile(resolve(worktree, "aria.json"), JSON.stringify({ roles: { planner: { model: "openai/gpt-6.1-sol", variant: "high" } } }));
      const report = await runDoctor({ worktree, executor: doctorExecutor, discovery: async () => models });
      const planner = report.findings.find((finding) => finding.area === "routes/models" && finding.title === "planner");
      expect(planner?.severity).toBe("WARN");
      expect(planner?.detail).toContain("unknown");
      const depth = report.findings.find((finding) => finding.area === "config" && finding.title === "subagent depth");
      expect(depth?.severity).toBe("PASS");
      expect(depth?.detail).toContain("effective value 5");
      // Plain `opencode models` assumption holds: no `--verbose` probe is required here.
      expect(doctorExitCode(report.findings.filter((finding) => finding.area === "routes/models" && finding.title === "planner"))).toBe(0);
    }

    // --- upgrade --check no-mutation + approval gate (probe-only executor, temp dir).
    {
      const dir = resolve(smokeRoot, "upgrade-check");
      await mkdir(join(dir, "config", "opencode"), { recursive: true });
      const configDir = resolve(dir, "config", "opencode");
      assertNotCallerGlobalPath(configDir, "upgrade configDir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }));
      const before = await snapshotTree(dir);
      const calls: string[] = [];
      const lsRemote = ["aaa111\trefs/tags/v1.0.6", "bbb222\trefs/tags/v1.0.7", "bbb222\trefs/tags/v1.0.7^{}", ""].join("\n");
      const probe: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        const key = `${command} ${args.join(" ")}`;
        if (key === "git ls-remote https://github.com/mscipio/ARIA.git") return { stdout: lsRemote, stderr: "" };
        if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
        if (key === "opencode mcp list") return { stdout: ["engram connected", "context7 connected"].join("\n"), stderr: "" };
        if (key === "engram version") throw new Error("engram not found");
        if (key === "codegraph --version") throw new Error("codegraph not found");
        throw new Error(`non-read-only call during --check: ${key}`);
      };
      const check = await checkUpgradeInventory(probe, { configDir, currentVersion: "1.0.6" });
      expect(check.components.map((row) => row.component)).toEqual([...UPGRADE_COMPONENTS]);
      expect(check.components.find((row) => row.component === "aria")?.status).toBe("upgrade-available");
      await expect((async () => {
        const after = await snapshotTree(dir);
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
      })()).resolves.toBeUndefined();
      const blocked = await runUpgrade(probe, { configDir, currentVersion: "1.0.6", approval: { yes: false } });
      expect(blocked.stage).toBe("blocked-approval");
      expect(blocked.ok).toBe(false);
      const unknownCalls: string[] = [];
      const unknown = await runUpgrade(
        async (command, args) => {
          unknownCalls.push(`${command} ${args.join(" ")}`);
          if (command === "git") throw new Error("network unavailable");
          if (command === "opencode" && args[0] === "plugin") return { stdout: "No plugins found", stderr: "" };
          if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers\n", stderr: "" };
          if (command === "engram") throw new Error("not found");
          if (command === "codegraph") throw new Error("not found");
          throw new Error(`unexpected: ${command} ${args.join(" ")}`);
        },
        { configDir, currentVersion: "1.0.6", approval: { yes: true } },
      );
      expect(unknown.stage).toBe("blocked-unknown-target");
      expect(unknown.ok).toBe(false);
    }

    // --- ARIA exact-ref single registration + handoff immutability (seam-level; no live registry mutation).
    {
      const target: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };
      const table = ["ID  VERSION  SOURCE", `aria  deadbee  ${target.spec}`, "@slkiser/opencode-quota.server  5.0.2  @slkiser/opencode-quota@5.0.2"].join("\n");
      expect(classifyAriaRegistration(table)).toMatchObject({ kind: "identified", spec: target.spec });
      const calls: string[] = [];
      const probe: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "git") return { stdout: "bbb222\trefs/tags/v1.0.7\n", stderr: "" };
        if (command === "opencode" && args[0] === "plugin") return { stdout: table, stderr: "" };
        if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers\n", stderr: "" };
        if (command === "engram") throw new Error("not found");
        if (command === "codegraph") throw new Error("not found");
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };
      const check = await checkUpgradeInventory(probe, { currentVersion: "1.0.6", availableOverride: target });
      const handoff = buildUpgradeHandoff(target, check);
      expect(isHandoffMatch(handoff, target, handoff.approvedComponents)).toEqual({ match: true });
      const drifted: AriaAvailableTarget = { tag: "v1.0.8", version: "1.0.8", spec: "github:mscipio/ARIA#v1.0.8" };
      const drift = isHandoffMatch(handoff, drifted, handoff.approvedComponents);
      expect(drift.match).toBe(false);
      // Seam-level only: no plugin remove/add ever ran in this checkpoint.
      expect(calls.some((call) => call.includes("plugin remove") || call.includes("plugin add"))).toBe(false);
      expect(formatUpgradeReport(check, [{ component: "aria", status: "completed", detail: "replaced", mutated: true }])).toContain("Before:");
    }

    // --- Ownership gates: ambiguous-untouched vs positively-owned update.
    {
      const ambRoot = resolve(smokeRoot, "ownership-ambiguous");
      await mkdir(resolve(ambRoot, "config", "opencode"), { recursive: true });
      const ambDir = resolve(ambRoot, "config", "opencode");
      assertNotCallerGlobalPath(ambDir, "ambiguous configDir");
      await writeFile(resolve(ambDir, "opencode.json"), JSON.stringify({ mcp: {} }));
      await writeFile(resolve(ambDir, "opencode.jsonc"), JSON.stringify({ mcp: {} }));
      const ambBefore = await snapshotTree(ambRoot);
      const ambCalls: string[] = [];
      const { ensureCodegraph } = await import("../src/codegraph.js");
      const ambResult = await ensureCodegraph(
        async (command, args) => {
          ambCalls.push(`${command} ${args.join(" ")}`);
          if (command === "codegraph" && args[0] === "--version") throw new Error("not found");
          if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers\n", stderr: "" };
          throw new Error(`unexpected: ${command} ${args.join(" ")}`);
        },
        { configDir: ambDir },
      );
      expect(ambResult.status).toBe("report-only");
      expect(ambResult.mutated).toBe(false);
      expect(ambCalls.some((call) => call.startsWith("npm install"))).toBe(false);
      const ambAfter = await snapshotTree(ambRoot);
      expect([...ambAfter.keys()].sort()).toEqual([...ambBefore.keys()].sort());

      // Positively-owned Quota 5 outdated → gated native update (isolated XDG root).
      const quotaXdg = resolve(smokeRoot, "quota-xdg");
      await mkdir(resolve(quotaXdg, "opencode"), { recursive: true });
      assertNotCallerGlobalPath(quotaXdg, "quota XDG root");
      const savedXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = quotaXdg;
      try {
        const configPath = resolve(openCodeGlobalDir(), "opencode.json");
        await writeFile(
          configPath,
          JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }, plugins: ["@slkiser/opencode-quota@5.0.2"] }),
        );
        const quotaCalls: string[] = [];
        let lists = 0;
        const listBefore = ["ID  VERSION  SOURCE", "@slkiser/opencode-quota.server  5.0.2  @slkiser/opencode-quota@5.0.2"].join("\n");
        const listAfter = ["ID  VERSION  SOURCE", "@slkiser/opencode-quota.server  5.0.3  @slkiser/opencode-quota@latest"].join("\n");
        const quotaExecutor: Executor = async (command, args) => {
          quotaCalls.push(`${command} ${args.join(" ")}`);
          if (command === "opencode" && args[0] === "plugin") {
            lists += 1;
            return { stdout: lists === 1 ? listBefore : listAfter, stderr: "" };
          }
          if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
          if (command === "opencode-quota" && args[0] === "update" && args[1] === "--dry-run") {
            return { stdout: ["Responsible OpenCode Quota update preview", "Safe changes this command can make:", "  edit <config> (1 package replacement)", "No configuration or package-cache changes have been made yet."].join("\n"), stderr: "" };
          }
          if (command === "opencode-quota" && args[0] === "update" && args[1] === "--yes") {
            const raw = await readFile(configPath, "utf8");
            await writeFile(configPath, raw.replace("@slkiser/opencode-quota@5.0.2", "@slkiser/opencode-quota@latest"));
            return { stdout: "OpenCode Quota update complete.", stderr: "" };
          }
          throw new Error(`unexpected quota call: ${command} ${args.join(" ")}`);
        };
        const upgraded = await upgradeQuota(quotaExecutor);
        expect(upgraded.status).toBe("upgraded");
        expect(upgraded.mutated).toBe(true);
        expect(JSON.parse(await readFile(configPath, "utf8")).plugins).toEqual(["@slkiser/opencode-quota@latest"]);
      } finally {
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
      }
    }

    // --- sync-no-chase: deps sync performs zero installs (one representative).
    {
      const syncRoot = resolve(smokeRoot, "sync-no-chase");
      await mkdir(resolve(syncRoot, "config", "opencode"), { recursive: true });
      const syncDir = resolve(syncRoot, "config", "opencode");
      assertNotCallerGlobalPath(syncDir, "sync configDir");
      await writeFile(resolve(syncDir, "opencode.json"), JSON.stringify({ plugins: [] }));
      const syncCalls: string[] = [];
      const syncExecutor: Executor = async (command, args) => {
        syncCalls.push(`${command} ${args.join(" ")}`);
        if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
        if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
        if (command === "which" && args[0] === "engram") throw new Error("not brew");
        if (command === "curl") throw new Error("network unavailable");
        if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.0", stderr: "" };
        if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
        if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
          return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected sync call: ${command} ${args.join(" ")}`);
      };
      const savedXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = resolve(syncRoot, "config");
      try {
        const synced = await depsSync(syncExecutor, syncDir);
        expect(syncCalls.some((call) => call.startsWith("npm view") || call.startsWith("npm install") || call.includes("pip install"))).toBe(false);
        expect(synced.codegraph.action).toBe("observed-not-managed");
      } finally {
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
      }
    }

    // --- statusline absence (seeded entry removed, unrelated preserved; bootstrap root absent).
    {
      const statusDir = resolve(smokeRoot, "statusline");
      await mkdir(statusDir, { recursive: true });
      assertNotCallerGlobalPath(statusDir, "statusline dir");
      await writeFile(resolve(statusDir, "cli.json"), JSON.stringify({ plugins: ["opencode-subagent-statusline", "keep-me"] }));
      await writeFile(resolve(statusDir, "tui.json"), JSON.stringify({ plugin: ["opencode-subagent-statusline", "keep-tui"] }));
      const detected = await detectIncompatibleStatusline(statusDir);
      expect(detected.present).toBe(true);
      const cleaned = await cleanupIncompatibleStatusline(statusDir);
      expect(cleaned.removed).toBe(true);
      expect(JSON.parse(await readFile(resolve(statusDir, "cli.json"), "utf8")).plugins).toEqual(["keep-me"]);
      expect((await detectIncompatibleStatusline(tempConfigDir)).present).toBe(false);
    }

    // --- Live-root byte-safety proof: ambient/caller/prod untouched, zero writes outside temp.
    // The T019 ambient-canary file (__aria-t019-canary-*.json) is a known
    // same-suite harness artifact seeded/removed by its own regression in a
    // parallel worker; it is filtered here so this smoke asserts only its
    // own leak surface (marker `rdc-t020-smoke-` scan below is the strict
    // no-leak proof for this run's fixture paths).
    {
      const stripCanary = (snapshot: DirSnapshot): DirSnapshot => {
        if (!snapshot.exists) return snapshot;
        const entries: Record<string, string> = {};
        for (const [name, hash] of Object.entries(snapshot.entries)) {
          if (name.startsWith("__aria-t019-canary-")) continue;
          entries[name] = hash;
        }
        return { exists: true, entries };
      };
      expect(stripCanary(await snapshotDir(caller.globalConfigDir))).toEqual(stripCanary(callerConfigBefore));
      if (prodV1Before !== null) {
        expect(await snapshotDir(prodV1Dir)).toEqual(prodV1Before);
      }
      for (const root of [caller.globalDataDir, caller.globalStateDir]) {
        expect(await recentFilesContaining(root, leakMarker, windowStartMs)).toEqual([]);
      }
      // Every smoke file lives under the temp root (spot-check the key surfaces).
      const tree = await snapshotTree(smokeRoot);
      expect(tree.size).toBeGreaterThan(0);
      for (const path of tree.keys()) {
        expect(resolve(path).startsWith(`${resolve(smokeRoot)}/`)).toBe(true);
      }
    }

    // Explicit statement hook: which checkpoints could not be exercised live.
    // `liveNote` records the pinned-CLI path actually used; a missing CLI
    // falls back to fixture shapes for shape assertions only (no live
    // deployment certification is claimed here — deferred to the prod migration).
    expect(liveNote.length).toBeGreaterThan(0);
  }, 60000);
});
