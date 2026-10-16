import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T006 v1.1.0 release-readiness gate: isolated global-package installation.
//
// The candidate is packed (`npm pack`) and installed to an isolated
// `--prefix` (no `npm link`, never the live global). Every CLI
// invocation below runs the BARE installed `aria` (the prefix's
// `bin/aria`), never `node ./bin/aria.mjs`. Development remains
// `node ./bin/aria.mjs`; this suite never mutates the live installation.
//
// Proportional scope (rdc-testing-discipline): one representative check per
// public form plus the core mutation boundaries — not exhaustive branch
// coverage. Focused unit boundaries (setup install-if-missing, doctor
// read-only, upgrade ARIA-only, deps confirmation gates) remain owned by
// t002/t004/t005/routes/cli.dispatch; this gate proves the PACKAGED
// candidate preserves them end to end.
//
// Live-mutation boundary (human execution): the harness NEVER runs
// `aria setup` (full), `aria deps --upgrade --yes`, or `aria upgrade --yes`
// — those mutate workstation tools/registration beyond HOME isolation
// (global npm/pip/brew, plugin registry) and risk harness timeout/unsafe
// retry. The unconfirmed/proposal/blocked paths below prove the gates;
// the confirmed commands are prepared for manual execution (see task
// return) and resumed only with read-only verification afterwards.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string })
  .version;

const CLI_TIMEOUT_MS = 120_000;
const SLOW_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 240_000;

const t006Roots: string[] = [];
let installPrefix = "";
let bareBin = "";
let sandboxHome = "";
let sandboxWorktree = "";
let hermeticBin = "";

const cliSandboxEnv: NodeJS.ProcessEnv = {};

function isolatedChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const {
    HOME: _home,
    XDG_CONFIG_HOME: _xdgConfig,
    XDG_DATA_HOME: _xdgData,
    XDG_STATE_HOME: _xdgState,
    ENGRAM_DATA_DIR: _engram,
    ...rest
  } = process.env;
  void _home;
  void _xdgConfig;
  void _xdgData;
  void _xdgState;
  void _engram;
  const {
    HOME: _eHome,
    XDG_CONFIG_HOME: _eXdgConfig,
    XDG_DATA_HOME: _eXdgData,
    XDG_STATE_HOME: _eXdgState,
    ENGRAM_DATA_DIR: _eEngram,
    ...extraRest
  } = extra;
  void _eHome;
  void _eXdgConfig;
  void _eXdgData;
  void _eXdgState;
  void _eEngram;
  return { ...rest, ...extraRest, ...cliSandboxEnv };
}

async function runBare(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // R005: resolve the bare `aria` command through PATH with the isolated
  // prefix bin first — never the dev checkout. This proves the installed
  // command identity end users invoke, not a direct node-bin path bypass.
  // R003: hermetic fixture shims (fake opencode/engram/codegraph/zotpilot/
  // brew/git) sit second, so read-only probes never touch ambient tools or
  // the network while the prefix bin identity stays first.
  const prefixBin = join(installPrefix, "bin");
  const basePath = options.env?.["PATH"] ?? process.env["PATH"] ?? "";
  const barePath =
    hermeticBin.length > 0
      ? basePath.length > 0
        ? `${prefixBin}${delimiter}${hermeticBin}${delimiter}${basePath}`
        : `${prefixBin}${delimiter}${hermeticBin}`
      : basePath.length > 0
        ? `${prefixBin}${delimiter}${basePath}`
        : prefixBin;
  try {
    const result = await execFileAsync("aria", args, {
      cwd: options.cwd ?? sandboxWorktree,
      env: isolatedChildEnv({ ...options.env, PATH: barePath }),
      timeout: SLOW_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function resolveLiveAriaBin(): Promise<string | null> {
  // Resolve the ambient `aria` WITHOUT the candidate prefix or hermetic
  // fakes on PATH (read-only PATH lookup; never executes the live binary).
  try {
    const result = await execFileAsync("sh", ["-c", "command -v aria"], {
      cwd: sandboxWorktree,
      env: isolatedChildEnv(),
      timeout: CLI_TIMEOUT_MS,
    });
    const found = result.stdout.trim().split("\n").pop()?.trim() ?? "";
    return found.length > 0 ? found : null;
  } catch {
    return null;
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

function expectSameTree(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
}

beforeAll(async () => {
  const root = await mkdtemp(resolve(tmpdir(), "aria-t006-"));
  t006Roots.push(root);
  assertNotCallerGlobalPath(root, "T006 root");

  const packDir = join(root, "pack");
  installPrefix = join(root, "prefix");
  sandboxHome = join(root, "home");
  sandboxWorktree = join(root, "worktree");
  for (const dir of [packDir, installPrefix, sandboxHome, sandboxWorktree]) {
    await mkdir(dir, { recursive: true });
    assertNotCallerGlobalPath(dir, "T006 install dir");
  }

  // Sandbox env for every bare-aria child: never the caller HOME/XDG.
  const sandboxDirs = {
    HOME: join(sandboxHome, "home"),
    XDG_CONFIG_HOME: join(sandboxHome, "config"),
    XDG_DATA_HOME: join(sandboxHome, "data"),
    XDG_STATE_HOME: join(sandboxHome, "state"),
    ENGRAM_DATA_DIR: join(sandboxHome, "engram-data"),
  };
  for (const dir of Object.values(sandboxDirs)) {
    mkdirSync(dir, { recursive: true });
    assertNotCallerGlobalPath(dir, "T006 sandbox");
  }
  Object.assign(cliSandboxEnv, sandboxDirs);

  // Pack the candidate WITHOUT polluting the repo root (gitignored *.tgz).
  const packResult = await execFileAsync("npm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: repoRoot,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packed = JSON.parse(packResult.stdout) as
    | Array<{ filename: string }>
    | Record<string, { filename: string }>;
  const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  if (!entry?.filename) throw new Error("T006: npm pack returned no tarball");
  const tarball = join(packDir, entry.filename);

  // Isolated global-style install: --prefix only, never the live prefix,
  // never `npm link`. --ignore-scripts avoids lifecycle side effects.
  await execFileAsync(
    "npm",
    ["install", "-g", "--prefix", installPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );

  bareBin = join(installPrefix, "bin", "aria");
  const bareText = await readFile(bareBin, "utf8").catch(() => "");
  if (!bareText.includes("aria")) throw new Error(`T006: isolated bin missing at ${bareBin}`);
  assertNotCallerGlobalPath(bareBin, "T006 bare bin");

  // R003 hermetic probes: mask ambient doctor/upgrade/deps probes (brew,
  // opencode, network ls-remote, workstation tools) with deterministic
  // fixture shims. The tarball pack/install above stays the real packaging
  // check; only the read-only probe argv below is hermetic. Every bare-aria
  // child inherits this PATH (prefix bin first, then hermetic fakes, then
  // ambient PATH), so no live-state dependence or latency remains.
  hermeticBin = join(root, "fake-bin");
  await mkdir(hermeticBin, { recursive: true });
  assertNotCallerGlobalPath(hermeticBin, "T006 hermetic bin");
  // Packaged defaults fixture: the tarball packs the repo defaults verbatim,
  // so the repo tree is the deterministic source (the --prefix install layout
  // differs from a plain node_modules install; the real packaging check stays
  // the npm pack + isolated --prefix install above).
  const installedDefaults = JSON.parse(
    await readFile(join(repoRoot, "defaults", "aria.defaults.json"), "utf8"),
  ) as { roles?: Record<string, { model: string; variant?: string }> };
  const modelIds: string[] = [];
  const variantsByModel = new Map<string, string[]>();
  for (const role of Object.values(installedDefaults.roles ?? {})) {
    if (!modelIds.includes(role.model)) modelIds.push(role.model);
    if (role.variant) {
      const seen = variantsByModel.get(role.model) ?? [];
      if (!seen.includes(role.variant)) variantsByModel.set(role.model, [...seen, role.variant]);
    }
  }
  await writeFile(join(hermeticBin, "models.txt"), `${modelIds.join("\n")}\n`);
  const verboseLines: string[] = [];
  for (const id of modelIds) {
    verboseLines.push(
      id,
      JSON.stringify({
        name: id.slice(id.indexOf("/") + 1),
        variants: Object.fromEntries((variantsByModel.get(id) ?? []).map((variant) => [variant, {}])),
      }),
    );
  }
  await writeFile(join(hermeticBin, "models-verbose.txt"), `${verboseLines.join("\n")}\n`);
  await writeFile(
    join(hermeticBin, "mcp-list.txt"),
    ["engram connected", "context7 connected", "codegraph connected", "zotpilot disconnected", ""].join("\n"),
  );
  await writeFile(join(hermeticBin, "debug-config.txt"), '{"subagent_depth": 4}\n');
  await writeFile(
    join(hermeticBin, "plugin-list.txt"),
    ["ID  VERSION  SOURCE", `aria  abc1234  github:mscipio/ARIA#v${candidateVersion}`, ""].join("\n"),
  );
  const fakeScript = (
    name: string,
    approved: Array<{ match: string; out?: string; file?: string }>,
  ): string => {
    const body = approved
      .map(({ match, out, file }) => {
        const emit = file ? `/bin/cat "${join(hermeticBin, file)}"` : `echo "${out ?? ""}"`;
        return `if ${match}; then\n  ${emit}\n  exit 0\nfi`;
      })
      .join("\n");
    return `#!/bin/sh\necho "${name} $*" >> "${join(hermeticBin, "invocations.log")}"\n${body}\necho "refused: ${name} $*" >&2\nexit 2\n`;
  };
  await writeFile(
    join(hermeticBin, "opencode"),
    fakeScript("opencode", [
      { match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "opencode 2.0.23" },
      { match: '[ "$#" -eq 1 ] && [ "$1" = "models" ]', file: "models.txt" },
      { match: '[ "$#" -eq 2 ] && [ "$1" = "models" ] && [ "$2" = "--verbose" ]', file: "models-verbose.txt" },
      { match: '[ "$#" -eq 2 ] && [ "$1" = "mcp" ] && [ "$2" = "list" ]', file: "mcp-list.txt" },
      { match: '[ "$#" -eq 2 ] && [ "$1" = "debug" ] && [ "$2" = "config" ]', file: "debug-config.txt" },
      { match: '[ "$#" -eq 2 ] && [ "$1" = "plugin" ] && [ "$2" = "list" ]', file: "plugin-list.txt" },
    ]),
  );
  await writeFile(
    join(hermeticBin, "engram"),
    fakeScript("engram", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "version" ]', out: "engram 1.0.0" }]),
  );
  await writeFile(
    join(hermeticBin, "codegraph"),
    fakeScript("codegraph", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "codegraph 1.0.0" }]),
  );
  await writeFile(
    join(hermeticBin, "zotpilot"),
    fakeScript("zotpilot", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "zotpilot 0.5.3" }]),
  );
  await writeFile(join(hermeticBin, "brew"), '#!/bin/sh\necho "masked: brew $*" >&2\nexit 1\n');
  // Deterministic git ls-remote for the ARIA remote only (upgrade --check
  // discovery); every other git argv delegates to the real binary so local
  // tag/commit probes stay faithful and only the exact-tag install uses the
  // network (that install runs via real npm, never this shim).
  await writeFile(
    join(hermeticBin, "git"),
    `#!/bin/sh\nif [ "$1" = "ls-remote" ] && [ "$2" = "https://github.com/mscipio/ARIA.git" ]; then\n  printf "abc1234000000000000000000000000000000000\\trefs/tags/v${candidateVersion}\\n"\n  printf "abc1234000000000000000000000000000000000\\trefs/tags/v${candidateVersion}^{}\\n"\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
  );
  for (const name of ["opencode", "engram", "codegraph", "zotpilot", "brew", "git"]) {
    await chmod(join(hermeticBin, name), 0o755);
  }
  // Isolated Context7 remote config so doctor observes the packaged default
  // shape without ambient HOME dependence.
  await mkdir(join(sandboxHome, "config", "opencode"), { recursive: true });
  await writeFile(
    join(sandboxHome, "config", "opencode", "opencode.json"),
    `${JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }, null, 2)}\n`,
  );
  // Plain output without ambient color; PATH shims stay in runBare only so
  // the ambient `aria` lookup below never observes the candidate prefix or
  // the hermetic fakes.
  Object.assign(cliSandboxEnv, { NO_COLOR: "1" });
}, INSTALL_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(t006Roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("T006 isolated install provenance (candidate prefix, never the live global)", () => {
  it("bare aria reports the candidate version from the isolated prefix", async () => {
    expect(bareBin.startsWith(resolve(tmpdir()) + "/")).toBe(true);
    const result = await runBare(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(candidateVersion);
  });

  it("bare help advertises exactly the seven v1.1.0 forms with legacy retired and handoff internal", async () => {
    const result = await runBare(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria setup");
    expect(result.stdout).toContain("aria doctor");
    expect(result.stdout).toContain("aria upgrade --check");
    expect(result.stdout).toContain("aria models");
    expect(result.stdout).toContain("aria models --config");
    expect(result.stdout).toContain("aria deps ");
    expect(result.stdout).toContain("aria deps --upgrade");
    expect(result.stdout).not.toContain("aria configure ");
    expect(result.stdout).not.toContain("aria routes ");
    expect(result.stdout).not.toContain("aria update ");
    expect(result.stdout).not.toContain("aria deps sync");
    expect(result.stdout).not.toContain("--handoff-json");
    expect(result.stdout).not.toContain("--migrate-from");
  });

  it("candidate prefix stays isolated from any live installation (never the live global)", async () => {
    // T003: no workstation/global-state dependence and no live mutation.
    // The candidate bin lives under the temp prefix; the ambient `aria`
    // resolves without the prefix on PATH. A missing live install is
    // vacuously isolated; a present one must resolve outside the prefix,
    // proving the `--prefix` install neither shadowed nor replaced it. No
    // live version or help surface is pinned: the live release may move at
    // any time, and executing it is never required.
    const liveBin = await resolveLiveAriaBin();
    if (liveBin === null) return;
    expect(resolve(liveBin)).not.toBe(bareBin);
    expect(resolve(liveBin).startsWith(`${installPrefix}/`)).toBe(false);
  });
});

describe("T006 seven fast forms via bare aria (no live mutation)", () => {
  it("models prints the resolved role/model/effort table; models --config skips cleanly off-TTY", async () => {
    const models = await runBare(["models"]);
    expect(models.code).toBe(0);
    expect(models.stdout).toContain("role  model  effort");
    expect(models.stdout).toContain("coder  opencode-go/muse-spark-1.3-contributor  xhigh");
    expect(models.stdout).toContain("reviewer  openai/gpt-6.1-sol  medium");

    // execFile provides no TTY: deterministic skipped path, never setup phases.
    const config = await runBare(["models", "--config"]);
    expect(config.code).toBe(0);
    expect(config.stdout).toContain("Model configuration: skipped.");
    expect(config.stdout).not.toContain("Registration:");
    expect(config.stdout).not.toContain("Sync:");
  });

  it("setup rejects before mutation; legacy forms retire with guidance", async () => {
    const bogus = await runBare(["setup", "--bogus"]);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("Unknown setup option");
    expect(bogus.stdout).not.toContain("Registration:");

    for (const [args, fragment] of [
      [["configure"], "aria models --config"],
      [["routes"], "aria models"],
      [["update"], "aria upgrade"],
      [["deps", "sync"], "aria deps"],
    ] as const) {
      const retired = await runBare([...args]);
      expect(retired.code).toBe(1);
      expect(retired.stderr).toContain("retired");
      expect(retired.stderr).toContain(fragment);
    }
  });

  it("confirmation gates reject before any probe or mutation", async () => {
    const depsYes = await runBare(["deps", "--yes"]);
    expect(depsYes.code).toBe(1);
    expect(depsYes.stderr).toContain("Option --yes requires --upgrade");
    expect(depsYes.stdout).not.toContain("ARIA dependency inventory");

    const upgradeBoth = await runBare(["upgrade", "--check", "--yes"]);
    expect(upgradeBoth.code).toBe(1);
    expect(upgradeBoth.stderr).toContain("cannot be combined");
    expect(upgradeBoth.stdout).not.toContain("ARIA upgrade check");

    const upgradeBogus = await runBare(["upgrade", "--bogus"]);
    expect(upgradeBogus.code).toBe(1);
    expect(upgradeBogus.stderr).toContain("Unknown upgrade option");
  });
});

describe("T006 read-only inventory via bare aria (packaged E2E, hermetic probes)", () => {
  it("doctor keeps the read-only exit-code contract with plain output", async () => {
    const result = await runBare(["doctor"]);
    // Hermetic: fixture probes (fake opencode/engram/codegraph/zotpilot/brew
    // plus isolated Context7 config) make the report deterministic — exit 0,
    // no FAIL, no ambient or network dependence.
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("[FAIL]");
    expect(result.stdout).toContain("[PASS]");
    expect(result.stdout.startsWith("ARIA doctor\n")).toBe(true);
    for (const area of ["package:", "config:", "routes/models:", "dependencies:", "zotpilot:", "skills:", "wiki:"]) {
      expect(result.stdout).toContain(area);
    }
    // Plain text only, no repair/install hints.
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(result.stderr).toBe("");
  }, SLOW_TIMEOUT_MS);

  it("upgrade --check is read-only exit 0; bare upgrade blocks without approval", async () => {
    const check = await runBare(["upgrade", "--check"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("ARIA upgrade check");
    expect(check.stdout).toContain("Current release:");
    expect(check.stdout).toContain("Available release:");
    // Hermetic discovery: fixture plugin list + fixture ls-remote agree on
    // the candidate release, so no network or ambient probe is consulted.
    expect(check.stdout).toContain(candidateVersion);
    expect(check.stdout).toContain(`v${candidateVersion}`);
    for (const token of ["Component", "Installed", "Available", "Status"]) {
      expect(check.stdout).toContain(token);
    }
    expect(check.stderr).toBe("");

    const blocked = await runBare(["upgrade"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toContain("ARIA upgrade check");
    expect(blocked.stdout).toContain("Upgrade: blocked (explicit approval required)");
  }, SLOW_TIMEOUT_MS);

  it("deps inventories read-only exit 0; deps --upgrade proposes read-only exit 1", async () => {
    const inventoried = await runBare(["deps"]);
    expect(inventoried.code).toBe(0);
    expect(inventoried.stdout).toContain("ARIA dependency inventory (read-only; no changes were made)");
    expect(inventoried.stderr).toBe("");

    const proposed = await runBare(["deps", "--upgrade"]);
    expect(proposed.code).toBe(1);
    expect(proposed.stdout).toContain("ARIA dependency upgrade proposal (read-only; no changes were made)");
    expect(proposed.stdout).toContain("`aria deps --upgrade --yes`");
    expect(proposed.stdout).toContain("No changes were made.");
    expect(proposed.stderr).toBe("");
  }, SLOW_TIMEOUT_MS);
});

describe("T006 packaged mutation boundaries (zero filesystem mutation on read-only forms)", () => {
  it("fast read-only forms leave the invocation worktree byte-identical", async () => {
    const sentinel = join(sandboxWorktree, "t006-probe.txt");
    await writeFile(sentinel, "probe", "utf8");
    const before = await snapshotTree(sandboxWorktree);

    // Fast read-only only (no tool probes, no network): each rejects or
    // reports before any registration, file write, or sync. Slow-form
    // read-only (doctor / upgrade --check / blocked upgrade / deps /
    // deps --upgrade proposal) is proven hermetically above ("no changes
    // were made", blocked/proposal language, exit codes) plus the t002/t004
    // fixture snapshots; repeating all five hermetic probes here adds no new
    // behavior class.
    await runBare(["--help"]);
    await runBare(["--version"]);
    await runBare(["models"]);
    await runBare(["models", "--config"]);
    await runBare(["setup", "--bogus"]);
    await runBare(["configure"]);
    await runBare(["routes"]);
    await runBare(["deps", "--yes"]);
    await runBare(["upgrade", "--check", "--yes"]);

    expectSameTree(before, await snapshotTree(sandboxWorktree));
  }, CLI_TIMEOUT_MS);
});
