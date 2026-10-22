import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";

// Short post-tag verifier (T004). Verifies provenance and essential packaged
// startup for an immutable release tag WITHOUT rerunning behavioral
// qualification or the full suite (that qualification is owned by
// `npm run release:check`, which must pass BEFORE tagging):
//
//  1. tag→commit identity (local `git rev-parse`; optional remote match and
//     `--expect-sha` pin)
//  2. install of the exact tag spec into an isolated temp prefix
//     (the ONLY network step, besides the optional exact-tag ls-remote)
//  3. bare `aria --version` equals the tagged package.json version
//  4. resolved package path is inside the temp prefix (not checkout-backed)
//  5. short smokes only: hermetic `aria doctor`, read-only
//     `aria upgrade --check`, and `aria models` dispatch
//
// Isolation: every smoke runs with HOME/USERPROFILE plus XDG_* pointed at
// temp dirs (plus a temp npm cache), WIKI_DIR unset, and a fake-bin
// shadowing `brew` (always refused: no package-manager mutation) and the
// external read-only probes (`opencode`, `engram`, `codegraph`, `zotpilot`)
// with an allowlist matching scripts/smoke-package.mjs. Nothing here writes
// live config, touches the global npm root, or mutates the checkout.
//
// Usage:
//   node scripts/verify-release-tag.mjs <tag> [--expect-sha <sha>]
//     [--spec <npm-spec>] [--skip-remote-check] [--keep]
//
// `<tag>` is the immutable release tag (e.g. v1.1.1). The install spec
// defaults to `github:mscipio/ARIA#<tag>`; `--spec` overrides it for
// isolated testing (e.g. a tarball packed from the tagged commit).
// `--skip-remote-check` skips the `git ls-remote origin` comparison for
// offline/disposable-tag testing. `--keep` preserves the sandbox on success.

const repoRoot = process.cwd();

function fail(message) {
  console.error(`verify-release-tag: FAIL - ${message}`);
  process.exit(1);
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

function stage(label, fn) {
  console.log(`verify-release-tag: [stage] ${label}`);
  fn();
  console.log(`verify-release-tag: ok - ${label}`);
}

const argv = process.argv.slice(2);
const tag = argv.find((arg) => !arg.startsWith("--"));
if (!tag) {
  fail("usage: node scripts/verify-release-tag.mjs <tag> [--expect-sha <sha>] [--spec <npm-spec>] [--skip-remote-check] [--keep]");
}
function flagValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
const expectSha = flagValue("--expect-sha");
const specOverride = flagValue("--spec");
const skipRemoteCheck = argv.includes("--skip-remote-check");
const keepSandbox = argv.includes("--keep");
const installSpec = specOverride ?? `github:mscipio/ARIA#${tag}`;

if (expectSha !== undefined && !/^[0-9a-f]{4,40}$/i.test(expectSha)) {
  fail(`--expect-sha must be a hex commit SHA, got ${JSON.stringify(expectSha)}`);
}

let tagSha = "";
let expectedVersion = "";

// Isolated sandbox: every path below stays under one temp root. Created
// before any stage so failure cleanup (including unknown-tag failures) is
// uniform; only the exact-tag install stage below may use the network.
const sandboxRoot = mkdtempSync(join(tmpdir(), "aria-verify-"));
const installRoot = join(sandboxRoot, "install");
const homeDir = join(sandboxRoot, "home");
const xdgConfig = join(sandboxRoot, "xdg-config");
const xdgData = join(sandboxRoot, "xdg-data");
const xdgCache = join(sandboxRoot, "xdg-cache");
const xdgState = join(sandboxRoot, "xdg-state");
const npmCache = join(sandboxRoot, "npm-cache");
const fakeBin = join(sandboxRoot, "fake-bin");
for (const dir of [installRoot, homeDir, xdgConfig, xdgData, xdgCache, xdgState, npmCache, fakeBin]) {
  mkdirSync(dir, { recursive: true });
}
if (!resolve(sandboxRoot).startsWith(resolve(tmpdir()))) {
  fail(`sandbox escaped temp: ${sandboxRoot}`);
}

process.on("exit", (code) => {
  if (code !== 0 && !keepSandbox) rmSync(sandboxRoot, { recursive: true, force: true });
});

stage("1/6 tag→commit identity", () => {
  try {
    tagSha = capture("git", ["rev-parse", "--verify", `${tag}^{commit}`]).trim();
  } catch {
    fail(`tag ${JSON.stringify(tag)} does not resolve to a commit`);
  }
  const listed = capture("git", ["rev-list", "-n", "1", tag]).trim();
  if (listed !== tagSha) {
    fail(`tag→commit mismatch: rev-parse ${tagSha} vs rev-list ${listed}`);
  }
  if (expectSha !== undefined && tagSha.toLowerCase() !== expectSha.toLowerCase()) {
    fail(`tag ${tag} resolves to ${tagSha}, expected ${expectSha}`);
  }
  let pkgRaw;
  try {
    pkgRaw = capture("git", ["show", `${tag}:package.json`]);
  } catch {
    fail(`cannot read package.json at tag ${JSON.stringify(tag)}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    fail(`package.json at tag ${JSON.stringify(tag)} is not valid JSON`);
  }
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`tagged package version must be semver x.y.z, got ${JSON.stringify(pkg.version)}`);
  }
  expectedVersion = pkg.version;
  const subject = capture("git", ["log", "-1", "--format=%s", tag]).trim();
  console.log(`verify-release-tag: tag ${tag} -> commit ${tagSha} (${subject}), package ${expectedVersion}`);
});

if (!skipRemoteCheck) {
  stage("2/6 remote tag identity (exact-tag ls-remote only)", () => {
    let output;
    try {
      // Query both the tag ref and its peeled commit: for annotated tags
      // the direct ref is the tag-object SHA while `^{}` is the commit;
      // lightweight tags have no `^{}` line (the direct ref is the commit).
      output = capture("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    } catch (error) {
      fail(`git ls-remote origin failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const remoteRefs = new Map();
    for (const entry of output.split("\n")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [sha, ref] = trimmed.split(/\s+/);
      if (sha && ref) remoteRefs.set(ref, sha);
    }
    // Annotated tags peel to the commit via `^{}`; lightweight tags fall
    // back to the direct ref (which already is the commit).
    const remoteCommit = remoteRefs.get(`refs/tags/${tag}^{}`) ?? remoteRefs.get(`refs/tags/${tag}`) ?? "";
    if (!remoteCommit) fail(`origin has no refs/tags/${tag}`);
    if (remoteCommit.toLowerCase() !== tagSha.toLowerCase()) {
      fail(`remote tag drift: origin refs/tags/${tag} peels to ${remoteCommit}, local is ${tagSha}`);
    }
    console.log(`verify-release-tag: origin refs/tags/${tag} peels to ${tagSha}`);
  });
} else {
  console.log("verify-release-tag: [stage] 2/6 remote tag identity SKIPPED (--skip-remote-check)");
}

const smokeEnv = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  XDG_CACHE_HOME: xdgCache,
  XDG_STATE_HOME: xdgState,
  NO_COLOR: "1",
  PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
};
delete smokeEnv.WIKI_DIR;

let installedDir = "";
const npmScript = process.env.npm_execpath;
const npm = npmScript ? process.execPath : "npm";
const npmPrefix = npmScript ? [npmScript] : [];
function runNpm(args, options = {}) {
  execFileSync(npm, [...npmPrefix, ...args], {
    ...(npmScript ? {} : { shell: true }),
    ...options,
  });
}

function cleanup() {
  if (keepSandbox) {
    console.log(`verify-release-tag: sandbox kept at ${sandboxRoot}`);
    return;
  }
  rmSync(sandboxRoot, { recursive: true, force: true });
}

try {
  stage("3/6 isolated install of the exact tag spec", () => {
    console.log(`verify-release-tag: sandbox ${sandboxRoot}`);
    console.log(`verify-release-tag: HOME=${homeDir} XDG_CONFIG_HOME=${xdgConfig} XDG_DATA_HOME=${xdgData}`);
    // Process-local Git allowance for the one exact-spec fetch only (mirrors
    // PROCESS_LOCAL_GIT_ENV); never persisted to config or .npmrc.
    runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
    runNpm(["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", installSpec], {
      cwd: installRoot,
      stdio: "inherit",
      env: { ...process.env, npm_config_cache: npmCache, NPM_CONFIG_ALLOW_GIT: "all" },
    });
    installedDir = realpathSync(join(installRoot, "node_modules", "aria"));
  });

  stage("4/6 bare version + non-checkout package path", () => {
    const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
    if (!existsSync(ariaBin)) fail(`installed aria binary is missing at ${ariaBin}`);
    const reported = capture(process.execPath, [ariaBin, "--version"], { cwd: installRoot, env: smokeEnv }).trim();
    if (reported !== expectedVersion) {
      fail(`bare aria --version mismatch: got ${JSON.stringify(reported)}, tag package is ${JSON.stringify(expectedVersion)}`);
    }
    console.log(`verify-release-tag: bare aria --version ${reported}`);
    const resolvedRoot = resolve(repoRoot);
    const resolvedInstall = resolve(installedDir);
    if (!resolve(resolvedInstall).startsWith(resolve(installRoot))) {
      fail(`installed package escaped the sandbox: ${resolvedInstall}`);
    }
    if (resolvedInstall === resolvedRoot || resolvedInstall.startsWith(`${resolvedRoot}/`)) {
      fail(`installed package is checkout-backed: ${resolvedInstall}`);
    }
    const installedPkg = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"));
    if (installedPkg.version !== expectedVersion) {
      fail(`installed package.json version ${JSON.stringify(installedPkg.version)} != tag version ${JSON.stringify(expectedVersion)}`);
    }
    console.log(`verify-release-tag: installed package ${resolvedInstall} (not checkout-backed)`);
  });

  stage("5/6 hermetic doctor smoke (short; no full suite)", () => {
    // Read-only probe shims: each fake accepts only the exact argv the
    // smoke needs and rejects everything else (notably any mutating
    // `opencode plugin add`, installs, or syncs). Brew is masked entirely.
    const invocationLog = join(fakeBin, "invocations.log");
    const installedDefaults = JSON.parse(
      readFileSync(join(installedDir, "defaults", "aria.defaults.json"), "utf8"),
    );
    const modelIds = [];
    const variantsByModel = new Map();
    for (const role of Object.values(installedDefaults.roles ?? {})) {
      const entry = role;
      if (!modelIds.includes(entry.model)) modelIds.push(entry.model);
      if (entry.variant) {
        const seen = variantsByModel.get(entry.model) ?? [];
        if (!seen.includes(entry.variant)) variantsByModel.set(entry.model, [...seen, entry.variant]);
      }
    }
    writeFileSync(join(fakeBin, "models.txt"), `${modelIds.join("\n")}\n`);
    const verboseLines = [];
    for (const id of modelIds) {
      verboseLines.push(
        id,
        JSON.stringify({
          name: id.slice(id.indexOf("/") + 1),
          variants: Object.fromEntries((variantsByModel.get(id) ?? []).map((variant) => [variant, {}])),
        }),
      );
    }
    writeFileSync(join(fakeBin, "models-verbose.txt"), `${verboseLines.join("\n")}\n`);
    writeFileSync(
      join(fakeBin, "mcp-list.txt"),
      ["engram connected", "context7 connected", "codegraph connected", "zotpilot disconnected", ""].join("\n"),
    );
    writeFileSync(join(fakeBin, "debug-config.txt"), '{"subagent_depth": 4}\n');
    const fakeScript = (name, approved) => {
      const body = approved
        .map(({ match, out, file }) => {
          const emit = file ? `/bin/cat "${join(fakeBin, file)}"` : `echo "${out}"`;
          return `if ${match}; then\n  ${emit}\n  exit 0\nfi`;
        })
        .join("\n");
      return `#!/bin/sh\necho "${name} $*" >> "${invocationLog}"\n${body}\necho "refused: ${name} $*" >&2\nexit 2\n`;
    };
    writeFileSync(
      join(fakeBin, "opencode"),
      fakeScript("opencode", [
        { match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "opencode 2.0.23" },
        { match: '[ "$#" -eq 1 ] && [ "$1" = "models" ]', file: "models.txt" },
        { match: '[ "$#" -eq 2 ] && [ "$1" = "models" ] && [ "$2" = "--verbose" ]', file: "models-verbose.txt" },
        { match: '[ "$#" -eq 2 ] && [ "$1" = "mcp" ] && [ "$2" = "list" ]', file: "mcp-list.txt" },
        { match: '[ "$#" -eq 2 ] && [ "$1" = "debug" ] && [ "$2" = "config" ]', file: "debug-config.txt" },
      ]),
    );
    writeFileSync(
      join(fakeBin, "engram"),
      fakeScript("engram", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "version" ]', out: "engram 1.0.0" }]),
    );
    writeFileSync(
      join(fakeBin, "codegraph"),
      fakeScript("codegraph", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "codegraph 1.0.0" }]),
    );
    writeFileSync(
      join(fakeBin, "zotpilot"),
      fakeScript("zotpilot", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "zotpilot 0.5.3" }]),
    );
    writeFileSync(join(fakeBin, "brew"), '#!/bin/sh\necho "masked: brew $*" >&2\nexit 1\n');
    // R004 hermetic upgrade --check discovery: deterministic ls-remote
    // fixture for the ARIA remote only, so the short smoke never consults
    // the network for available-release discovery. Every other git argv
    // delegates to the real binary; only the exact-tag install (stage 3,
    // via real npm/git, never this shim) may use the network.
    writeFileSync(
      join(fakeBin, "git"),
      `#!/bin/sh\nif [ "$1" = "ls-remote" ] && [ "$2" = "https://github.com/mscipio/ARIA.git" ]; then\n  printf "%s\\trefs/tags/${tag}\\n" "${tagSha}"\n  printf "%s\\trefs/tags/${tag}^{}\\n" "${tagSha}"\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
    );
    for (const name of ["opencode", "engram", "codegraph", "zotpilot", "brew", "git"]) {
      chmodSync(join(fakeBin, name), 0o755);
    }
    // Global config under the isolated XDG_CONFIG_HOME (openCodeGlobalDir
    // resolves `$XDG_CONFIG_HOME/opencode` when set), matching the
    // documented V2 global `mcp.servers.<name>` remote MCP shape.
    mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
    writeFileSync(
      join(xdgConfig, "opencode", "opencode.json"),
      `${JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }, null, 2)}\n`,
    );

    const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
    let doctorOutput;
    try {
      doctorOutput = capture(process.execPath, [ariaBin, "doctor"], { cwd: installRoot, env: smokeEnv });
    } catch (error) {
      fail(`installed aria doctor exited nonzero:\n${error.stdout || error.stderr || error}`);
    }
    if (!doctorOutput.includes("ARIA doctor")) fail("doctor output missing report header");
    if (doctorOutput.includes("[FAIL]")) fail("doctor output unexpectedly contains FAIL");
    if (!doctorOutput.includes("[PASS]")) fail("doctor output has no PASS finding");
    // eslint-disable-next-line no-control-regex
    if (/\x1b\[/.test(doctorOutput)) fail("doctor output contains ANSI escapes");
    console.log("verify-release-tag: doctor ok (exit 0, no FAIL, plain output)");
  });

  stage("6/6 upgrade --check + dispatch smoke (short; read-only)", () => {
    // Hermetic discovery (R004): `git ls-remote` for the ARIA remote is
    // served by the fake-bin fixture above (exact tag only), so this smoke
    // uses no network beyond the stage-3 exact-tag install.
    const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
    let checkOutput;
    try {
      checkOutput = capture(process.execPath, [ariaBin, "upgrade", "--check"], { cwd: installRoot, env: smokeEnv });
    } catch (error) {
      fail(`installed aria upgrade --check exited nonzero:\n${error.stdout || error.stderr || error}`);
    }
    if (!checkOutput.includes("ARIA upgrade check")) fail("upgrade --check output missing report header");
    if (!checkOutput.includes("Component")) fail("upgrade --check output missing component table");
    console.log("verify-release-tag: upgrade --check ok (exit 0, read-only)");
    const modelsOutput = capture(process.execPath, [ariaBin, "models"], { cwd: installRoot, env: smokeEnv });
    if (!modelsOutput.includes("role  model  effort")) fail("aria models did not produce the routes table header");
    if (!modelsOutput.includes("coder")) fail("aria models did not include the coder role");
    console.log("verify-release-tag: models dispatch ok");
  });
} catch (error) {
  if (!keepSandbox) rmSync(sandboxRoot, { recursive: true, force: true });
  throw error;
}

cleanup();
console.log(`verify-release-tag: PASS - tag ${tag} (${tagSha}) verified from ${installSpec}`);
