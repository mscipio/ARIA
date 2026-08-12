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
  "bin/aria.mjs",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/register.js",
  "dist/deps.js",
  "dist/routes.js",
  "defaults/aria.defaults.json",
  "defaults/prompts/coder.md",
  "defaults/prompts/planner.md",
  "defaults/prompts/architect.md",
  "defaults/prompts/implementer.md",
  "defaults/prompts/reviewer.md",
  "defaults/prompts/explorer.md",
  "defaults/prompts/visualizer.md",
  "defaults/prompts/archivist.md",
  "defaults/prompts/writer.md",
  "skills/rdc-code-exploration/SKILL.md",
  "skills/rdc-visual-analysis/SKILL.md",
  "skills/rdc-implementation-planning/SKILL.md",
  "skills/rdc-plan-review/SKILL.md",
  "skills/rdc-scope-assessment/SKILL.md",
  "skills/rdc-code-implementation/SKILL.md",
  "skills/rdc-implementation-review/SKILL.md",
  "skills/rdc-testing-discipline/SKILL.md",
  "skills/aria-wiki-lookup/SKILL.md",
  "skills/aria-wiki-archive/SKILL.md",
  "skills/aria-wiki-compile/SKILL.md",
  "skills/aria-academic-writing/SKILL.md",
  "skills/aria-writing-anti-ai/SKILL.md",
  "skills/aria-review-response/SKILL.md",
  "skills/aria-paper-self-review/SKILL.md",
  "dist/lifecycle.js",
  "dist/lifecycle.d.ts",
  "dist/model-config.js",
  "dist/model-config.d.ts",
  // wiki-pipeline: implementation + supporting docs
  "wiki-pipeline/__init__.py",
  "wiki-pipeline/compiler.py",
  "wiki-pipeline/run.py",
  "wiki-pipeline/search.py",
  "wiki-pipeline/docs/compile-workflow.md",
  "wiki-pipeline/docs/instructions.md",
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
const installRoot = mkdtempSync(join(tmpdir(), "aria-package-"));
const probePath = join(installRoot, "probe.mjs");

try {
  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-save", tarball], {
    cwd: installRoot,
    stdio: "inherit",
  });

  writeFileSync(
    probePath,
    `const pluginModule = await import("aria");
const plugin = pluginModule.default;

if (plugin?.id !== "aria") {
  console.error("smoke-package: expected plugin id aria, got", plugin?.id);
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
const coder = config.agent?.coder;
if (coder?.mode !== "primary") {
  console.error("smoke-package: coder.mode is not primary");
  process.exit(1);
}
if (coder?.hidden === true) {
  console.error("smoke-package: coder must not be hidden");
  process.exit(1);
}
if (config.agent?.writer?.mode !== "primary") {
  console.error("smoke-package: writer.mode is not primary");
  process.exit(1);
}
if (config.agent?.["archivist"]?.mode !== "all") {
  console.error("smoke-package: archivist.mode is not all");
  process.exit(1);
}
if (!(config.skills?.paths ?? []).some((value) => value.endsWith("/aria/skills") || value.endsWith("\\aria\\skills"))) {
  console.error("smoke-package: package skill path is not registered", config.skills?.paths);
  process.exit(1);
}

const agents = Object.keys(config.agent ?? {});
const expected = ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "writer", "archivist"];
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

  // Verify aria routes binary works from the installed package
  const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
  const routesOutput = execFileSync(process.execPath, [ariaBin, "routes"], {
    cwd: installRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (!routesOutput.includes("Resolved ARIA role routes:")) {
    fail("aria routes did not produce expected header");
  }
  if (!routesOutput.includes("coder  opencode-go/deepseek-v4-pro")) {
    fail("aria routes did not include coder role");
  }

  // Verify aria routes honors project-local aria.json from CWD
  writeFileSync(
    join(installRoot, "aria.json"),
    JSON.stringify({ roles: { explorer: { variant: "xhigh" } } }),
  );
  const overrideOutput = execFileSync(process.execPath, [ariaBin, "routes"], {
    cwd: installRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (!overrideOutput.includes("explorer  opencode-go/deepseek-v4-flash (xhigh)")) {
    fail("aria routes did not reflect project-local aria.json override");
  }

  // Verify installed-package help lists setup and update
  const helpOutput = execFileSync(process.execPath, [ariaBin, "--help"], {
    cwd: installRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (!helpOutput.includes("setup")) {
    fail("aria --help does not mention setup");
  }
  if (!helpOutput.includes("update")) {
    fail("aria --help does not mention update");
  }
  if (!helpOutput.includes("--configure")) {
    fail("aria --help does not advertise setup --configure");
  }
} finally {
  rmSync(tarball, { force: true });
  rmSync(installRoot, { recursive: true, force: true });
}
