import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { getPackageRoot } from "../src/defaults.js";
import { runDoctor as runSrcDoctor } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import {
  classifyAriaRegistration as srcClassify,
  classifySetupIdentity as srcGate,
  isAriaRegistrationEntry as srcIsEntry,
  isRecognizedAriaGitSource as srcIsGit,
  setup as srcSetup,
  type PluginListEntry,
} from "../src/lifecycle.js";
import type { ModelDiscovery } from "../src/model-config.js";
import { ROLES } from "../src/routes.js";
import { buildUpgradeHandoff, runUpgrade, type AriaAvailableTarget } from "../src/upgrade.js";
import { selfUpgradeAria } from "../src/aria-upgrade.js";
// Compiled-dist parity: same verdicts as src, must fail if tracked dist goes stale.
import {
  classifyAriaRegistration as distClassify,
  classifySetupIdentity as distGate,
  isAriaRegistrationEntry as distIsEntry,
  isRecognizedAriaGitSource as distIsGit,
} from "../dist/lifecycle.js";
import { runDoctor as runDistDoctor } from "../dist/doctor.js";

/**
 * T013 duplicate-registration fail-closed + dist parity.
 *
 * Reuses the shared T012 classifier (`classifyAriaRegistration` /
 * `isAriaRegistrationEntry` in `src/lifecycle.ts`); no logic is
 * duplicated here. Every verdict below is asserted against both `src`
 * and compiled `dist` so a stale `dist/` fails the suite.
 */

const GIT_107 = "github:mscipio/ARIA#v1.0.7";
const GIT_106 = "github:mscipio/ARIA#v1.0.6";
const CHECKOUT = "/opt/aria-checkout";

function entry(id: string, version: string, target: string): PluginListEntry {
  return { id, version, target };
}

const matchesLocal = (target: string): boolean => target === CHECKOUT;
const matchesSpec107 = (target: string): boolean => target === GIT_107;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("T013 (a) duplicate identical ARIA Git rows are ambiguous fail-closed", () => {
  it("classifies byte-identical aria rows as ambiguous via the shared rule", () => {
    const entries = [entry("aria", "842e4ec", GIT_107), entry("aria", "842e4ec", GIT_107)];
    expect(srcClassify(entries).kind).toBe("ambiguous");
    expect(srcGate(entries, matchesSpec107).kind).toBe("ambiguous");
    expect(srcGate(entries, matchesSpec107).detail).toContain("more than once");
    // Identical dash-ID rows are likewise never deduplicated.
    const dashDup = [entry("-", "842e4ec", GIT_107), entry("-", "842e4ec", GIT_107)];
    expect(srcClassify(dashDup).kind).toBe("ambiguous");
    expect(srcGate(dashDup, matchesSpec107).kind).toBe("ambiguous");
  });

  it("rejects duplicate identical Git rows in setup before add, files, sync, and dependenciesFn", async () => {
    const root = await tempDir("aria-t013-setup-");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
    const binaryUrl = pathToFileURL(resolve(root, "bin", "aria.mjs")).href;
    const filesDir = await tempDir("aria-t013-files-");
    const files = {
      globalConfigPath: join(filesDir, "opencode.json"),
      agentsDir: join(filesDir, "agents"),
      skillsRoot: "/opt/aria-checkout/skills",
    };
    const listed = ["ID  VERSION  SOURCE", `aria  842e4ec  ${GIT_107}`, `aria  842e4ec  ${GIT_107}`].join("\n");
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args.join(" ") === "plugin list") return { stdout: listed, stderr: "" };
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    let syncCalled = false;
    let depsCalled = false;
    const result = await srcSetup(
      binaryUrl,
      executor,
      async () => {
        syncCalled = true;
        return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
      },
      {
        worktree: await tempDir("aria-t013-work-"),
        files,
        dependenciesFn: async () => {
          depsCalled = true;
          return { ok: true, outcomes: [], report: "must not run" };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup?.registration.detail).toContain("more than once");
    expect(calls.some((c) => c.includes("plugin add"))).toBe(false);
    expect(result.setup?.config).toBeUndefined();
    expect(syncCalled).toBe(false);
    expect(depsCalled).toBe(false);
  });
});

describe("T013 (b) local plus Git ARIA rows are ambiguous", () => {
  it("classifies matching local plus dash Git as ambiguous, never a unique match", () => {
    const entries = [entry("aria", "local", CHECKOUT), entry("-", "842e4ec", GIT_107)];
    expect(srcClassify(entries, matchesLocal).kind).toBe("ambiguous");
    expect(srcGate(entries, matchesLocal).kind).toBe("ambiguous");
    expect(srcGate(entries, matchesLocal).detail).toContain("more than once");
  });
});

describe("T013 (c) dash-ID Git registration is single, never absent", () => {
  it("recognizes `- <sha> github:mscipio/ARIA#vX` as one registration", () => {
    const single = [entry("-", "842e4ec", GIT_107)];
    expect(srcIsGit(GIT_107)).toBe(true);
    expect(srcIsEntry(single[0]!)).toBe(true);
    expect(srcClassify(single).kind).toBe("single");
    expect(srcGate(single, matchesLocal).kind).toBe("mismatch");
    expect(srcGate(single, matchesSpec107).kind).toBe("matching");
  });
});

describe("T013 (d) upgrade rejects duplicate identity before dependencies, removal, addition, handoff", () => {
  const TARGET_106: AriaAvailableTarget = { tag: "v1.0.6", version: "1.0.6", spec: GIT_106 };
  const TARGET_107: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: GIT_107 };

  function duplicateTable(): string {
    return ["ID  VERSION  SOURCE", `aria  842e4ec  ${GIT_107}`, `aria  842e4ec  ${GIT_107}`].join("\n");
  }

  it("runUpgrade blocks a duplicated registration with zero mutation (no dependenciesFn, remove, add, or handoff)", async () => {
    const configDir = resolve(await tempDir("aria-t013-upcfg-"), "opencode");
    await mkdir(configDir, { recursive: true });
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode plugin list") return { stdout: duplicateTable(), stderr: "" };
      if (key === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
      if (key === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
      if (key === "opencode mcp list") {
        return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected call: ${key}`);
    };
    let dependenciesCalls = 0;
    let selfUpgradeCalls = 0;
    const result = await runUpgrade(executor, {
      configDir,
      availableOverride: TARGET_107,
      approval: { yes: true },
      dependenciesFn: async () => {
        dependenciesCalls++;
        return { ok: true, outcomes: [], report: "must not run" };
      },
      selfUpgradeFn: async () => {
        selfUpgradeCalls++;
        return { ok: true, detail: "must not run" };
      },
    });
    void TARGET_106;
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("blocked-unknown-target");
    expect(result.check.selfUpgradeBlocked).toBe(true);
    expect(result.detail).toContain("multiple registrations");
    expect(dependenciesCalls).toBe(0);
    expect(selfUpgradeCalls).toBe(0);
    expect(calls.some((c) => c.includes("plugin remove"))).toBe(false);
    expect(calls.some((c) => c.includes("plugin add"))).toBe(false);
    expect(calls.some((c) => c.startsWith("npm exec"))).toBe(false);
  });

  it("selfUpgradeAria fails closed on duplicate identity with a single read-only probe", async () => {
    const rows: Array<[string, string, string]> = [
      ["aria", "842e4ec", GIT_107],
      ["aria", "842e4ec", GIT_107],
    ];
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[1] === "list") {
        return {
          stdout: ["ID  VERSION  SOURCE", ...rows.map((r) => `${r[0]}  ${r[1]}  ${r[2]}`)].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    let spawnCalls = 0;
    const check = {
      currentVersion: "1.0.6",
      cliVersion: "1.0.6",
      installedSpec: GIT_106,
      available: { kind: "known" as const, target: TARGET_107 },
      selfUpgradeBlocked: false,
      blockReason: null,
      components: [],
    } as never;
    const handoff = buildUpgradeHandoff(TARGET_107, check);
    const outcome = await selfUpgradeAria(TARGET_107, handoff, {
      executor,
      handoffSpawn: async () => {
        spawnCalls++;
        return { ok: true, detail: "must not run", stdout: "must not run" };
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("multiple ARIA registrations");
    expect(calls).toEqual(["opencode plugin list"]);
    expect(calls.some((c) => c.includes("plugin remove"))).toBe(false);
    expect(calls.some((c) => c.includes("plugin add"))).toBe(false);
    expect(spawnCalls).toBe(0);
  });
});

describe("T013 (e) compiled-dist versus source parity", () => {
  const CASES: Array<{ name: string; entries: PluginListEntry[]; expected: "single" | "ambiguous" | "absent" }> = [
    { name: "dash single", entries: [entry("-", "842e4ec", GIT_107)], expected: "single" },
    { name: "duplicate identical", entries: [entry("aria", "842e4ec", GIT_107), entry("aria", "842e4ec", GIT_107)], expected: "ambiguous" },
    {
      name: "local plus Git",
      entries: [entry("aria", "local", CHECKOUT), entry("-", "842e4ec", GIT_107)],
      expected: "ambiguous",
    },
    { name: "absent empty", entries: [], expected: "absent" },
    { name: "absent unrelated", entries: [entry("other", "1.0.0", "other-spec")], expected: "absent" },
  ];

  it("dist classifier matches src for dash, duplicate, local+Git, and absence", () => {
    for (const c of CASES) {
      const isLocal = c.name === "local plus Git" ? matchesLocal : undefined;
      expect(distClassify(c.entries, isLocal).kind, `dist ${c.name}`).toBe(c.expected);
      expect(srcClassify(c.entries, isLocal).kind, `src ${c.name}`).toBe(c.expected);
      expect(distClassify(c.entries, isLocal).kind, `parity ${c.name}`).toBe(srcClassify(c.entries, isLocal).kind);
    }
    // Setup-gate parity for the same cases.
    for (const c of CASES) {
      const isLocal = c.name === "local plus Git" ? matchesLocal : matchesSpec107;
      expect(distGate(c.entries, isLocal).kind, `dist gate ${c.name}`).toBe(srcGate(c.entries, isLocal).kind);
    }
    // Entry-predicate parity.
    for (const c of CASES) {
      for (const e of c.entries) {
        expect(distIsEntry(e), `dist entry ${c.name} ${e.id} ${e.target}`).toBe(srcIsEntry(e));
        expect(distIsGit(e.target), `dist git ${e.target}`).toBe(srcIsGit(e.target));
      }
    }
  });

  // Doctor parity harness (read-only, isolated HOME/worktree).
  const PROBE_MODELS: ModelDiscovery = {
    models: [
      {
        id: "test/probe",
        providerID: "test",
        modelID: "probe",
        name: "Probe",
        variants: [],
        variantsObservable: true,
      },
    ],
  };

  function harnessExecutor(pluginList: string | Error, calls: string[]): Executor {
    return async (command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);
      if (invocation === "opencode plugin list") {
        if (pluginList instanceof Error) throw pluginList;
        return { stdout: pluginList, stderr: "" };
      }
      if (invocation === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (invocation === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
      if (invocation === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
      if (invocation === "opencode mcp list") {
        return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
      }
      if (invocation === "opencode debug config") return { stdout: "{}", stderr: "" };
      if (command === "zotpilot") throw new Error("zotpilot: command not found");
      throw new Error(`unexpected probe: ${invocation}`);
    };
  }

  async function isolatedOptions() {
    const home = await tempDir("aria-t013-dist-home-");
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    const { mkdir: mk } = await import("node:fs/promises");
    const configDir = resolve(home, ".config", "opencode");
    await mk(configDir, { recursive: true });
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }),
    );
    const worktree = await tempDir("aria-t013-dist-work-");
    const agentsDir = await tempDir("aria-t013-dist-agents-");
    await writeFile(
      resolve(worktree, "aria.json"),
      JSON.stringify({ roles: Object.fromEntries(ROLES.map((r) => [r, { model: "test/probe" }])) }),
    );
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    // HOME must stay pointed at the isolated home during the doctor run;
    // restore after via caller: set again here for the run window.
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    const restore = () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    };
    return { home, worktree, agentsDir, restore };
  }

  function finding(report: Awaited<ReturnType<typeof runSrcDoctor>>, title: string) {
    return report.findings.find((f) => f.area === "identity" && f.title === title);
  }

  it("dist doctor matches src for dash, duplicate, local+Git, absence, and unknown", async () => {
    const packageRoot = getPackageRoot();
    const cases: Array<{ name: string; list: string | Error }> = [
      { name: "dash single", list: ["ID  VERSION  SOURCE", `-  842e4ec  ${GIT_107}`].join("\n") },
      {
        name: "duplicate identical",
        list: ["ID  VERSION  SOURCE", `aria  842e4ec  ${GIT_107}`, `aria  842e4ec  ${GIT_107}`].join("\n"),
      },
      {
        name: "local plus Git",
        list: ["ID  VERSION  SOURCE", `aria  local  ${packageRoot}`, `-  842e4ec  ${GIT_107}`].join("\n"),
      },
      { name: "absence", list: "No plugins found" },
      { name: "unknown probe failure", list: new Error("opencode plugin list failed: spawn opencode ENOENT") },
      { name: "unknown unrecognized", list: "something unexpected" },
    ];
    for (const c of cases) {
      const { worktree, agentsDir, restore } = await isolatedOptions();
      try {
        const srcCalls: string[] = [];
        const distCalls: string[] = [];
        const srcReport = await runSrcDoctor({
          worktree,
          agentsDir,
          executor: harnessExecutor(c.list, srcCalls),
          discovery: async () => PROBE_MODELS,
        });
        const distReport = await runDistDoctor({
          worktree,
          agentsDir,
          executor: harnessExecutor(c.list, distCalls),
          discovery: async () => PROBE_MODELS,
        });
        for (const title of ["ARIA plugin registration", "CLI/plugin identity"]) {
          expect(finding(distReport, title)?.severity, `dist doctor ${c.name} ${title}`).toBe(
            finding(srcReport, title)?.severity,
          );
        }
        // Pin the fail-closed direction so parity cannot mask a joint regression.
        if (c.name === "dash single") {
          expect(finding(srcReport, "ARIA plugin registration")?.severity).toBe("PASS");
          expect(finding(srcReport, "ARIA plugin registration")?.detail).toContain(GIT_107);
          expect(finding(srcReport, "CLI/plugin identity")?.severity).not.toBe("SKIP");
        }
        if (c.name === "duplicate identical" || c.name === "local plus Git") {
          expect(finding(srcReport, "ARIA plugin registration")?.severity).toBe("FAIL");
          expect(finding(srcReport, "ARIA plugin registration")?.detail).toContain("more than once");
          expect(finding(srcReport, "CLI/plugin identity")?.severity).toBe("SKIP");
        }
        if (c.name === "absence") {
          expect(finding(srcReport, "ARIA plugin registration")?.detail).toContain("definitely absent");
        }
        if (c.name.startsWith("unknown")) {
          expect(finding(srcReport, "ARIA plugin registration")?.severity).toBe("WARN");
          expect(finding(srcReport, "CLI/plugin identity")?.severity).toBe("SKIP");
        }
      } finally {
        restore();
      }
    }
  });
});
