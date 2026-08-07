import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { normalizePackEntry } from "../dist/pack.js";

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
const packed = JSON.parse(runNpm(["pack", "--json"], { cwd: packageRoot, encoding: "utf8" }));
const entry = normalizePackEntry(packed);
if (!entry?.filename) fail("npm pack did not return a tarball");

const packedPaths = new Set((entry.files ?? []).map((file) => file.path.replaceAll("\\", "/")));
const requiredPaths = [
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/register.js",
  "defaults/review-driven-code.defaults.json",
  "defaults/prompts/director.md",
  "defaults/prompts/planner.md",
  "defaults/prompts/architect.md",
  "defaults/prompts/implementer.md",
  "defaults/prompts/reviewer.md",
  "defaults/prompts/explorer.md",
  "defaults/prompts/visualizer.md",
];
for (const path of requiredPaths) {
  if (!packedPaths.has(path)) fail(`packed tarball is missing ${path}`);
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

const tarball = join(packageRoot, entry.filename);
const installRoot = mkdtempSync(join(tmpdir(), "review-driven-code-package-"));
const probePath = join(installRoot, "probe.mjs");

try {
  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-save", tarball], {
    cwd: installRoot,
    stdio: "inherit",
  });

  writeFileSync(
    probePath,
    `const pluginModule = await import("review-driven-code");
const plugin = pluginModule.default;

if (plugin?.id !== "review-driven-code") {
  console.error("smoke-package: expected plugin id review-driven-code, got", plugin?.id);
  process.exit(1);
}
if (typeof plugin?.server !== "function") {
  console.error("smoke-package: plugin.server is not a function");
  process.exit(1);
}

const hooks = await plugin.server({ directory: process.cwd(), worktree: process.cwd() }, {});
if (typeof hooks?.config !== "function") {
  console.error("smoke-package: hooks.config is not a function");
  process.exit(1);
}
if (typeof hooks?.tool?.plan !== "object" && typeof hooks?.tool?.plan !== "function") {
  console.error("smoke-package: hooks.tool.plan is missing");
  process.exit(1);
}

const config = {};
await hooks.config(config);
const director = config.agent?.director;
if (director?.mode !== "primary") {
  console.error("smoke-package: director.mode is not primary");
  process.exit(1);
}
if (director?.hidden === true) {
  console.error("smoke-package: director must not be hidden");
  process.exit(1);
}

const agents = Object.keys(config.agent ?? {});
const expected = ["director", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"];
if (expected.some((name) => !agents.includes(name))) {
  console.error("smoke-package: missing agents", expected.filter((name) => !agents.includes(name)));
  process.exit(1);
}

console.log("smoke-package: ok", {
  id: plugin.id,
  version: ${JSON.stringify(entry.version)},
  agents: agents.length,
  tools: Object.keys(hooks.tool ?? {}),
});
`,
  );

  execFileSync(process.execPath, [probePath], {
    cwd: installRoot,
    stdio: "inherit",
    env: process.env,
  });
} finally {
  rmSync(tarball, { force: true });
  rmSync(installRoot, { recursive: true, force: true });
}
