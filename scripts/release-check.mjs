import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Canonical release gate (T001). Deterministic order:
//  1. version/package sanity
//  2. tsc typecheck
//  3. targeted ESLint
//  4. git diff --check
//  5. focused lifecycle/hotfix Vitest subset (never the full suite)
//  6. npm pack + isolated temp install + packaged aria smoke (including
//     private-snapshot dist freshness comparison; never repairs worktree dist)
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

stage("1/6 version/package sanity", () => {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    fail(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pkg.name !== "aria") fail(`package name must be "aria", got ${JSON.stringify(pkg.name)}`);
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
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
  console.log(`release-check: package aria@${pkg.version}`);
});

stage("2/6 tsc typecheck", () => {
  runNpm(["run", "typecheck"]);
});

stage("3/6 targeted ESLint", () => {
  // Targeted (not `eslint .`): shipped code plus the gate/pack scripts.
  // Full-workspace lint remains owned by `npm run lint` in CI.
  runNpm(["exec", "--", "eslint", "src", "scripts", "bin"]);
});

stage("4/6 git diff --check", () => {
  run("git", ["diff", "--check"]);
});

stage("5/6 focused lifecycle/hotfix Vitest subset", () => {
  runNpm(["test", "--", ...FOCUSED_TESTS]);
});

stage("6/6 npm pack + isolated install + packaged aria smoke", () => {
  runNpm(["run", "smoke:package"]);
});

console.log("release-check: PASS - all stages green");
