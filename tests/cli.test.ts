import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { assertNotCallerGlobalPath } from "./test-isolation.js";

// CLI-level coverage for bin/aria.mjs dispatch: the doctor branch must use
// the src/doctor.ts runner/formatter/exit-code contract, and the
// setup/update/deps-sync dispatch must remain unchanged.

const execFileAsync = promisify(execFile);

const binPath = fileURLToPath(new URL("../bin/aria.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const CLI_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// T019 — subprocess env isolation. CLI children must never inherit caller
// HOME/XDG_*/ENGRAM_DATA_DIR (those can point at live workstation config);
// every spawn gets sandbox roots under one shared temp dir instead. The
// per-call `env` extras still apply, but the five isolation keys always win
// so no caller XDG/HOME passthrough is possible.
// ---------------------------------------------------------------------------

const cliSandboxRoot = mkdtempSync(resolve(tmpdir(), "aria-cli-sandbox-"));
const cliSandboxEnv: NodeJS.ProcessEnv = {
  HOME: resolve(cliSandboxRoot, "home"),
  XDG_CONFIG_HOME: resolve(cliSandboxRoot, "config"),
  XDG_DATA_HOME: resolve(cliSandboxRoot, "data"),
  XDG_STATE_HOME: resolve(cliSandboxRoot, "state"),
  ENGRAM_DATA_DIR: resolve(cliSandboxRoot, "engram-data"),
};
for (const dir of Object.values(cliSandboxEnv)) {
  if (typeof dir === "string") {
    mkdirSync(dir, { recursive: true });
    assertNotCallerGlobalPath(dir, "CLI subprocess sandbox");
  }
}

function isolatedChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { HOME: _home, XDG_CONFIG_HOME: _xdgConfig, XDG_DATA_HOME: _xdgData, XDG_STATE_HOME: _xdgState, ENGRAM_DATA_DIR: _engram, ...rest } =
    process.env;
  void _home;
  void _xdgConfig;
  void _xdgData;
  void _xdgState;
  void _engram;
  const { HOME: _eHome, XDG_CONFIG_HOME: _eXdgConfig, XDG_DATA_HOME: _eXdgData, XDG_STATE_HOME: _eXdgState, ENGRAM_DATA_DIR: _eEngram, ...extraRest } =
    extra;
  void _eHome;
  void _eXdgConfig;
  void _eXdgData;
  void _eXdgState;
  void _eEngram;
  return { ...rest, ...extraRest, ...cliSandboxEnv };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = repoRoot): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd,
      env: isolatedChildEnv(env),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const configureFixtureRoots: string[] = [];
const probeFixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(configureFixtureRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(depsFixtureRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(setupFixtureRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(probeFixtureRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Deterministic `opencode` probe fixture for the four live-probe CLI tests
 * (doctor ×2, upgrade --check, bare upgrade). Under the T019 sandbox the
 * real `opencode mcp/plugin/debug/models` commands hang: they spawn a
 * managed `serve --service` that collides on the live service port
 * (127.0.0.1:49374 already in use) and retry until the test timeout
 * (see T016 instrumentation: isolated `opencode mcp list` exits 124, service
 * log shows port-in-use, while `--version`/engram/codegraph/zotpilot/git stay
 * fast). The fake keeps CLI behavior faithful (real doctor/upgrade code,
 * real exit-code contract, real formatting) while substituting only the
 * hanging external `opencode` service calls with instant deterministic
 * outputs; all assertions stay intact and no timeout is raised.
 */
const FAKE_OPENCODE_SOURCE = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "opencode 2.0.23"
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  echo "opencode v1.2.3"
  echo "mcp:"
  echo "  engram     connected"
  echo "  context7   connected"
  echo "  codegraph  connected"
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  echo "{}"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  echo "ID  VERSION  SOURCE"
  echo "aria  3a4dacb  github:mscipio/ARIA#v1.1.1"
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode-go/muse-spark-1.3-contributor"
  echo "openai/gpt-6-luna"
  echo "openai/gpt-6.1-sol"
  exit 0
fi
echo "unexpected fake opencode invocation: $@" >&2
exit 1
`;

async function makeProbeFixture(): Promise<{ fakeBinDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-probe-"));
  probeFixtureRoots.push(root);
  const fakeBinDir = resolve(root, "fakebin");
  await mkdir(fakeBinDir, { recursive: true });
  const fakeOpencode = resolve(fakeBinDir, "opencode");
  await writeFile(fakeOpencode, FAKE_OPENCODE_SOURCE, "utf8");
  await chmod(fakeOpencode, 0o755);
  return { fakeBinDir };
}

function probeEnv(fakeBinDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...extra, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` };
}

interface ConfigureFixture {
  root: string;
  binCopy: string;
  workdir: string;
  recordPath: string;
  opencodeMarker: string;
  fakeBinDir: string;
}

const CONFIGURE_STUB_SOURCE = `import { writeFileSync } from "node:fs";
export async function configureModels(worktree, options) {
  const recordPath = process.env.CONFIGURE_FIXTURE_RECORD;
  if (recordPath) {
    writeFileSync(
      recordPath,
      JSON.stringify({ worktree, argCount: arguments.length, hasOptions: options !== undefined }),
      "utf8",
    );
  }
  const status = process.env.CONFIGURE_FIXTURE_STATUS ?? "configured";
  if (status === "configured") return { status: "configured", message: "fixture configured ok" };
  if (status === "unchanged") return { status: "unchanged", message: "fixture unchanged ok" };
  if (status === "skipped") return { status: "skipped", message: "fixture skipped ok" };
  if (status === "failed") return { status: "failed", message: "fixture failed", error: "fixture discovery down" };
  if (status === "throw") throw new Error("fixture boom");
  throw new Error("unknown fixture status: " + status);
}
`;

/**
 * Isolated checkout for deterministic configure-dispatch coverage: an exact
 * copy of the real bin/aria.mjs paired with a stubbed dist/model-config.js.
 * The stub records its invocation (proving cwd/discovery routing) and returns
 * a caller-controlled outcome without contacting real providers. The fixture
 * contains no lifecycle.js/deps.js/doctor.js, so a configure path that
 * regressed into registration or sync work would fail to resolve its import.
 */
async function makeConfigureFixture(): Promise<ConfigureFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-configure-"));
  configureFixtureRoots.push(root);
  const binDir = resolve(root, "bin");
  const distDir = resolve(root, "dist");
  const workdir = resolve(root, "worktree");
  const fakeBinDir = resolve(root, "fakebin");
  await mkdir(binDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });

  const binCopy = resolve(binDir, "aria.mjs");
  await writeFile(binCopy, readFileSync(binPath, "utf8"), "utf8");
  await chmod(binCopy, 0o755);
  await writeFile(resolve(distDir, "model-config.js"), CONFIGURE_STUB_SOURCE, "utf8");

  const recordPath = resolve(root, "configure-call.json");
  const opencodeMarker = resolve(root, "opencode-called");
  const fakeOpencode = resolve(fakeBinDir, "opencode");
  await writeFile(fakeOpencode, `#!/bin/sh\necho "opencode called $@" >> "${opencodeMarker}"\nexit 1\n`, "utf8");
  await chmod(fakeOpencode, 0o755);

  return { root, binCopy, workdir, recordPath, opencodeMarker, fakeBinDir };
}

async function runFixtureBin(
  fixture: ConfigureFixture,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [fixture.binCopy, ...args], {
      cwd: fixture.workdir,
      env: {
        ...isolatedChildEnv(env),
        PATH: `${fixture.fakeBinDir}:${process.env.PATH ?? ""}`,
      },
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function readConfigureCall(recordPath: string): { worktree: string; argCount: number; hasOptions: boolean } {
  return JSON.parse(readFileSync(recordPath, "utf8")) as { worktree: string; argCount: number; hasOptions: boolean };
}

const depsFixtureRoots: string[] = [];

const DEPS_STUB_SOURCE = `import { writeFileSync } from "node:fs";
export async function checkUpgradeInventory(executor, options) {
  const recordPath = process.env.DEPS_FIXTURE_RECORD;
  if (recordPath) {
    writeFileSync(
      recordPath,
      JSON.stringify({ hasExecutor: executor !== undefined, options }),
      "utf8",
    );
  }
  return {
    currentVersion: null,
    cliVersion: null,
    installedSpec: null,
    available: { kind: "unknown", reason: "fixture: pinned unknown" },
    selfUpgradeBlocked: true,
    blockReason: "fixture",
    components: [
      { component: "engram", installed: "1.20.0", available: null, status: "unmanaged-observed", detail: "fixture engram observed" },
      { component: "quota", installed: null, available: null, status: "skipped", detail: "fixture nothing to upgrade" },
    ],
  };
}
export function formatDepsUpgradeProposal(check) {
  return ["STUB-PROPOSAL", ...check.components.map((row) => row.component)].join("\\n");
}
`;

interface DepsFixture {
  root: string;
  binCopy: string;
  workdir: string;
  recordPath: string;
}

/**
 * Isolated checkout for deterministic deps-dispatch coverage: an exact copy
 * of the real bin/aria.mjs paired with a stubbed dist/upgrade.js. The stub
 * records its inventory invocation and returns canned non-ARIA rows without
 * contacting any tool or network. dist/dependencies.js is deliberately
 * ABSENT, so any dispatch path that regressed into adapter-apply work would
 * fail its dynamic import.
 */
async function makeDepsFixture(): Promise<DepsFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-deps-"));
  depsFixtureRoots.push(root);
  const binDir = resolve(root, "bin");
  const distDir = resolve(root, "dist");
  const workdir = resolve(root, "worktree");
  await mkdir(binDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(workdir, { recursive: true });

  const binCopy = resolve(binDir, "aria.mjs");
  await writeFile(binCopy, readFileSync(binPath, "utf8"), "utf8");
  await chmod(binCopy, 0o755);
  await writeFile(resolve(distDir, "upgrade.js"), DEPS_STUB_SOURCE, "utf8");

  return { root, binCopy, workdir, recordPath: resolve(root, "deps-call.json") };
}

async function runDepsFixtureBin(
  fixture: DepsFixture,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [fixture.binCopy, ...args], {
      cwd: fixture.workdir,
      env: isolatedChildEnv(env),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const setupFixtureRoots: string[] = [];

const SETUP_STUB_SOURCE = `import { writeFileSync } from "node:fs";
export async function setup(...args) {
  const recordPath = process.env.SETUP_FIXTURE_RECORD;
  const options = args[3] ?? {};
  if (recordPath) {
    writeFileSync(
      recordPath,
      JSON.stringify({ argCount: args.length, configure: options.configure ?? null, hasPluginSpec: options.pluginSpec !== undefined }),
      "utf8",
    );
  }
  return {
    ok: true,
    stage: "setup",
    setup: {
      registration: { action: "already registered", detail: "fixture already registered" },
      sync: { ok: true, output: "fixture sync ok" },
      config: { changed: false, path: "fixture-config-path" },
      agents: { written: 0, unchanged: 11, dir: "fixture-agents-dir" },
      dependencies: { ok: true, outcomes: [] },
    },
  };
}
`;

const SETUP_DEPS_STUB_SOURCE = `export async function runSetupDependencies() {
  return { ok: true, outcomes: [] };
}
`;

interface SetupFixture {
  root: string;
  binCopy: string;
  workdir: string;
  recordPath: string;
}

/**
 * Isolated checkout for deterministic setup-dispatch coverage: an exact copy
 * of the real bin/aria.mjs paired with a stubbed dist/lifecycle.js (which
 * records the setup options it received and reports an already-registered
 * success) and a stubbed dist/dependencies.js. No doctor/routes/model-config
 * modules exist, so a setup path that regressed into those would fail its
 * dynamic import; a retired flag that regressed into setup work would invoke
 * the stub and leave a record behind.
 */
async function makeSetupFixture(): Promise<SetupFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-setup-"));
  setupFixtureRoots.push(root);
  const binDir = resolve(root, "bin");
  const distDir = resolve(root, "dist");
  const workdir = resolve(root, "worktree");
  await mkdir(binDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(workdir, { recursive: true });

  const binCopy = resolve(binDir, "aria.mjs");
  await writeFile(binCopy, readFileSync(binPath, "utf8"), "utf8");
  await chmod(binCopy, 0o755);
  await writeFile(resolve(distDir, "lifecycle.js"), SETUP_STUB_SOURCE, "utf8");
  await writeFile(resolve(distDir, "dependencies.js"), SETUP_DEPS_STUB_SOURCE, "utf8");

  return { root, binCopy, workdir, recordPath: resolve(root, "setup-call.json") };
}

async function runSetupFixtureBin(
  fixture: SetupFixture,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [fixture.binCopy, ...args], {
      cwd: fixture.workdir,
      env: isolatedChildEnv(env),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function readSetupCall(recordPath: string): { argCount: number; configure: boolean | null; hasPluginSpec: boolean } {
  return JSON.parse(readFileSync(recordPath, "utf8")) as { argCount: number; configure: boolean | null; hasPluginSpec: boolean };
}

describe("bin/aria.mjs doctor dispatch", () => {
  it("help documents the seven public forms with legacy update/configure/routes/deps-sync retired", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria doctor                Read-only health check of ARIA");
    expect(result.stdout).toContain("aria setup                 Register ARIA with OpenCode and install missing dependencies");
    expect(result.stdout).toContain("aria upgrade --check        Read-only upgrade inventory (current + available releases, component table)");
    expect(result.stdout).toContain("aria models                Print resolved model routes for each ARIA role");
    expect(result.stdout).toContain("aria models --config       Interactively configure ARIA role models");
    expect(result.stdout).toContain("aria deps                  Read-only dependency inventory");
    expect(result.stdout).toContain("aria deps --upgrade        Check managed dependencies");
    // Legacy public commands are retired (not advertised).
    expect(result.stdout).not.toContain("aria update ");
    expect(result.stdout).not.toContain("aria configure ");
    expect(result.stdout).not.toContain("aria routes ");
    expect(result.stdout).not.toContain("aria deps sync");
    // Internal handoff switches stay unadvertised.
    expect(result.stdout).not.toContain("--handoff-json");
    expect(result.stdout).not.toContain("--migrate-from");
  });

  it("renders plain human output with literal severity labels and separate ZotPilot CLI/MCP findings, with the exit code exactly matching the FAIL contract", async () => {
    const probe = await makeProbeFixture();
    const result = await runCli(["doctor"], probeEnv(probe.fakeBinDir));

    // Exit code is 0 iff no finding is FAIL (environment-dependent probe
    // results, so assert the contract relation rather than a fixed code).
    expect([0, 1]).toContain(result.code);
    expect(result.code).toBe(result.stdout.includes("[FAIL]") ? 1 : 0);

    // Compact human-only report with literal severity labels.
    expect(result.stdout.startsWith("ARIA doctor\n")).toBe(true);
    expect(result.stdout).toMatch(/\[(PASS|WARN|FAIL|SKIP)\]/);
    for (const area of ["package:", "config:", "routes/models:", "dependencies:", "zotpilot:", "skills:", "wiki:"]) {
      expect(result.stdout).toContain(area);
    }

    // ZotPilot CLI availability/version and ZotPilot MCP connectivity are
    // clearly separate findings, and the standalone live-inventory
    // limitation is visible.
    expect(result.stdout).toMatch(/\[(PASS|WARN)\] ZotPilot CLI/);
    expect(result.stdout).toMatch(/\[(PASS|WARN)\] ZotPilot MCP/);
    if (result.stdout.includes("[PASS] ZotPilot CLI")) {
      expect(result.stdout).toContain("via zotpilot --version");
    }
    expect(result.stdout).toContain("[SKIP] live tool inventory");
    expect(result.stdout).toContain("standalone aria doctor cannot compare expected/present/missing/unexpected live ZotPilot tool IDs");

    // Plain text only: no ANSI escapes, no JSON payload, no repair/install hints.
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
    for (const forbidden of ["npm install", "npm ci", "mcp serve"]) {
      expect(result.stdout).not.toContain(forbidden);
    }
    expect(result.stderr).toBe("");
  }, 60000);

  it("emits equally plain output under NO_COLOR", async () => {
    const probe = await makeProbeFixture();
    const result = await runCli(["doctor"], probeEnv(probe.fakeBinDir, { NO_COLOR: "1" }));

    expect(result.stdout.startsWith("ARIA doctor\n")).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(result.stderr).toBe("");
  }, 60000);

  it("retires legacy deps sync with guidance to the seven forms", async () => {
    const result = await runCli(["deps", "sync"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("retired");
    expect(result.stderr).toContain("Usage: aria deps [--upgrade [--yes]]");
  });

  it("rejects an unknown deps option before inventory work", async () => {
    const result = await runCli(["deps", "--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown deps option");
    expect(result.stderr).toContain("Usage: aria deps [--upgrade [--yes]]");
  });

  it("requires --upgrade for --yes before inventory work", async () => {
    const result = await runCli(["deps", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Option --yes requires --upgrade");
    expect(result.stderr).toContain("Usage: aria deps [--upgrade [--yes]]");
    expect(result.stdout).not.toContain("ARIA dependency inventory");
  });

  it("advertises the confirmation-gated upgrade form in help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria deps --upgrade --yes");
  });

  it("proposes without mutating: deps --upgrade without --yes exits nonzero with a read-only proposal", async () => {
    const fixture = await makeDepsFixture();

    // Unconfirmed: inventory runs, the proposal renders, and the missing
    // dist/dependencies.js proves the adapter-apply path is never imported.
    await rm(fixture.recordPath, { force: true });
    const proposed = await runDepsFixtureBin(fixture, ["deps", "--upgrade"], {
      DEPS_FIXTURE_RECORD: fixture.recordPath,
    });
    expect(proposed.code).toBe(1);
    expect(proposed.stdout).toContain("STUB-PROPOSAL");
    expect(proposed.stdout).toContain("engram");
    expect(proposed.stdout).not.toContain("[FAIL]");
    expect(proposed.stderr).toBe("");
    expect(existsSync(fixture.recordPath)).toBe(true);

    // Bare inventory: same stubbed rows, exit 0, no approval language.
    await rm(fixture.recordPath, { force: true });
    const inventoried = await runDepsFixtureBin(fixture, ["deps"], {
      DEPS_FIXTURE_RECORD: fixture.recordPath,
    });
    expect(inventoried.code).toBe(0);
    expect(inventoried.stdout).toContain("ARIA dependency inventory (read-only; no changes were made)");
    expect(inventoried.stdout).toContain("installed=1.20.0");
    expect(inventoried.stdout).not.toContain("STUB-PROPOSAL");
    expect(inventoried.stderr).toBe("");
    expect(existsSync(fixture.recordPath)).toBe(true);

    // Confirmed: --yes routes to the apply import, which is absent in the
    // fixture, so it fails closed before any adapter work.
    const approved = await runDepsFixtureBin(fixture, ["deps", "--upgrade", "--yes"], {
      DEPS_FIXTURE_RECORD: fixture.recordPath,
    });
    expect(approved.code).toBe(1);
    expect(approved.stderr).toContain("Dependencies: [FAIL]");
    expect(approved.stdout).not.toContain("STUB-PROPOSAL");
  });
});

describe("bin/aria.mjs setup dispatch", () => {
  it("rejects an unknown setup option before registration work", async () => {
    const result = await runCli(["setup", "--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown setup option");
    expect(result.stderr).toContain("Usage: aria setup");
    // Rejected before the dynamic import/call: no setup phases ran.
    expect(result.stdout).not.toContain("Registration:");
  });

  it("rejects a missing --plugin-spec value before registration work", async () => {
    const result = await runCli(["setup", "--plugin-spec"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --plugin-spec");
    expect(result.stderr).toContain("Usage: aria setup");
    expect(result.stdout).not.toContain("Registration:");
  });

  it("retires setup --configure with guidance to models --config before registration work", async () => {
    const result = await runCli(["setup", "--configure"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aria setup --configure has been retired. Use `aria models --config`.");
    expect(result.stderr).toContain("Usage: aria setup");
    // Rejected before the dynamic import/call: no setup phases ran.
    expect(result.stdout).not.toContain("Registration:");
    expect(result.stdout).not.toContain("Model configuration:");
  });

  it("advertises only the supported v1.1.x setup surface in help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria setup                 Register ARIA with OpenCode and install missing dependencies");
    expect(result.stdout).toContain("aria models --config       Interactively configure ARIA role models");
    expect(result.stdout).not.toContain("setup --configure");
    expect(result.stdout).not.toContain("--plugin-spec");
  });

  it("routes bare setup to the lifecycle without the retired configure flag", async () => {
    const fixture = await makeSetupFixture();
    // The fixture isolates bare setup to its lifecycle stub: no doctor,
    // routes, or model-config modules exist for the copied CLI to regress
    // into, and --configure must reject before the stub is ever imported.
    expect(existsSync(resolve(fixture.root, "dist", "doctor.js"))).toBe(false);

    await rm(fixture.recordPath, { force: true });
    const result = await runSetupFixtureBin(fixture, ["setup"], {
      SETUP_FIXTURE_RECORD: fixture.recordPath,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Registration: plugin already registered");
    expect(result.stderr).toBe("");

    // The normal setup path still reaches the lifecycle with the retired
    // flag off and no compatibility spec.
    const call = readSetupCall(fixture.recordPath);
    expect(call.configure).toBe(false);
    expect(call.hasPluginSpec).toBe(false);

    // The retired flag rejects before the lifecycle import: the stub never ran.
    await rm(fixture.recordPath, { force: true });
    const retired = await runSetupFixtureBin(fixture, ["setup", "--configure"], {
      SETUP_FIXTURE_RECORD: fixture.recordPath,
    });

    expect(retired.code).toBe(1);
    expect(retired.stderr).toContain("aria setup --configure has been retired. Use `aria models --config`.");
    expect(retired.stderr).toContain("Usage: aria setup");
    expect(retired.stdout).not.toContain("Registration:");
    expect(existsSync(fixture.recordPath)).toBe(false);
  });
});

describe("bin/aria.mjs upgrade dispatch", () => {
  it("help documents upgrade --check/--yes as ARIA-only and offers no --aria-only/--deps-only", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria upgrade               Show upgrade inventory (requires --yes to approve any mutation; ARIA-only)");
    expect(result.stdout).toContain("aria upgrade --check        Read-only upgrade inventory (current + available releases, component table)");
    expect(result.stdout).toContain("aria upgrade --yes          Approve and run the ARIA-only upgrade pipeline");
    expect(result.stdout).not.toContain("--aria-only");
    expect(result.stdout).not.toContain("--deps-only");
  });

  it("rejects an unknown upgrade option before inventory work", async () => {
    const result = await runCli(["upgrade", "--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown upgrade option");
    expect(result.stderr).toContain("Usage: aria upgrade [--check] [--yes]");
    // Rejected before any probe or pipeline work: no inventory report.
    expect(result.stdout).not.toContain("ARIA upgrade check");
  });

  it("rejects --aria-only and --deps-only (not offered in v1.0.7)", async () => {
    for (const flag of ["--aria-only", "--deps-only"]) {
      const result = await runCli(["upgrade", flag]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unknown upgrade option");
      expect(result.stdout).not.toContain("ARIA upgrade check");
    }
  });

  it("rejects combining --check with --yes (--check is strictly read-only)", async () => {
    const result = await runCli(["upgrade", "--check", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be combined");
    expect(result.stdout).not.toContain("ARIA upgrade check");
  });

  it("reports read-only inventory via --check with current AND available releases plus the component table", async () => {
    const probe = await makeProbeFixture();
    const result = await runCli(["upgrade", "--check"], probeEnv(probe.fakeBinDir));

    // Read-only inventory always reports (exit 0) even when the available
    // target is unknown (offline registry, missing CLIs, ambiguous config).
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ARIA upgrade check");
    expect(result.stdout).toContain("Current release:");
    expect(result.stdout).toContain("Available release:");
    for (const token of ["Component", "Installed", "Available", "Status"]) {
      expect(result.stdout).toContain(token);
    }
    expect(result.stderr).toBe("");
  }, 60000);

  it("requires explicit approval: bare upgrade mutates nothing and exits nonzero", async () => {
    const probe = await makeProbeFixture();
    const result = await runCli(["upgrade"], probeEnv(probe.fakeBinDir));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("ARIA upgrade check");
    expect(result.stdout).toContain("Upgrade: blocked (explicit approval required)");
  }, 60000);

  it("rejects a missing --handoff-json value before handoff work", async () => {
    const result = await runCli(["upgrade", "--handoff-json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --handoff-json");
    expect(result.stdout).not.toContain("ARIA upgrade check");
  });

  it("rejects combining --handoff-json with --check (--check is strictly read-only)", async () => {
    const result = await runCli(["upgrade", "--check", "--handoff-json", "{}"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be combined");
    expect(result.stdout).not.toContain("ARIA upgrade check");
  });

  it("fails a malformed handoff payload closed with zero mutation", async () => {
    const result = await runCli(["upgrade", "--handoff-json", "not-json"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Upgrade: stopped (drift-blocked)");
    expect(result.stdout).not.toContain("ARIA upgrade check");
    expect(result.stderr).toBe("");
  }, 60000);

  it("stops a drifted handoff payload for fresh approval with zero mutation", async () => {
    const payload = JSON.stringify({
      kind: "aria-upgrade-handoff",
      handoffVersion: 1,
      target: { tag: "v9.9.9", version: "9.9.9", spec: "github:mscipio/ARIA#v9.9.9" },
      approvedComponents: ["aria", "engram", "context7", "codegraph", "zotpilot", "quota"],
      before: {},
    });
    const result = await runCli(["upgrade", "--handoff-json", payload]);

    // The receiving release is v1.0.6, never v9.9.9: drift-blocked before any
    // component work, with no mutation possible on this path.
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Upgrade: stopped (drift-blocked)");
    expect(result.stdout).toContain("drift");
    expect(result.stderr).toBe("");
  }, 60000);
});

describe("bin/aria.mjs models dispatch (T002 surface gating for T003)", () => {
  it("retires bare configure/routes/update with guidance to the seven forms", async () => {
    for (const [args, fragment] of [
      [["configure"], "aria models --config"],
      [["routes"], "aria models"],
      [["update"], "aria upgrade"],
    ] as const) {
      const result = await runCli([...args]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("retired");
      expect(result.stderr).toContain(fragment);
    }
  });

  it("prints the compact role/model/effort table from resolved routes", async () => {
    // Sandboxed HOME plus no repo-root project overrides: the packaged
    // defaults render, so one representative row proves the table reflects
    // the resolved configuration through the public `models` form.
    const result = await runCli(["models"], {}, cliSandboxEnv.HOME);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("role  model  effort");
    expect(result.stdout).toContain("coder  opencode-go/muse-spark-1.3-contributor  xhigh");
    expect(result.stdout).toContain("reviewer  openai/gpt-6.1-sol  medium");
  });

  it("rejects an unsupported models flag before doing configuration work", async () => {
    const result = await runCli(["models", "--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown models option");
    expect(result.stderr).toContain("Usage: aria models [--config]");
    // Rejected before configuration work: no model-configuration report.
    expect(result.stdout).not.toContain("Model configuration:");
  });

  it("maps non-TTY skipped configuration to exit 0 without registration or sync", async () => {
    // execFile provides no TTY, so configureModels takes its deterministic
    // non-TTY skipped path before model discovery (no providers needed).
    const result = await runCli(["models", "--config"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Model configuration: skipped.");
    // Models --config never runs the setup phases.
    expect(result.stdout).not.toContain("Registration:");
    expect(result.stdout).not.toContain("Sync:");
  });

  it("executes configured/unchanged/skipped outcomes to exit 0 with cwd routing and no registration or sync", async () => {
    const fixture = await makeConfigureFixture();
    // The fixture isolates models --config to its model-config stub: no
    // lifecycle/deps/doctor modules exist for the copied CLI to regress into.
    expect(existsSync(resolve(fixture.root, "dist", "lifecycle.js"))).toBe(false);

    const cases = [
      { status: "configured", fragment: "[OK] fixture configured ok" },
      { status: "unchanged", fragment: "unchanged. fixture unchanged ok" },
      { status: "skipped", fragment: "skipped. fixture skipped ok" },
    ] as const;
    for (const { status, fragment } of cases) {
      await rm(fixture.recordPath, { force: true });
      await rm(fixture.opencodeMarker, { force: true });
      const result = await runFixtureBin(fixture, ["models", "--config"], {
        CONFIGURE_FIXTURE_STATUS: status,
        CONFIGURE_FIXTURE_RECORD: fixture.recordPath,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Model configuration: ${fragment}`);
      expect(result.stdout).not.toContain("Registration:");
      expect(result.stdout).not.toContain("Sync:");
      expect(result.stderr).toBe("");

      // Called once with the subprocess cwd and no option overrides, so the
      // CLI uses the existing implementation with its normal discovery
      // defaults (deterministically stubbed here, never real providers).
      const call = readConfigureCall(fixture.recordPath);
      expect(call.worktree).toBe(fixture.workdir);
      expect(call.argCount).toBe(1);
      expect(call.hasOptions).toBe(false);
      expect(existsSync(fixture.opencodeMarker)).toBe(false);
    }
  });

  it("executes failed/thrown outcomes to nonzero with a [FAIL] report", async () => {
    const fixture = await makeConfigureFixture();

    const failed = await runFixtureBin(fixture, ["models", "--config"], {
      CONFIGURE_FIXTURE_STATUS: "failed",
      CONFIGURE_FIXTURE_RECORD: fixture.recordPath,
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Model configuration: [FAIL]");
    expect(failed.stderr).toContain("fixture discovery down");
    expect(failed.stdout).not.toContain("Registration:");
    expect(failed.stdout).not.toContain("Sync:");
    const failedCall = readConfigureCall(fixture.recordPath);
    expect(failedCall.worktree).toBe(fixture.workdir);
    expect(failedCall.argCount).toBe(1);
    expect(existsSync(fixture.opencodeMarker)).toBe(false);

    await rm(fixture.recordPath, { force: true });
    await rm(fixture.opencodeMarker, { force: true });
    const thrown = await runFixtureBin(fixture, ["models", "--config"], {
      CONFIGURE_FIXTURE_STATUS: "throw",
      CONFIGURE_FIXTURE_RECORD: fixture.recordPath,
    });
    expect(thrown.code).toBe(1);
    expect(thrown.stderr).toContain("Model configuration: [FAIL]");
    expect(thrown.stderr).toContain("fixture boom");
    expect(thrown.stdout).not.toContain("Registration:");
    expect(thrown.stdout).not.toContain("Sync:");
    expect(existsSync(fixture.opencodeMarker)).toBe(false);
  });

  it("rejects a trailing flag in the fixture before invoking configuration work", async () => {
    const fixture = await makeConfigureFixture();

    const result = await runFixtureBin(fixture, ["models", "--bogus"], {
      CONFIGURE_FIXTURE_STATUS: "configured",
      CONFIGURE_FIXTURE_RECORD: fixture.recordPath,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown models option");
    expect(result.stderr).toContain("Usage: aria models [--config]");
    expect(result.stdout).not.toContain("Model configuration:");
    // Rejected before the dynamic import/call: the stub never ran.
    expect(existsSync(fixture.recordPath)).toBe(false);
    expect(existsSync(fixture.opencodeMarker)).toBe(false);
  });
});
