import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  "dist/doctor.js",
  "dist/doctor.d.ts",
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
  "defaults/prompts/researcher.md",
  "defaults/prompts/scientist.md",
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
  "skills/aria-document-design/SKILL.md",
  "skills/aria-research-evidence/SKILL.md",
  "skills/aria-research-planning/SKILL.md",
  "skills/aria-results-analysis/SKILL.md",
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
const smokeEnv = {
  ...process.env,
  HOME: installRoot,
  USERPROFILE: installRoot,
};

try {
  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-save", tarball], {
    cwd: installRoot,
    stdio: "inherit",
  });

  writeFileSync(
    probePath,
    `const { readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const pluginModule = await import("aria");
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
if (coder?.mode !== "all") {
  console.error("smoke-package: coder.mode is not all");
  process.exit(1);
}
if (coder?.hidden === true) {
  console.error("smoke-package: coder must not be hidden");
  process.exit(1);
}
if (config.agent?.writer?.mode !== "all") {
  console.error("smoke-package: writer.mode is not all");
  process.exit(1);
}
if (config.agent?.["archivist"]?.mode !== "all") {
  console.error("smoke-package: archivist.mode is not all");
  process.exit(1);
}
if (config.agent?.researcher?.mode !== "all") {
  console.error("smoke-package: researcher.mode is not all");
  process.exit(1);
}
if (config.agent?.researcher?.prompt?.includes("aria-research-evidence") !== true) {
  console.error("smoke-package: researcher prompt does not reference its research skill");
  process.exit(1);
}
if (!(config.skills?.paths ?? []).some((value) => value.endsWith("/aria/skills") || value.endsWith("\\aria\\skills"))) {
  console.error("smoke-package: package skill path is not registered", config.skills?.paths);
  process.exit(1);
}

// Scientist model/variant/mode and prompt contract from the packed install.
const scientist = config.agent?.scientist;
if (!scientist) {
  console.error("smoke-package: scientist agent is missing");
  process.exit(1);
}
if (scientist.mode !== "all" || scientist.model !== "openai/gpt-5.6-sol" || scientist.variant !== "medium") {
  console.error("smoke-package: scientist model/variant/mode mismatch", scientist.model, scientist.variant, scientist.mode);
  process.exit(1);
}
const scientistPrompt = scientist.prompt ?? "";
if (
  !scientistPrompt.includes("scientific authority")
  || !scientistPrompt.includes("aria-research-planning")
  || !scientistPrompt.includes("aria-results-analysis")
  || !scientistPrompt.includes("researcher")
  || !scientistPrompt.includes("writer")
  || !scientistPrompt.includes("coder")
  || !scientistPrompt.includes("active ancestor")
) {
  console.error("smoke-package: scientist prompt contract mismatch");
  process.exit(1);
}

// Bounded scientist ACL: deny-by-default tools, no MCP/persistence authority.
const scientistPermission = scientist.permission ?? {};
if (
  scientistPermission.edit !== "deny"
  || scientistPermission.bash !== "deny"
  || scientistPermission.plan !== "deny"
  || scientistPermission["engram_*"] !== undefined
  || scientistPermission["context7_*"] !== undefined
  || scientistPermission["codegraph_*"] !== undefined
) {
  console.error("smoke-package: scientist ACL grants unexpected authority");
  process.exit(1);
}
const expectedScientistTask = { "*": "deny", researcher: "allow", writer: "allow", coder: "allow" };
const expectedScientistSkill = { "*": "deny", "aria-research-planning": "allow", "aria-results-analysis": "allow" };
if (JSON.stringify(scientistPermission.task) !== JSON.stringify(expectedScientistTask)) {
  console.error("smoke-package: scientist task ACL mismatch", JSON.stringify(scientistPermission.task));
  process.exit(1);
}
if (JSON.stringify(scientistPermission.skill) !== JSON.stringify(expectedScientistSkill)) {
  console.error("smoke-package: scientist skill ACL mismatch", JSON.stringify(scientistPermission.skill));
  process.exit(1);
}

// Runtime depth default: absent becomes 3; an explicit depth stays unchanged.
if (config.subagent_depth !== 3) {
  console.error("smoke-package: absent subagent_depth did not default to 3");
  process.exit(1);
}
const explicitConfig = { subagent_depth: 2, skills: { paths: ["/custom/skills"] } };
await hooks.config(explicitConfig);
if (explicitConfig.subagent_depth !== 2) {
  console.error("smoke-package: explicit subagent_depth was not preserved");
  process.exit(1);
}
const explicitPaths = explicitConfig.skills?.paths ?? [];
if (
  explicitPaths.length !== 2
  || explicitPaths[0] !== "/custom/skills"
  || !(String(explicitPaths[1]).endsWith("/aria/skills") || String(explicitPaths[1]).endsWith("\\aria\\skills"))
) {
  console.error("smoke-package: explicit skill path was not preserved/appended", explicitPaths);
  process.exit(1);
}

// Packed scientist prompt and both scientist method skills exist with the
// standard ARIA frontmatter.
const packedPrompt = readFileSync(join(process.cwd(), "node_modules", "aria", "defaults", "prompts", "scientist.md"), "utf8");
if (!packedPrompt.includes("scientific authority")) {
  console.error("smoke-package: packed scientist prompt is missing or wrong");
  process.exit(1);
}
const skillsDir = join(process.cwd(), "node_modules", "aria", "skills");
const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (skillNames.length !== 19) {
  console.error("smoke-package: expected 19 packaged skills, got", skillNames.length);
  process.exit(1);
}
if (skillNames.filter((name) => name.startsWith("rdc-")).length !== 8) {
  console.error("smoke-package: expected 8 rdc-* skills");
  process.exit(1);
}
if (skillNames.filter((name) => name.startsWith("aria-")).length !== 11) {
  console.error("smoke-package: expected 11 aria-* skills");
  process.exit(1);
}
for (const name of ["aria-research-planning", "aria-results-analysis"]) {
  if (!skillNames.includes(name)) {
    console.error("smoke-package: packed skills are missing " + name);
    process.exit(1);
  }
  const skillText = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
  if (!skillText.includes("name: " + name) || !skillText.includes("owner: aria") || !skillText.includes("compatibility: opencode")) {
    console.error("smoke-package: " + name + " frontmatter mismatch");
    process.exit(1);
  }
}

const agents = Object.keys(config.agent ?? {});
const expectedAgents = ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "researcher", "archivist", "writer", "scientist"];
if (JSON.stringify(agents) !== JSON.stringify(expectedAgents)) {
  console.error("smoke-package: expected the 11 canonical agents in canonical order", agents);
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
    env: smokeEnv,
  });

  // Verify aria routes binary works from the installed package
  const ariaBin = join(installRoot, "node_modules", ".bin", "aria");
  const routesOutput = execFileSync(process.execPath, [ariaBin, "routes"], {
    cwd: installRoot,
    encoding: "utf8",
    env: smokeEnv,
  });
  if (!routesOutput.includes("Resolved ARIA role routes:")) {
    fail("aria routes did not produce expected header");
  }
  if (!routesOutput.includes("coder  opencode-go/deepseek-v4-pro")) {
    fail("aria routes did not include coder role");
  }
  if (!routesOutput.includes("researcher  openai/gpt-5.6-sol (medium)")) {
    fail("aria routes did not include researcher role");
  }
  if (!routesOutput.includes("scientist  openai/gpt-5.6-sol (medium)")) {
    fail("aria routes did not include scientist role");
  }

  // Verify aria routes honors project-local aria.json from CWD
  writeFileSync(
    join(installRoot, "aria.json"),
    JSON.stringify({ roles: { explorer: { variant: "xhigh" } } }),
  );
  const overrideOutput = execFileSync(process.execPath, [ariaBin, "routes"], {
    cwd: installRoot,
    encoding: "utf8",
    env: smokeEnv,
  });
  if (!overrideOutput.includes("explorer  opencode-go/deepseek-v4-flash (xhigh)")) {
    fail("aria routes did not reflect project-local aria.json override");
  }

  // Verify installed-package help lists setup and update
  const helpOutput = execFileSync(process.execPath, [ariaBin, "--help"], {
    cwd: installRoot,
    encoding: "utf8",
    env: smokeEnv,
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

  // -------------------------------------------------------------------------
  // Hermetic `aria doctor` smoke: the installed package's real CLI must
  // produce a read-only, plain, exit-0 report using only the read-only
  // probes below, with no access to user binaries, HOME config, Wiki, Zotero,
  // the network, or a live OpenCode session.
  // -------------------------------------------------------------------------

  // The override check above left a project-local aria.json; remove it so the
  // doctor observes the pure packaged defaults.
  rmSync(join(installRoot, "aria.json"), { force: true });

  // Model metadata derived from the packaged defaults: every defaults-
  // referenced model is listed, and its verbose block reports exactly the
  // variants the packaged defaults configure for it.
  const installedDefaults = JSON.parse(
    readFileSync(join(installRoot, "node_modules", "aria", "defaults", "aria.defaults.json"), "utf8"),
  );
  const modelIds = [];
  const variantsByModel = new Map();
  for (const role of Object.values(installedDefaults.roles ?? {})) {
    if (!modelIds.includes(role.model)) modelIds.push(role.model);
    if (role.variant) {
      const seen = variantsByModel.get(role.model) ?? [];
      if (!seen.includes(role.variant)) variantsByModel.set(role.model, [...seen, role.variant]);
    }
  }

  // Temporary fake executables shadowing the real tools on PATH. Each accepts
  // only the exact read-only argv doctor needs and rejects everything else,
  // logging every invocation so the probe allowlist can be asserted.
  const fakeBin = join(installRoot, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const invocationLog = join(fakeBin, "invocations.log");

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
  // ZotPilot is included as an MCP server-status line but disconnected, so
  // the smoke covers the separate non-fatal MCP connectivity WARN alongside
  // the ZotPilot CLI PASS.
  writeFileSync(
    join(fakeBin, "mcp-list.txt"),
    ["engram connected", "context7 connected", "codegraph connected", "zotpilot disconnected", ""].join("\n"),
  );
  // Merged debug config surface the depth probe consumes: a sufficient
  // effective subagent_depth for nested ARIA cooperation.
  writeFileSync(join(fakeBin, "debug-config.txt"), '{"subagent_depth": 4}\n');

  const fakeScript = (name, approved) => {
    const body = approved
      .map(({ match, out, file }) => {
        const emit = file ? `/bin/cat "${join(fakeBin, file)}"` : `echo "${out}"`;
        return `if ${match}; then\n  ${emit}\n  exit 0\nfi`;
      })
      .join("\n");
    return `#!/bin/sh
echo "${name} $*" >> "${invocationLog}"
${body}
echo "refused: ${name} $*" >&2
exit 2
`;
  };
  writeFileSync(
    join(fakeBin, "opencode"),
    fakeScript("opencode", [
      { match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "opencode 1.0.0" },
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
  // The fake zotpilot accepts only the verified version probe (T002 verified
  // `zotpilot --version` -> "zotpilot 0.5.3") and rejects every other argv.
  writeFileSync(
    join(fakeBin, "zotpilot"),
    fakeScript("zotpilot", [{ match: '[ "$#" -eq 1 ] && [ "$1" = "--version" ]', out: "zotpilot 0.5.3" }]),
  );
  for (const name of ["opencode", "engram", "codegraph", "zotpilot"]) {
    chmodSync(join(fakeBin, name), 0o755);
  }

  // Temporary Context7 configuration in the isolated HOME, matching the
  // canonical remote MCP server doctor expects.
  mkdirSync(join(installRoot, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(installRoot, ".config", "opencode", "opencode.json"),
    `${JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }, null, 2)}\n`,
  );

  const doctorEnv = {
    ...smokeEnv,
    NO_COLOR: "1",
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  };
  delete doctorEnv.WIKI_DIR;

  let doctorOutput;
  try {
    doctorOutput = execFileSync(process.execPath, [ariaBin, "doctor"], {
      cwd: installRoot,
      encoding: "utf8",
      env: doctorEnv,
    });
  } catch (error) {
    fail(`installed aria doctor exited nonzero:\n${error.stdout || error.stderr || error}`);
  }

  if (!doctorOutput.includes("ARIA doctor")) fail("doctor output missing report header");
  if (!doctorOutput.includes("[PASS]")) fail("doctor output has no PASS finding");
  if (!doctorOutput.includes("[WARN]")) fail("doctor output has no WARN finding");
  if (!doctorOutput.includes("[SKIP]")) fail("doctor output has no SKIP finding");
  if (doctorOutput.includes("[FAIL]")) fail("doctor output unexpectedly contains FAIL");
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(doctorOutput)) fail("doctor output contains ANSI escapes");

  const roleNames = [
    "coder", "explorer", "visualizer", "planner", "architect",
    "implementer", "reviewer", "researcher", "archivist", "writer", "scientist",
  ];
  for (const role of roleNames) {
    if (!doctorOutput.includes(`[PASS] ${role}:`)) {
      fail(`doctor output missing PASS route finding for ${role}`);
    }
  }
  if (!doctorOutput.includes(`model discovery: ${modelIds.length} models reported`)) {
    fail("doctor output missing model discovery finding");
  }

  const packageVersion = entry.version
    ?? JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
  if (!doctorOutput.includes(`package.json version: ${packageVersion}`)) {
    fail("doctor did not read the installed package.json version");
  }
  if (!doctorOutput.includes("[PASS] Context7")) fail("doctor output missing Context7 PASS");
  if (!doctorOutput.includes("WIKI_DIR")) fail("doctor output missing WIKI_DIR SKIP finding");

  if (!doctorOutput.includes("ZotPilot CLI")) fail("doctor output missing separate ZotPilot CLI finding");
  if (!doctorOutput.includes("available (0.5.3) via zotpilot --version")) {
    fail("doctor ZotPilot CLI finding missing the verified version");
  }
  if (!doctorOutput.includes("ZotPilot MCP")) fail("doctor output missing separate ZotPilot MCP finding");
  if (!doctorOutput.includes("listed by opencode mcp list but not connected")) {
    fail("doctor ZotPilot MCP finding missing disconnected detail");
  }
  if (!doctorOutput.includes("live tool inventory")) {
    fail("doctor output missing live-tool-inventory limitation");
  }
  if (!doctorOutput.includes("cannot compare expected/present/missing/unexpected live ZotPilot tool IDs")) {
    fail("doctor live-tool-inventory limitation no longer states the unsupported ID comparison");
  }
  if (!doctorOutput.includes("tools/list")) {
    fail("doctor live-tool-inventory limitation missing tools/list wording");
  }
  if (!doctorOutput.includes("19 of 19 validated")) {
    fail("doctor packaged skills finding does not report the exact 19-skill inventory");
  }
  // The doctor consumes the merged debug config surface: the fake reports an
  // effective subagent_depth of 4, which is sufficient (PASS, effective value).
  if (!doctorOutput.includes("[PASS] subagent depth: effective value 4 is sufficient for nested ARIA cooperation")) {
    fail("doctor did not consume the merged debug config subagent_depth");
  }

  // Probe allowlist: the doctor must have invoked exactly the read-only
  // probes the fakes accept — nothing else (no tools/list, add, install,
  // setup, serve, upgrade, index, or any other argument).
  const expectedInvocations = [
    "opencode --version",
    "opencode models",
    "opencode models --verbose",
    "opencode mcp list",
    "opencode debug config",
    "engram version",
    "codegraph --version",
    "zotpilot --version",
  ].sort();
  const invocations = readFileSync(invocationLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  if (JSON.stringify(invocations) !== JSON.stringify(expectedInvocations)) {
    fail(`doctor probe allowlist mismatch:\n  expected: ${expectedInvocations.join(", ")}\n  actual:   ${invocations.join(", ")}`);
  }

  const findingCount = (doctorOutput.match(/\[(?:PASS|WARN|FAIL|SKIP)\]/g) ?? []).length;
  console.log(`smoke-package: doctor ok (exit 0, ${findingCount} findings, plain output, separate ZotPilot CLI/MCP findings)`);
} finally {
  rmSync(tarball, { force: true });
  rmSync(installRoot, { recursive: true, force: true });
}
