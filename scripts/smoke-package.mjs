import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { normalizePackEntry } from "../dist/pack.js";
import { createUniqueScratchDir } from "../dist/scratch.js";

const npmScript = process.env.npm_execpath;
const npm = npmScript ? process.execPath : "npm";
const npmPrefix = npmScript ? [npmScript] : [];
const runNpm = (args, options = {}) =>
  execFileSync(npm, [...npmPrefix, ...args], {
    ...(npmScript ? {} : { shell: true }),
    ...options,
  });

function fail(message) {
  console.error(`smoke-package: ${message}`);
  process.exit(1);
}

const packageRoot = process.cwd();
// All transient smoke state (index snapshot, tarball, install prefix, npm
// cache) lives in one owned scratch run directory, cleaned up below.
const runDir = await createUniqueScratchDir(packageRoot, "smoke-package", "run");
const sourceDir = join(runDir, "source");
const installRoot = join(runDir, "install");
const npmCache = join(runDir, "npm-cache");
mkdirSync(sourceDir, { recursive: true });
mkdirSync(installRoot, { recursive: true });
mkdirSync(npmCache, { recursive: true });

// Per-child npm cache routing only. HOME/XDG and global config are preserved
// byte-identical (never overridden, even for children).
const childEnv = () => ({ ...process.env, NPM_CONFIG_CACHE: npmCache });

try {
  // Qualify the exact staged package snapshot: materialize the git index so
  // unrelated dirty worktree files are excluded without touching them. After
  // the authorized staging this snapshot includes the RC candidate; on a
  // clean CI index it matches HEAD.
  try {
    execFileSync("git", ["checkout-index", "--all", `--prefix=${sourceDir}/`], {
      cwd: packageRoot,
      stdio: "pipe",
    });
  } catch (error) {
    fail(`git checkout-index snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const packed = JSON.parse(
    runNpm(["pack", "--json", "--pack-destination", runDir], {
      cwd: sourceDir,
      encoding: "utf8",
      env: childEnv(),
    }),
  );
  const entry = normalizePackEntry(packed);
  if (!entry?.filename) fail("npm pack did not return a tarball");

  const packagedVersion =
    entry.version ?? JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")).version;

  const packedPaths = new Set((entry.files ?? []).map((file) => file.path.replaceAll("\\", "/")));

  // Lean completeness: entry points plus one representative from each shipped
  // area (no exact prompt/skill inventory; covered elsewhere).
  const requiredPaths = [
    "package.json",
    "bin/aria.mjs",
    "dist/index.js",
    "dist/index.d.ts",
    "README.md",
    "LICENSE",
  ];
  for (const path of requiredPaths) {
    if (!packedPaths.has(path)) fail(`packed tarball is missing ${path}`);
  }
  const requiredPrefixes = ["bin/", "dist/", "defaults/", "skills/", "wiki-pipeline/"];
  for (const prefix of requiredPrefixes) {
    if (![...packedPaths].some((path) => path.startsWith(prefix))) {
      fail(`packed tarball has no files under ${prefix}`);
    }
  }

  const forbiddenPrefixes = ["src/", "tests/", "scripts/", ".github/"];
  for (const path of packedPaths) {
    if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
      fail(`packed tarball unexpectedly includes ${path}`);
    }
    if (path.endsWith(".map") || path === "INSTALL.md") {
      fail(`packed tarball unexpectedly includes ${path}`);
    }
  }

  const tarball = join(runDir, entry.filename);
  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore", env: childEnv() });
  runNpm(["install", "--ignore-scripts", "--no-save", tarball], {
    cwd: installRoot,
    stdio: "inherit",
    env: childEnv(),
  });

  const installedDir = join(installRoot, "node_modules", "aria");
  const installedPkg = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"));
  if (installedPkg.version !== packagedVersion) {
    fail(`installed version ${installedPkg.version} does not match packaged version ${packagedVersion}`);
  }

  // Entry points resolve from the installed package.
  for (const rel of ["bin/aria.mjs", "dist/index.js", "dist/index.d.ts"]) {
    if (!existsSync(join(installedDir, rel))) fail(`installed package is missing ${rel}`);
  }

  // Exercise the installed package's plugin startup and cleanup contract.
  const probePath = join(installRoot, "plugin-probe.mjs");
  writeFileSync(
    probePath,
    `const pluginModule = await import("aria");
const plugin = pluginModule.default;

if (plugin?.id !== "aria") {
  console.error("smoke-package: expected plugin id aria, got", plugin?.id);
  process.exit(1);
}
if (typeof plugin?.setup !== "function") {
  console.error("smoke-package: plugin.setup is not a function");
  process.exit(1);
}
if ("server" in plugin) {
  console.error("smoke-package: V1 server shim must not be present");
  process.exit(1);
}
const cleanup = await plugin.setup({});
if (cleanup !== undefined && typeof cleanup !== "function") {
  console.error("smoke-package: plugin.setup must resolve a cleanup function or void");
  process.exit(1);
}
if (typeof cleanup === "function") await cleanup();
`,
  );
  execFileSync(process.execPath, [probePath], {
    cwd: installRoot,
    stdio: "inherit",
    env: childEnv(),
  });

  const ariaBin = join(installRoot, "node_modules", ".bin", "aria");

  const versionOutput = execFileSync(process.execPath, [ariaBin, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
    env: childEnv(),
  }).trim();
  if (versionOutput !== packagedVersion) {
    fail(`aria --version ${JSON.stringify(versionOutput)} does not match packaged version ${packagedVersion}`);
  }

  const helpOutput = execFileSync(process.execPath, [ariaBin, "--help"], {
    cwd: installRoot,
    encoding: "utf8",
    env: childEnv(),
  });
  for (const command of ["models", "upgrade"]) {
    if (!helpOutput.includes(command)) fail(`aria --help does not mention ${command}`);
  }

  const modelsOutput = execFileSync(process.execPath, [ariaBin, "models"], {
    cwd: installRoot,
    encoding: "utf8",
    env: childEnv(),
  });
  if (!modelsOutput.includes("role  model  effort")) {
    fail("aria models did not produce expected header");
  }
  if (!modelsOutput.includes("coder")) {
    fail("aria models did not include a role row");
  }

  console.log(`smoke-package: ok (version ${packagedVersion})`);
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
