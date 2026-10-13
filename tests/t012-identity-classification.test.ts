import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPackageRoot } from "../src/defaults.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import { classifyAriaRegistration, classifySetupIdentity, type PluginListEntry } from "../src/lifecycle.js";
import type { ModelDiscovery } from "../src/model-config.js";
import { ROLES } from "../src/routes.js";

/**
 * T012 shared ARIA registration identity: one classification rule for
 * lifecycle gating (`classifySetupIdentity`) and doctor reporting.
 * Ambiguous identity (matching local plus `- github:...`, duplicate
 * matching Git/TUI rows, multiple/conflicting rows) fails closed; doctor
 * recognizes ID `-` Git-package rows as positively identified registration
 * and never reports definitely absent or skips comparison when present.
 * Exactly one positively identified registration may proceed; true absence
 * stays distinct from unknown.
 */

const GIT_107 = "github:mscipio/ARIA#v1.0.7";
const GIT_106 = "github:mscipio/ARIA#v1.0.6";
const CHECKOUT = "/opt/aria-checkout";

function entry(id: string, version: string, target: string): PluginListEntry {
  return { id, version, target };
}

const matchesLocal = (target: string): boolean => target === CHECKOUT;
const matchesSpec107 = (target: string): boolean => target === GIT_107;

describe("T012 shared classification rule", () => {
  it("classifies a single `- github:...` row as single, never absent", () => {
    const entries = [entry("-", "842e4ec", GIT_107)];
    expect(classifyAriaRegistration(entries).kind).toBe("single");
    // Against a local intended target it is a definite mismatch (not absent/matching).
    const gate = classifySetupIdentity(entries, matchesLocal);
    expect(gate.kind).toBe("mismatch");
    expect(gate.detail).toContain("definite mismatch");
    // Against the verbatim Git-spec intended target it is a unique match.
    expect(classifySetupIdentity(entries, matchesSpec107).kind).toBe("matching");
  });

  it("treats duplicate matching Git/TUI rows as ambiguous, never a unique match", () => {
    const entries = [entry("-", "842e4ec", GIT_107), entry("-", "ab12cd3", GIT_107)];
    expect(classifyAriaRegistration(entries).kind).toBe("ambiguous");
    const gate = classifySetupIdentity(entries, matchesSpec107);
    expect(gate.kind).toBe("ambiguous");
    expect(gate.detail).toContain("more than once");
  });

  it("treats matching local plus `- github:...` as ambiguous, never a unique match", () => {
    const entries = [entry("aria", "local", CHECKOUT), entry("-", "842e4ec", GIT_107)];
    expect(classifyAriaRegistration(entries, matchesLocal).kind).toBe("ambiguous");
    const gate = classifySetupIdentity(entries, matchesLocal);
    expect(gate.kind).toBe("ambiguous");
    expect(gate.detail).toContain("more than once");
  });

  it("treats conflicting ARIA registrations as ambiguous, never a unique match", () => {
    const entries = [entry("aria", "842e4ec", GIT_107), entry("aria", "abc1234", GIT_106)];
    expect(classifyAriaRegistration(entries).kind).toBe("ambiguous");
    const gateLocal = classifySetupIdentity(entries, matchesLocal);
    expect(["ambiguous", "mismatch"]).toContain(gateLocal.kind);
    expect(gateLocal.kind).not.toBe("matching");
    expect(gateLocal.kind).not.toBe("absent");
    const gateSpec = classifySetupIdentity(entries, matchesSpec107);
    expect(gateSpec.kind).toBe("ambiguous");
  });

  it("keeps true absence distinct from unknown", () => {
    expect(classifyAriaRegistration([]).kind).toBe("absent");
    expect(classifyAriaRegistration([entry("other", "1.0.0", "other-spec")]).kind).toBe("absent");
    expect(classifySetupIdentity([], matchesLocal).kind).toBe("absent");
    expect(classifySetupIdentity([], matchesLocal).detail).toContain("definitely absent");
  });

  it("allows a unique exact registration", () => {
    expect(classifySetupIdentity([entry("aria", "local", CHECKOUT)], matchesLocal).kind).toBe("matching");
    expect(classifySetupIdentity([entry("aria", "842e4ec", GIT_107)], matchesSpec107).kind).toBe("matching");
  });
});

// --- Doctor harness (read-only, isolated HOME/worktree) ---

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalWikiDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalWikiDir = process.env.WIKI_DIR;
  delete process.env.WIKI_DIR;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "aria-t012-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-t012-worktree-"));
  tempDirs.push(worktree);
  return worktree;
}

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-t012-agents-"));
  tempDirs.push(dir);
  return dir;
}

async function writeContext7Config(home: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const configDir = xdg ? resolve(xdg, "opencode") : resolve(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({
    mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
  }));
}

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

async function doctorHarness(pluginList: string | Error) {
  const home = await makeHome();
  await writeContext7Config(home);
  const worktree = await makeWorktree();
  const agentsDir = await makeAgentsDir();
  await writeFile(
    resolve(worktree, "aria.json"),
    JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
  );
  const calls: string[] = [];
  return {
    options: {
      worktree,
      agentsDir,
      executor: harnessExecutor(pluginList, calls),
      discovery: async () => PROBE_MODELS,
    },
  };
}

function identityFinding(report: Awaited<ReturnType<typeof runDoctor>>, title: string) {
  return report.findings.find((finding) => finding.area === "identity" && finding.title === title);
}

describe("T012 doctor recognizes dash-row Git registration", () => {
  it("recognizes a single `- ... github:...#v1.0.7` row and compares instead of absent/skip", async () => {
    const pluginList = ["ID  VERSION  SOURCE", `-  842e4ec  ${GIT_107}`].join("\n");
    const { options } = await doctorHarness(pluginList);
    const report = await runDoctor(options);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("PASS");
    expect(registration?.detail).toContain(GIT_107);
    expect(registration?.detail).not.toContain("definitely absent");

    const comparison = identityFinding(report, "CLI/plugin identity");
    // CLI is 1.0.8 vs registered v1.0.7: a definite mismatch, never SKIP.
    const cliRaw = await readFile(resolve(getPackageRoot(), "package.json"), "utf8");
    const cliVersion = (JSON.parse(cliRaw) as { version: string }).version;
    if (cliVersion === "1.0.7") {
      expect(comparison?.severity).toBe("PASS");
    } else {
      expect(comparison?.severity).toBe("FAIL");
      expect(comparison?.detail).toContain("definite mismatch");
    }
    expect(comparison?.severity).not.toBe("SKIP");
    expect(doctorExitCode(report.findings)).toBe(comparison?.severity === "FAIL" ? 1 : 0);
  });

  it("reports duplicate/conflicting rows as duplicated without guessing", async () => {
    const duplicated = ["ID  VERSION  SOURCE", `aria  842e4ec  ${GIT_107}`, `-  ab12cd3  ${GIT_107}`].join("\n");
    const { options: dupOptions } = await doctorHarness(duplicated);
    const dupReport = await runDoctor(dupOptions);
    expect(identityFinding(dupReport, "ARIA plugin registration")?.severity).toBe("FAIL");
    expect(identityFinding(dupReport, "ARIA plugin registration")?.detail).toContain("more than once");
    expect(identityFinding(dupReport, "CLI/plugin identity")?.severity).toBe("SKIP");

    const conflicting = ["ID  VERSION  SOURCE", `aria  842e4ec  ${GIT_107}`, `aria  abc1234  ${GIT_106}`].join("\n");
    const { options: confOptions } = await doctorHarness(conflicting);
    const confReport = await runDoctor(confOptions);
    expect(identityFinding(confReport, "ARIA plugin registration")?.severity).toBe("FAIL");
    expect(identityFinding(confReport, "CLI/plugin identity")?.severity).toBe("SKIP");
  });

  it("keeps true absence as definitely absent with skipped comparison", async () => {
    const { options } = await doctorHarness("No plugins found");
    const report = await runDoctor(options);
    expect(identityFinding(report, "ARIA plugin registration")?.detail).toContain("definitely absent");
    expect(identityFinding(report, "CLI/plugin identity")?.severity).toBe("SKIP");
  });
});
