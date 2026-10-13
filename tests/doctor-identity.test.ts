import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPackageRoot } from "../src/defaults.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import type { ModelDiscovery } from "../src/model-config.js";
import { ROLES } from "../src/routes.js";

/**
 * T001 ARIA identity regression coverage: the running CLI version/source is
 * reported separately from the registered plugin reference/version, the
 * OpenCode runtime version is reported separately from compatibility, and
 * the comparison FAILs only on a definite mismatch proven by exact version
 * evidence (otherwise SKIP/WARN, never guessed). All probes are read-only:
 * HOME and the worktree are byte-identical before and after.
 */

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
  const home = await mkdtemp(resolve(tmpdir(), "aria-identity-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-identity-worktree-"));
  tempDirs.push(worktree);
  return worktree;
}

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-identity-agents-"));
  tempDirs.push(dir);
  return dir;
}

/** Global OpenCode config with the Context7 remote MCP configured. */
async function writeContext7Config(home: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  // Mirror `openCodeGlobalDir` resolution (`$XDG_CONFIG_HOME/opencode`, else
  // `~/.config/opencode`) so detection reads the file this fixture writes
  // under the vitest sandbox and on a plain workstation alike.
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const configDir = xdg ? resolve(xdg, "opencode") : resolve(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({
    mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
  }));
}

async function readCliVersion(): Promise<string> {
  const raw = await readFile(resolve(getPackageRoot(), "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** Every route resolves to one discovered probe model (no route FAILs). */
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

interface IdentityHarness {
  worktree: string;
  agentsDir: string;
  calls: string[];
}

/** Executor with healthy probes plus a per-test `opencode plugin list`. */
function harnessExecutor(pluginList: string | Error, calls: string[], opencodeVersion = "opencode 2.0.23"): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    calls.push(invocation);
    if (invocation === "opencode plugin list") {
      if (pluginList instanceof Error) throw pluginList;
      return { stdout: pluginList, stderr: "" };
    }
    if (invocation === "opencode --version") return { stdout: opencodeVersion, stderr: "" };
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
}

async function harness(pluginList: string | Error, opencodeVersion = "opencode 2.0.23"): Promise<IdentityHarness & { options: Parameters<typeof runDoctor>[0] }> {
  const home = await makeHome();
  await writeContext7Config(home);
  const worktree = await makeWorktree();
  const agentsDir = await makeAgentsDir();
  await writeFile(
    resolve(worktree, "aria.json"),
    JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
  );
  const calls: string[] = [];
  const options = {
    worktree,
    agentsDir,
    executor: harnessExecutor(pluginList, calls, opencodeVersion),
    discovery: async () => PROBE_MODELS,
  };
  return { worktree, agentsDir, calls, options };
}

function identityFinding(report: Awaited<ReturnType<typeof runDoctor>>, title: string) {
  return report.findings.find((finding) => finding.area === "identity" && finding.title === title);
}

/** Recursive fixture snapshot: relative path -> file content or `<dir>`. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = resolve(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[key] = "<dir>";
        await walk(target, key);
      } else if (entry.isFile()) {
        out[key] = await readFile(target, "utf8");
      } else {
        out[key] = "<other>";
      }
    }
  };
  await walk(root, "");
  return out;
}

describe("T001 doctor ARIA identity", () => {
  it("surfaces a definite CLI/plugin mismatch without mutating config", async () => {
    const cliVersion = await readCliVersion();
    const registeredTag = cliVersion === "1.0.7" ? "v1.0.6" : "v1.0.7";
    const pluginList = ["ID  VERSION  SOURCE", `aria  842e4ec  github:mscipio/ARIA#${registeredTag}`].join("\n");
    const { worktree, options, calls } = await harness(pluginList);

    const homeBefore = await snapshotDir(process.env.HOME as string);
    const worktreeBefore = await snapshotDir(worktree);
    const report = await runDoctor(options);

    const cli = identityFinding(report, "ARIA CLI");
    expect(cli?.severity).toBe("PASS");
    expect(cli?.detail).toContain(cliVersion);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("PASS");
    expect(registration?.detail).toContain(`github:mscipio/ARIA#${registeredTag}`);

    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("FAIL");
    expect(comparison?.detail).toContain("definite mismatch");
    expect(comparison?.detail).toContain(cliVersion);
    expect(comparison?.detail).toContain(registeredTag);
    expect(doctorExitCode(report.findings)).toBe(1);

    // Read-only: the only mutating-adjacent probe is `opencode plugin list`
    // (a read), and no file state changed.
    expect(calls).toContain("opencode plugin list");
    for (const call of calls) {
      expect(call).not.toMatch(/plugin (add|remove|update)/);
    }
    expect(await snapshotDir(process.env.HOME as string)).toEqual(homeBefore);
    expect(await snapshotDir(worktree)).toEqual(worktreeBefore);
  });

  it("passes when the registered tag matches the running CLI", async () => {
    const cliVersion = await readCliVersion();
    const pluginList = ["ID  VERSION  SOURCE", `aria  ab12cd3  github:mscipio/ARIA#v${cliVersion}`].join("\n");
    const { options } = await harness(pluginList);
    const report = await runDoctor(options);

    expect(identityFinding(report, "ARIA plugin registration")?.severity).toBe("PASS");
    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("PASS");
    expect(comparison?.detail).toContain(cliVersion);
    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("treats a matching local checkout registration as the same identity", async () => {
    const packageRoot = getPackageRoot();
    const pluginList = ["ID  VERSION  SOURCE", `aria  local  ${packageRoot}`].join("\n");
    const { options } = await harness(pluginList);
    const report = await runDoctor(options);

    expect(identityFinding(report, "ARIA plugin registration")?.severity).toBe("PASS");
    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("PASS");
    expect(comparison?.detail).toContain("matches");
    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("fails a definitely absent registration and skips the comparison", async () => {
    const { options } = await harness("No plugins found");
    const report = await runDoctor(options);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("FAIL");
    expect(registration?.detail).toContain("definitely absent");
    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("SKIP");
    expect(comparison?.detail).toContain("definitely absent");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("fails a duplicated registration without comparing", async () => {
    const pluginList = [
      "ID  VERSION  SOURCE",
      "aria  842e4ec  github:mscipio/ARIA#v1.0.7",
      "aria  ab12cd3  github:mscipio/ARIA#v1.0.7",
    ].join("\n");
    const { options } = await harness(pluginList);
    const report = await runDoctor(options);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("FAIL");
    expect(registration?.detail).toContain("more than once");
    expect(identityFinding(report, "CLI/plugin identity")?.severity).toBe("SKIP");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("reports unknown registration explicitly when the list probe fails", async () => {
    const { options } = await harness(new Error("opencode plugin list failed: spawn opencode ENOENT"));
    const report = await runDoctor(options);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("WARN");
    expect(registration?.detail).toContain("unknown");
    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("SKIP");
    expect(comparison?.detail).toContain("unknown");
    expect(report.findings.filter((finding) => finding.area === "identity" && finding.severity === "FAIL")).toHaveLength(0);
  });

  it("reports unknown registration explicitly when the list output is unrecognized", async () => {
    const { options } = await harness("something unexpected");
    const report = await runDoctor(options);

    const registration = identityFinding(report, "ARIA plugin registration");
    expect(registration?.severity).toBe("WARN");
    expect(registration?.detail).toContain("unrecognized");
    expect(identityFinding(report, "CLI/plugin identity")?.severity).toBe("SKIP");
    expect(report.findings.filter((finding) => finding.area === "identity" && finding.severity === "FAIL")).toHaveLength(0);
  });

  it("leaves SHA/local evidence without exact version proof as unknown rather than guessing", async () => {
    const pluginList = ["ID  VERSION  SOURCE", "aria  842e4ec  /some/other/checkout"].join("\n");
    const { options } = await harness(pluginList);
    const report = await runDoctor(options);

    expect(identityFinding(report, "ARIA plugin registration")?.severity).toBe("PASS");
    const comparison = identityFinding(report, "CLI/plugin identity");
    expect(comparison?.severity).toBe("WARN");
    expect(comparison?.detail).toContain("unknown");
    expect(comparison?.detail).toContain("not guessed");
    expect(report.findings.filter((finding) => finding.area === "identity" && finding.severity === "FAIL")).toHaveLength(0);
  });

  it("reports the OpenCode runtime version separately from the compatibility verdict", async () => {
    const cliVersion = await readCliVersion();
    const pluginList = ["ID  VERSION  SOURCE", `aria  ab12cd3  github:mscipio/ARIA#v${cliVersion}`].join("\n");
    const { options } = await harness(pluginList, "opencode 2.0.26");
    const report = await runDoctor(options);

    const runtime = identityFinding(report, "OpenCode runtime");
    expect(runtime?.severity).toBe("PASS");
    expect(runtime?.detail).toContain("2.0.26");
    // The compatibility verdict stays a separate finding in `dependencies`.
    const compat = report.findings.find((finding) => finding.area === "dependencies" && finding.title === "OpenCode");
    expect(compat).toBeDefined();
    expect(compat).not.toBe(runtime);
  });

  it("reports an unknown OpenCode runtime version without failing the version fact", async () => {
    const home = await makeHome();
    await writeContext7Config(home);
    const worktree = await makeWorktree();
    const agentsDir = await makeAgentsDir();
    await writeFile(
      resolve(worktree, "aria.json"),
      JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
    );
    const executor: Executor = async (command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "opencode --version") throw new Error("opencode: command not found");
      return harnessExecutor("No plugins found", [], "opencode 2.0.23")(command, args);
    };
    const report = await runDoctor({
      worktree,
      agentsDir,
      executor,
      discovery: async () => PROBE_MODELS,
    });

    const runtime = identityFinding(report, "OpenCode runtime");
    expect(runtime?.severity).toBe("WARN");
    expect(runtime?.detail).toContain("unknown");
  });
});
