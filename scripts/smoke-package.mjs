import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

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
  // Materialize the staged index directly into a fresh private snapshot.
  // checkout-index reads the index but does not update it or the worktree.
  try {
    execFileSync("git", ["checkout-index", "--all", `--prefix=${sourceDir}/`], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    // Keep compiler/dependency resolution available without copying or altering
    // the worktree's installed dependencies.
    symlinkSync(join(packageRoot, "node_modules"), join(sourceDir, "node_modules"), "dir");
  } catch (error) {
    fail(`staged-index snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const readDist = (root) => {
    const files = new Map();
    const visit = (dir, relative = "") => {
      for (const name of readdirSync(dir)) {
        const rel = relative ? `${relative}/${name}` : name;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) visit(path, rel);
        else if (/\.(?:js|d\.ts)$/.test(rel)) files.set(rel, readFileSync(path));
      }
    };
    visit(join(root, "dist"));
    return files;
  };
  const candidateDist = readDist(sourceDir);

  // Compile only the private snapshot. Comparing against its original dist
  // rejects stale candidate output instead of silently repairing it.
  runNpm(["run", "compile"], { cwd: sourceDir, stdio: "inherit", env: childEnv() });
  const compiledDist = readDist(sourceDir);
  const distPaths = [...new Set([...candidateDist.keys(), ...compiledDist.keys()])].sort();
  for (const path of distPaths) {
    if (!candidateDist.has(path) || !compiledDist.has(path) || !candidateDist.get(path).equals(compiledDist.get(path))) {
      fail(`staged dist mismatch after compiling staged-index snapshot: dist/${path}`);
    }
  }

  const packed = JSON.parse(
    runNpm(["pack", "--json", "--pack-destination", runDir], {
      cwd: sourceDir,
      encoding: "utf8",
      env: childEnv(),
    }),
  );
  const entry = Array.isArray(packed) ? packed[0] : packed?.aria ?? packed;
  if (!entry?.filename) fail(`npm pack did not return a tarball (${JSON.stringify(packed)})`);

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
    "dist/plan-tool.js",
    "dist/scratch.js",
    "defaults/prompts/coder.md",
    "wiki-pipeline/docs/compile-workflow.md",
    "wiki-pipeline/compiler.py",
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

  const installedFile = (rel) => readFileSync(join(installedDir, rel), "utf8");
  const planPrompt = installedFile("defaults/prompts/coder.md");
  for (const marker of [".aria/rdc/TASKS.md", "continue it instead of planning the same work again"]) {
    if (!planPrompt.includes(marker)) fail(`installed plan recovery prompt is missing ${JSON.stringify(marker)}`);
  }
  const scratchSource = installedFile("dist/scratch.js");
  for (const marker of ["SCRATCH_DIR_NAME", "createUniqueScratchDir", "Scratch directory"]) {
    if (!scratchSource.includes(marker)) fail(`installed scratch helper is missing ${JSON.stringify(marker)}`);
  }

  // Entry points resolve from the installed package.
  for (const rel of ["bin/aria.mjs", "dist/index.js", "dist/index.d.ts"]) {
    if (!existsSync(join(installedDir, rel))) fail(`installed package is missing ${rel}`);
  }

  // Exercise the installed package export's real plugin setup/transform path
  // with a project aria.json. Missing canonical agents must be upserted with
  // the project's exact model+variant routes.
  const projectDir = join(runDir, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "aria.json"),
    JSON.stringify({
      roles: {
        coder: { model: "openai/gpt-6.1-sol", variant: "medium" },
        explorer: { model: "openai/gpt-6-luna", variant: "high" },
      },
    }),
  );
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
const agents = new Map();
const editor = {
  get: (id) => agents.get(id),
  update: (id, update) => {
    const agent = { ...(agents.get(id) ?? {}) };
    update(agent);
    agents.set(id, agent);
  },
};
const cleanup = await plugin.setup({
  location: { directory: ${JSON.stringify(projectDir)} },
  agent: { transform: async (transform) => transform(editor) },
});
if (cleanup !== undefined && typeof cleanup !== "function") {
  console.error("smoke-package: plugin.setup must resolve a cleanup function or void");
  process.exit(1);
}
if (typeof cleanup === "function") await cleanup();
for (const [role, model, variant] of [
  ["coder", "openai/gpt-6.1-sol", "medium"],
  ["explorer", "openai/gpt-6-luna", "high"],
]) {
  const actual = agents.get(role)?.model;
  if (actual?.providerID !== model.split("/")[0] || actual?.id !== model.split("/")[1] || actual?.variant !== variant) {
    console.error("smoke-package: expected project route for", role, "got", actual);
    process.exit(1);
  }
}
`,
  );
  execFileSync(process.execPath, [probePath], {
    cwd: installRoot,
    stdio: "inherit",
    env: childEnv(),
  });

  // Exercise managed-agent migration/preflight through the installed artifact.
  const migrationDir = join(runDir, "migration-agents");
  const migrationProbe = join(installRoot, "migration-probe.mjs");
  writeFileSync(migrationProbe, `
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcileManagedAgents } from ${JSON.stringify(join(installedDir, "dist/model-config.js"))};

const worktree = ${JSON.stringify(projectDir)};
const dir = ${JSON.stringify(migrationDir)};
await mkdir(dir, { recursive: true });
const coderPath = join(dir, "coder.md");
// This is an integrity-valid legacy managed file carrying a baked-in route.
const { generateAgentFiles, agentFileChecksum } = await import(${JSON.stringify(join(installedDir, "dist/agents.js"))});
const { resolveAriaConfig } = await import(${JSON.stringify(join(installedDir, "dist/overrides.js"))});
const generated = generateAgentFiles(resolveAriaConfig(worktree), "${packagedVersion}");
const description = generated.coder.match(/^description: (.*)$/m)?.[1];
const mode = generated.coder.match(/^mode: (.*)$/m)?.[1];
const generatedLines = generated.coder.split("\\n");
const closing = generatedLines.indexOf("---", 1);
const body = generatedLines.slice(closing + 2).join("\\n");
const permissions = [...generated.coder.matchAll(/^  - action: (.*)\\n    resource: (.*)\\n    effect: (.*)$/gm)].map((match) => ({
  action: JSON.parse(match[1]), resource: JSON.parse(match[2]), effect: match[3],
}));
assert(description && mode && body && permissions.length > 0, "generated fixture fields must parse");
const legacyModel = "openai/legacy-route";
const parseYamlString = (value) => value.startsWith(String.fromCharCode(34)) ? JSON.parse(value) : value;
const legacyChecksum = agentFileChecksum(parseYamlString(description), legacyModel, mode, permissions, body);
const legacyCoder = generated.coder
  .replace(/# aria-checksum: [0-9a-f]{64}/, "# aria-checksum: " + legacyChecksum)
  .replace(/(mode: .*)/, "model: " + JSON.stringify(legacyModel) + "\\n$1");
assert.match(legacyCoder, /^model: "?openai\\/legacy-route"?$/m, "pre-migration legacy input must carry a route");
await writeFile(coderPath, legacyCoder);
await reconcileManagedAgents(worktree, { dir });
const migrated = await readFile(coderPath, "utf8");
assert(!/^model:/m.test(migrated), "legacy route must be removed after integrity validation");
assert.match(migrated, /# aria-checksum: [0-9a-f]{64}/);
assert.deepEqual((await readdir(dir)).sort(), Object.keys(generated).map((role) => role + ".md").sort());
for (const role of Object.keys(generated)) {
  assert(!/^model:/m.test(await readFile(join(dir, role + ".md"), "utf8")), role + " should be route-free");
}

for (const [label, badText] of [
  ["checksum-invalid", migrated.replace(/# aria-checksum: ([0-9a-f])/, (_match, digit) => "# aria-checksum: " + (digit === "0" ? "1" : "0"))],
  ["extra-frontmatter", migrated.replace("---\\n\\n", "extra: true\\n---\\n\\n")],
]) {
  const conflictDir = join(${JSON.stringify(runDir)}, label + "-agents");
  await mkdir(conflictDir, { recursive: true });
  const conflictPath = join(conflictDir, "coder.md");
  await writeFile(conflictPath, badText);
  assert.match(badText, /# aria-version: .+/);
  assert.match(badText, /# aria-checksum: [0-9a-f]{64}/);
  const before = await readFile(conflictPath);
  await assert.rejects(reconcileManagedAgents(worktree, { dir: conflictDir }));
  assert.deepEqual(await readFile(conflictPath), before, label + " conflict must remain unchanged");
  assert.deepEqual(await readdir(conflictDir), ["coder.md"], label + " preflight must not partially write other roles");
}
console.log("smoke-package: installed agent migration/preflight ok");
`);
  execFileSync(process.execPath, [migrationProbe], { cwd: installRoot, stdio: "inherit", env: childEnv() });

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
