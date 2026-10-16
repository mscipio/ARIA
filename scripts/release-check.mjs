import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Canonical release gate (T001). Deterministic order:
//  1. version/package sanity
//  2. compile and verify dist sync (fails on stale tracked dist)
//  3. tsc typecheck
//  4. targeted ESLint
//  5. git diff --check
//  6. focused lifecycle/hotfix Vitest subset (never the full suite)
//  7. npm pack + isolated temp install + bare packaged aria smoke
//     (short bare --version/--help proof on the packed tarball, following
//     the npm pack/temp-prefix pattern of scripts/smoke-package.mjs; the
//     full hermetic doctor smoke remains owned by `npm run smoke:package`
//     and CI).
// Any stage failure exits nonzero immediately.

const repoRoot = process.cwd();

const npmScript = process.env.npm_execpath;
const npm = npmScript ? process.execPath : "npm";
const npmPrefix = npmScript ? [npmScript] : [];
function runNpm(args, options = { stdio: "inherit" }) {
  execFileSync(npm, [...npmPrefix, ...args], {
    ...(npmScript ? {} : { shell: true }),
    ...options,
  });
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

function stage(label, fn) {
  console.log(`release-check: [stage] ${label}`);
  fn();
  console.log(`release-check: ok - ${label}`);
}

// Focused lifecycle/hotfix subset: representative release qualification
// without the full suite. Covers lifecycle separation (t002), deps upgrade
// (t004), packaged paths (t005), gating (t010), identity classification
// (t012), duplicate-dist parity incl. src/dist parity (t013), stale CLI
// upgrade (r006), upgrade pipeline (aria-upgrade/upgrade), managed-agent
// regen, doctor identity, setup same-release, and Engram brew preflight.
// Deliberately excludes the slow t006 global-install gate (pack/install is
// proven by the smoke stage below) and the full suite.
const FOCUSED_TESTS = [
  "tests/t002-lifecycle-separation.test.ts",
  "tests/t004-deps-upgrade.test.ts",
  "tests/t005-package-paths.test.ts",
  "tests/t010-gating.test.ts",
  "tests/t012-identity-classification.test.ts",
  "tests/t013-duplicate-dist-parity.test.ts",
  "tests/r006-stale-cli-upgrade.test.ts",
  "tests/aria-upgrade.test.ts",
  "tests/upgrade.test.ts",
  "tests/managed-agent-regen.test.ts",
  "tests/doctor-identity.test.ts",
  "tests/setup-same-release.test.ts",
  "tests/engram-brew-preflight.test.ts",
];

function fail(message) {
  console.error(`release-check: FAIL - ${message}`);
  process.exit(1);
}

let packageVersion = "";

stage("1/7 version/package sanity", () => {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    fail(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pkg.name !== "aria") fail(`package name must be "aria", got ${JSON.stringify(pkg.name)}`);
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    fail(`package version must be semver x.y.z, got ${JSON.stringify(pkg.version)}`);
  }
  if (pkg.private !== false) fail(`package must set "private": false for publishing`);
  if (pkg.bin?.aria !== "./bin/aria.mjs") {
    fail(`bin.aria must be "./bin/aria.mjs", got ${JSON.stringify(pkg.bin?.aria)}`);
  }
  if (!existsSync(join(repoRoot, "bin", "aria.mjs"))) fail("bin/aria.mjs is missing");
  for (const required of ["bin/*.mjs", "dist/*.js"]) {
    if (!Array.isArray(pkg.files) || !pkg.files.includes(required)) {
      fail(`package.json "files" must include ${required}`);
    }
  }
  if (typeof pkg.engines?.node !== "string" || pkg.engines.node.length === 0) {
    fail(`package.json "engines.node" must be declared`);
  }
  packageVersion = pkg.version;
  console.log(`release-check: package aria@${pkg.version}`);
});

stage("2/7 compile and verify dist sync", () => {
  // Snapshot pre-build tracked dist state BEFORE compile deletes/rebuilds
  // it: a hand-edited (stale) dist that rebuilds to HEAD would otherwise
  // silently repair and pass the post-build check. Any pre-build dirtiness
  // must FAIL (never silently repair and pass).
  const before = capture("git", ["status", "--porcelain", "--", "dist/"]).trim();
  runNpm(["run", "compile"]);
  // The compile above rebuilds dist/ from src/. If the tracked dist/ was
  // stale, the rebuild changes tracked files — which must FAIL the gate
  // (never silently repair and pass). t013 dist-parity coverage in the
  // focused subset is the second stale-dist detector.
  const after = capture("git", ["status", "--porcelain", "--", "dist/"]).trim();
  if (before.length > 0) {
    fail(`tracked dist/ was stale before compile (repaired by rebuild, not passed):\n${before}`);
  }
  if (after.length > 0) {
    fail(`tracked dist/ is stale (compile changed tracked files):\n${after}`);
  }
});

stage("3/7 tsc typecheck", () => {
  runNpm(["run", "typecheck"]);
});

stage("4/7 targeted ESLint", () => {
  // Targeted (not `eslint .`): shipped code plus the gate/pack scripts.
  // Full-workspace lint remains owned by `npm run lint` in CI.
  runNpm(["exec", "--", "eslint", "src", "scripts", "bin"]);
});

stage("5/7 git diff --check", () => {
  run("git", ["diff", "--check"]);
});

stage("6/7 focused lifecycle/hotfix Vitest subset", () => {
  runNpm(["test", "--", ...FOCUSED_TESTS]);
});

stage("7/7 npm pack + isolated install + bare packaged aria smoke", () => {
  const packed = JSON.parse(capture(npm, [...npmPrefix, "pack", "--json"], { cwd: repoRoot }));
  const entries = Array.isArray(packed) ? packed : Object.values(packed);
  const tarballName = entries[0]?.filename;
  if (!tarballName) fail("npm pack did not return a tarball");
  const tarball = join(repoRoot, tarballName);
  const installRoot = mkdtempSync(join(tmpdir(), "aria-release-"));
  if (!resolve(installRoot).startsWith(resolve(tmpdir()))) fail(`install prefix escaped temp: ${installRoot}`);
  const smokeEnv = { ...process.env, HOME: installRoot, USERPROFILE: installRoot };
  try {
    runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
    runNpm(["install", "--ignore-scripts", "--no-save", tarball], { cwd: installRoot, stdio: "inherit" });
    const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
    const reported = capture(process.execPath, [ariaBin, "--version"], {
      cwd: installRoot,
      env: smokeEnv,
    }).trim();
    if (reported !== packageVersion) {
      fail(`bare aria --version mismatch: got ${JSON.stringify(reported)}, expected ${JSON.stringify(packageVersion)}`);
    }
    const help = capture(process.execPath, [ariaBin, "--help"], { cwd: installRoot, env: smokeEnv });
    if (!help.includes("aria setup") || !help.includes("aria doctor") || !help.includes("aria upgrade")) {
      fail("bare aria --help is missing the setup/doctor/upgrade surface");
    }
    console.log(`release-check: bare packaged aria --version ${reported}`);
  } finally {
    rmSync(tarball, { force: true });
    rmSync(installRoot, { recursive: true, force: true });
  }
});

console.log("release-check: PASS - all stages green");
