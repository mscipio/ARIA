import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorFileOps,
  type DoctorOptions,
} from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import type { ModelDiscovery } from "../src/model-config.js";
import {
  CODING_ROLES,
  effectiveRolePermissions,
  PACKAGE_SKILL_NAMES,
  roleRequirementIssues,
  validateZotPilotPolicy,
} from "../src/register.js";
import { ROLES } from "../src/routes.js";
import type { RoleName } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures: isolated HOME/worktree, healthy executor, defaults-matching models
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalWikiDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalWikiDir = process.env.WIKI_DIR;
  delete process.env.WIKI_DIR;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "aria-doctor-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-doctor-worktree-"));
  tempDirs.push(worktree);
  return worktree;
}

/** Global OpenCode config with the Context7 remote MCP configured. */
async function writeContext7Config(home: string): Promise<void> {
  const configDir = resolve(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({
    mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
  }));
}

/** Executor whose read-only probes all succeed. */
function healthyExecutor(): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: "opencode v1.2.3", stderr: "" };
    if (invocation === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return {
        stdout: [
          "opencode v1.2.3",
          "mcp:",
          "  engram     connected",
          "  context7   connected",
          "  codegraph  connected",
        ].join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: `unexpected probe: ${invocation}` };
  };
}

/** Every packaged default route model, with observable variant metadata. */
const DEFAULT_MODELS: ModelDiscovery = {
  models: [
    { id: "opencode-go/deepseek-v4-pro", providerID: "opencode-go", modelID: "deepseek-v4-pro", name: "DeepSeek V4 Pro", variants: [], variantsObservable: true },
    { id: "opencode-go/deepseek-v4-flash", providerID: "opencode-go", modelID: "deepseek-v4-flash", name: "DeepSeek V4 Flash", variants: ["high", "low"], variantsObservable: true },
    { id: "opencode-go/kimi-k2.7-code", providerID: "opencode-go", modelID: "kimi-k2.7-code", name: "Kimi K2.7 Code", variants: [], variantsObservable: true },
    { id: "openai/gpt-5.6-terra", providerID: "openai", modelID: "gpt-5.6-terra", name: "GPT 5.6 Terra", variants: ["xhigh", "high"], variantsObservable: true },
    { id: "openai/gpt-5.6-sol", providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT 5.6 Sol", variants: ["medium", "xhigh"], variantsObservable: true },
    { id: "opencode-go/glm-5.2", providerID: "opencode-go", modelID: "glm-5.2", name: "GLM 5.2", variants: [], variantsObservable: true },
  ],
};

/** Healthy option base: everything resolves. */
async function healthyOptions(worktree?: string): Promise<DoctorOptions & { worktree: string }> {
  const home = await makeHome();
  await writeContext7Config(home);
  const wt = worktree ?? await makeWorktree();
  return {
    worktree: wt,
    executor: healthyExecutor(),
    discovery: async () => DEFAULT_MODELS,
  };
}

function routeFinding(report: { findings: Array<{ area: string; severity: string; title: string; detail?: string }> }, role: RoleName) {
  return report.findings.find((finding) => finding.area === "routes/models" && finding.title === role);
}

/** Recursive fixture snapshot: relative path -> file content or `<dir>`. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = resolve(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[key] = "<dir>";
        await walk(target, key);
      } else if (entry.isFile()) {
        out[key] = await readFile(target, "utf8");
      } else {
        out[key] = "<other>";
      }
    }
  };
  await walk(root, "");
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("reports a defaults-ordered eleven-role healthy report with exit 0", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);

    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
    const routeRoles = report.findings
      .filter((finding) => finding.area === "routes/models" && (ROLES as string[]).includes(finding.title))
      .map((finding) => finding.title);
    expect(routeRoles).toEqual([...ROLES]);
    expect(report.findings.filter((finding) => finding.area === "routes/models" && (ROLES as string[]).includes(finding.title))
      .every((finding) => finding.severity === "PASS")).toBe(true);
    // Observable supported variants render their variant text in the report.
    expect(routeFinding(report, "explorer")?.detail).toBe("opencode-go/deepseek-v4-flash (high)");
    expect(routeFinding(report, "planner")?.detail).toBe("openai/gpt-5.6-terra (xhigh)");
    expect(routeFinding(report, "researcher")?.detail).toBe("openai/gpt-5.6-sol (medium)");
    // Variant-less routes render the bare model.
    expect(routeFinding(report, "coder")?.detail).toBe("opencode-go/deepseek-v4-pro");
    expect(report.findings.filter((finding) => finding.area === "dependencies")
      .every((finding) => finding.severity === "PASS")).toBe(true);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("reports a model-only override with the inherited variant cleared", async () => {
    const options = await healthyOptions();
    await writeFile(resolve(options.worktree, "aria.json"), JSON.stringify({
      roles: { researcher: { model: "openai/gpt-5.6-terra" } },
    }));
    const report = await runDoctor(options);

    const researcher = routeFinding(report, "researcher");
    expect(researcher?.severity).toBe("PASS");
    expect(researcher?.detail).toBe("openai/gpt-5.6-terra");
    expect(researcher?.detail).not.toContain("(medium)");
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("FAILs a resolved model that is not in the discovered list", async () => {
    const options = await healthyOptions();
    await writeFile(resolve(options.worktree, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/not-listed" } },
    }));
    const report = await runDoctor(options);

    const planner = routeFinding(report, "planner");
    expect(planner?.severity).toBe("FAIL");
    expect(planner?.detail).toContain("not listed");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs a listed model with an observably unsupported configured variant", async () => {
    const options = await healthyOptions();
    await writeFile(resolve(options.worktree, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.6-terra", variant: "turbo" } },
    }));
    const report = await runDoctor(options);

    const planner = routeFinding(report, "planner");
    expect(planner?.severity).toBe("FAIL");
    expect(planner?.detail).toContain("not supported");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("WARNs (never guesses) when variant metadata is not observable, exit 0 without other FAILs", async () => {
    const options = await healthyOptions();
    await writeFile(resolve(options.worktree, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" } },
    }));
    const unobservable: ModelDiscovery = {
      models: DEFAULT_MODELS.models.map((model) => (
        model.id === "openai/gpt-5.6-terra"
          ? { ...model, variantsObservable: undefined }
          : model
      )),
    };
    const report = await runDoctor({ ...options, discovery: async () => unobservable });

    const planner = routeFinding(report, "planner");
    expect(planner?.severity).toBe("WARN");
    expect(planner?.detail).toContain("not observable");
    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("aggregates invalid project config into FAIL/SKIP findings without throwing", async () => {
    const options = await healthyOptions();
    await writeFile(resolve(options.worktree, "aria.json"), "{broken");
    const report = await runDoctor(options);

    const config = report.findings.find((finding) => finding.area === "config");
    expect(config?.severity).toBe("FAIL");
    expect(report.findings.some((finding) => finding.area === "routes/models" && finding.severity === "SKIP")).toBe(true);
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("aggregates invalid global config into a FAIL finding without throwing", async () => {
    const home = await makeHome();
    await writeContext7Config(home);
    await writeFile(resolve(home, ".config", "opencode", "aria.json"), "{broken");
    const worktree = await makeWorktree();
    const report = await runDoctor({ worktree, executor: healthyExecutor(), discovery: async () => DEFAULT_MODELS });

    const config = report.findings.find((finding) => finding.area === "config");
    expect(config?.severity).toBe("FAIL");
    expect(config?.detail).toContain("aria.json");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("aggregates failed model discovery into a FAIL and skips route validation", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({
      ...options,
      discovery: async () => {
        throw new Error("opencode models failed: opencode not found");
      },
    });

    const discovery = report.findings.find((finding) => finding.area === "routes/models" && finding.title === "model discovery");
    expect(discovery?.severity).toBe("FAIL");
    expect(report.findings.some((finding) => finding.area === "routes/models" && finding.severity === "SKIP")).toBe(true);
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("strips ANSI escapes from embedded probe error text so rendered output stays plain", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({
      ...options,
      discovery: async () => {
        throw new Error("Command failed: opencode models --verbose\n\x1b[91m\x1b[1mError:\x1b[0m Unexpected error");
      },
    });

    const discovery = report.findings.find((finding) => finding.area === "routes/models" && finding.title === "model discovery");
    // eslint-disable-next-line no-control-regex
    expect(discovery?.detail).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(discovery?.detail).toContain("Error: Unexpected error");
    // eslint-disable-next-line no-control-regex
    expect(formatDoctorReport(report)).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("FAILs when the package.json version cannot be read", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        if (path.endsWith(`${sep}package.json`)) throw new Error("ENOENT");
        return readFile(path, "utf8");
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const version = report.findings.find((finding) => finding.area === "package" && finding.title === "package.json version");
    expect(version?.severity).toBe("FAIL");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs when a defaults-referenced prompt is missing", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        if (path.endsWith(`${sep}prompts${sep}coder.md`)) throw new Error("ENOENT");
        return readFile(path, "utf8");
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const prompt = report.findings.find((finding) => finding.area === "package" && finding.title === "prompt coder");
    expect(prompt?.severity).toBe("FAIL");
    expect(prompt?.detail).toContain("coder.md");
    // Other probes remain independent and healthy.
    expect(report.findings.find((finding) => finding.area === "config")?.severity).toBe("PASS");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs malformed packaged defaults with a missing role mode", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        if (path.endsWith(`${sep}defaults${sep}aria.defaults.json`)) {
          const defaults = JSON.parse(await readFile(path, "utf8")) as {
            roles: Record<string, { mode?: unknown }>;
          };
          delete defaults.roles["coder"]!.mode;
          return JSON.stringify(defaults);
        }
        return readFile(path, "utf8");
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const defaults = report.findings.find((finding) => finding.area === "package" && finding.title === "defaults");
    expect(defaults?.severity).toBe("FAIL");
    expect(defaults?.detail).toContain("defaults.roles.coder.mode");
    // Unrelated probes remain independent and healthy.
    expect(report.findings.find((finding) => finding.area === "config")?.severity).toBe("PASS");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("composes the existing dependency doctor as FAIL findings", async () => {
    const options = await healthyOptions();
    const noOpencode: Executor = async (command, args) => {
      if (command === "opencode" && args[0] === "--version") throw new Error("opencode: command not found");
      return healthyExecutor()(command, args);
    };
    const report = await runDoctor({ ...options, executor: noOpencode });

    const opencode = report.findings.find((finding) => finding.area === "dependencies" && finding.title === "OpenCode");
    expect(opencode?.severity).toBe("FAIL");
    expect(opencode?.detail).toBe("not found");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs each missing/unconfigured required integration while optional findings stay non-fatal", async () => {
    // No Context7 config in HOME, and engram/codegraph probes fail.
    await makeHome();
    const worktree = await makeWorktree();
    const executor: Executor = async (command, args) => {
      if (command === "engram" || command === "codegraph") throw new Error(`${command}: command not found`);
      return healthyExecutor()(command, args);
    };
    const report = await runDoctor({ worktree, executor, discovery: async () => DEFAULT_MODELS });

    const deps = Object.fromEntries(
      report.findings
        .filter((finding) => finding.area === "dependencies")
        .map((finding) => [finding.title, finding]),
    );
    expect(deps.OpenCode?.severity).toBe("PASS");
    expect(deps.Engram?.severity).toBe("FAIL");
    expect(deps.Engram?.detail).toBe("not found");
    expect(deps.Context7?.severity).toBe("FAIL");
    expect(deps.Context7?.detail).toBe("not configured");
    expect(deps.CodeGraph?.severity).toBe("FAIL");
    expect(deps.CodeGraph?.detail).toBe("not found");
    // Optional ZotPilot degradation stays non-fatal alongside the FAILs.
    expect(report.findings.filter((finding) => finding.area === "zotpilot" && finding.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T005: effective subagent-depth findings (merged `opencode debug config`
// surface only; no provenance inference, never FAIL)
// ---------------------------------------------------------------------------

describe("runDoctor subagent depth findings", () => {
  function depthFinding(report: { findings: Array<{ area: string; severity: string; title: string; detail?: string }> }) {
    return report.findings.find((finding) => finding.area === "config" && finding.title === "subagent depth");
  }

  /** Executor whose `opencode debug config` probe returns the given output. */
  function depthExecutor(debugConfigOutput: string): Executor {
    return async (command, args) => {
      if (command === "opencode" && args.join(" ") === "debug config") {
        return { stdout: debugConfigOutput, stderr: "" };
      }
      return healthyExecutor()(command, args);
    };
  }

  it("PASSes an absent depth with the runtime default/recommendation 3", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({ ...options, executor: depthExecutor("{}") });

    const finding = depthFinding(report);
    expect(finding?.severity).toBe("PASS");
    expect(finding?.detail).toContain("absent from merged debug config");
    expect(finding?.detail).toContain("default/recommendation 3");
    expect(finding?.detail).not.toContain("preserved");
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("PASSes a sufficient numeric depth reporting the effective value only", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({ ...options, executor: depthExecutor('{"subagent_depth": 5}') });

    const finding = depthFinding(report);
    expect(finding?.severity).toBe("PASS");
    expect(finding?.detail).toContain("effective value 5 is sufficient for nested ARIA cooperation");
    // No provenance inference and no explicit-preservation claim.
    expect(finding?.detail).not.toContain("user");
    expect(finding?.detail).not.toContain("preserved");
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("WARNs nonfatally on a shallow numeric depth with possible degraded cooperation", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({ ...options, executor: depthExecutor('{"subagent_depth": 2}') });

    const finding = depthFinding(report);
    expect(finding?.severity).toBe("WARN");
    expect(finding?.detail).toContain("effective value 2");
    expect(finding?.detail).toContain("may be degraded");
    expect(finding?.detail).not.toContain("user");
    expect(report.findings.filter((item) => item.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("handles malformed and unavailable merged config as a nonfatal WARN", async () => {
    const options = await healthyOptions();

    const malformed = depthFinding(await runDoctor({ ...options, executor: depthExecutor("{not json") }));
    expect(malformed?.severity).toBe("WARN");
    expect(malformed?.detail).toContain("effective value not identified");
    expect(malformed?.detail).toContain("not valid JSON");
    expect(doctorExitCode((await runDoctor({ ...options, executor: depthExecutor("{not json") })).findings)).toBe(0);

    const unavailable: Executor = async (command, args) => {
      if (command === "opencode" && args.join(" ") === "debug config") {
        throw new Error("opencode debug config failed: spawn opencode ENOENT");
      }
      return healthyExecutor()(command, args);
    };
    const report = await runDoctor({ ...options, executor: unavailable });
    const failed = depthFinding(report);
    expect(failed?.severity).toBe("WARN");
    expect(failed?.detail).toContain("effective value not identified");
    expect(failed?.detail).toContain("ENOENT");
    expect(report.findings.filter((item) => item.severity === "FAIL")).toHaveLength(0);
    expect(doctorExitCode(report.findings)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T002: derived package inventory and canonical role policy (no user-skill scan)
// ---------------------------------------------------------------------------

describe("package capability inventory (derived from canonical permission tables)", () => {
  it("derives the exact 21 packaged skills from the canonical role permissions", () => {
    expect([...PACKAGE_SKILL_NAMES]).toEqual([
      "rdc-code-exploration",
      "rdc-visual-analysis",
      "rdc-implementation-planning",
      "rdc-testing-discipline",
      "rdc-plan-review",
      "rdc-scope-assessment",
      "rdc-code-implementation",
      "rdc-implementation-review",
      "rdc-adversarial-review",
      "aria-research-evidence",
      "aria-zotero-tutor",
      "aria-wiki-lookup",
      "aria-wiki-archive",
      "aria-wiki-compile",
      "aria-academic-writing",
      "aria-writing-anti-ai",
      "aria-review-response",
      "aria-paper-self-review",
      "aria-document-design",
      "aria-research-planning",
      "aria-results-analysis",
    ]);
  });

  it("derives the coding roles and accepts the canonical role requirements", () => {
    expect([...CODING_ROLES]).toEqual([
      "coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer",
    ]);
    expect(roleRequirementIssues()).toEqual([]);
  });

  it("validates the canonical ZotPilot policy: allow reads, ask mutations, disjoint, no wildcards", () => {
    const policy = validateZotPilotPolicy();
    expect(policy.issues).toEqual([]);
    expect(policy.missing).toEqual([]);
    expect(policy.unexpected).toEqual([]);
    expect(policy.wildcards).toEqual([]);
    expect(policy.expectedReadIds.length).toBe(14);
    expect(policy.expectedMutationIds.length).toBe(8);
    expect([...policy.present].sort()).toEqual(
      [...policy.expectedReadIds, ...policy.expectedMutationIds].sort(),
    );
    const overlap = policy.expectedReadIds.filter((id) => policy.expectedMutationIds.includes(id));
    expect(overlap).toEqual([]);
  });

  it("catches ZotPilot allow/ask wildcards and policy mismatches", () => {
    const policy = validateZotPilotPolicy({
      "zotpilot_*": "allow",
      "zotpilot_any_*": "ask",
      zotpilot_search_papers: "ask", // read must be allow
      zotpilot_index_library: "allow", // mutation must be ask
      zotpilot_extra_tool: "allow", // unexpected ID
      // zotpilot_get_notes intentionally omitted
    });
    expect([...policy.wildcards].sort()).toEqual(["zotpilot_*", "zotpilot_any_*"]);
    expect(policy.unexpected).toEqual(["zotpilot_extra_tool"]);
    expect(policy.missing).toContain("zotpilot_get_notes");
    const issues = policy.issues.join("; ");
    expect(issues).toContain("zotpilot_search_papers must be allow");
    expect(issues).toContain("zotpilot_index_library must be ask");
    expect(issues).toContain("zotpilot_*");
    expect(issues).toContain("zotpilot_any_*");
  });

  it("catches non-coding role requirement violations", () => {
    const permissions = effectiveRolePermissions();
    const issues = roleRequirementIssues({
      ...permissions,
      writer: { ...permissions.writer, "engram_*": "allow" },
    });
    expect(issues.join("; ")).toContain("writer unexpectedly grants engram_*");
  });
});

// ---------------------------------------------------------------------------
// T002: ZotPilot CLI/MCP findings, limitation, skills, and Wiki
// ---------------------------------------------------------------------------

describe("runDoctor ZotPilot findings", () => {
  function zotFinding(report: { findings: Array<{ area: string; severity: string; title: string; detail?: string }> }, title: string) {
    return report.findings.find((finding) => finding.area === "zotpilot" && finding.title === title);
  }

  /** Executor with the ZotPilot CLI returning an identified version. */
  function zotCliExecutor(): Executor {
    return async (command, args) => {
      if (command === "zotpilot" && args.join(" ") === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      return healthyExecutor()(command, args);
    };
  }

  it("reports a PASS ZotPilot CLI finding clearly separate from ZotPilot MCP connectivity", async () => {
    const options = await healthyOptions();
    const report = await runDoctor({ ...options, executor: zotCliExecutor() });

    const cli = zotFinding(report, "ZotPilot CLI");
    expect(cli?.severity).toBe("PASS");
    expect(cli?.detail).toContain("0.5.3");
    const mcp = zotFinding(report, "ZotPilot MCP");
    expect(mcp?.severity).toBe("WARN"); // not listed in the healthy fixture's mcp list
    expect(mcp).not.toBe(cli);
  });

  it("WARNs on missing, failing, and unparseable ZotPilot CLI probes (never FAIL)", async () => {
    const options = await healthyOptions();

    const missing: Executor = async (command, args) => {
      if (command === "zotpilot") throw new Error("zotpilot: command not found");
      return healthyExecutor()(command, args);
    };
    const missingReport = await runDoctor({ ...options, executor: missing });
    const missingCli = zotFinding(missingReport, "ZotPilot CLI");
    expect(missingCli?.severity).toBe("WARN");
    expect(missingCli?.detail).toContain("command not found");
    expect(doctorExitCode(missingReport.findings)).toBe(0);

    const unparseable: Executor = async (command, args) => {
      if (command === "zotpilot") return { stdout: "no version here", stderr: "" };
      return healthyExecutor()(command, args);
    };
    const unparsedReport = await runDoctor({ ...options, executor: unparseable });
    const unparsedCli = zotFinding(unparsedReport, "ZotPilot CLI");
    expect(unparsedCli?.severity).toBe("WARN");
    expect(unparsedCli?.detail).toContain("not parseable");
    expect(doctorExitCode(unparsedReport.findings)).toBe(0);

    // A nonzero probe exit surfaces the executor failure as WARN, never FAIL.
    const nonzero: Executor = async (command, args) => {
      if (command === "zotpilot") throw new Error("Command failed: zotpilot --version (exit code 2)");
      return healthyExecutor()(command, args);
    };
    const nonzeroReport = await runDoctor({ ...options, executor: nonzero });
    const nonzeroCli = zotFinding(nonzeroReport, "ZotPilot CLI");
    expect(nonzeroCli?.severity).toBe("WARN");
    expect(nonzeroCli?.detail).toContain("Command failed");
    expect(doctorExitCode(nonzeroReport.findings)).toBe(0);
  });

  it("reports ZotPilot MCP connected as PASS and absent/disconnected as non-fatal WARN", async () => {
    const options = await healthyOptions();

    const withConnected: Executor = async (command, args) => {
      if (command === "opencode" && args.join(" ") === "mcp list") {
        return {
          stdout: [
            "MCP Servers",
            "",
            "engram connected", "engram mcp --tools=agent",
            "context7 connected", "https://mcp.context7.com/mcp",
            "codegraph connected", "codegraph serve --mcp",
            "zotpilot connected", "zotpilot mcp serve",
            "",
            "4 server(s)",
          ].join("\n"),
          stderr: "",
        };
      }
      return healthyExecutor()(command, args);
    };
    const connected = zotFinding(await runDoctor({ ...options, executor: withConnected }), "ZotPilot MCP");
    expect(connected?.severity).toBe("PASS");
    expect(connected?.detail).toContain("connected");

    const absent = zotFinding(await runDoctor(options), "ZotPilot MCP");
    expect(absent?.severity).toBe("WARN");
    expect(absent?.detail).toContain("not listed");
    expect(doctorExitCode((await runDoctor(options)).findings)).toBe(0);

    const withDisconnected: Executor = async (command, args) => {
      if (command === "opencode" && args.join(" ") === "mcp list") {
        return {
          stdout: [
            "MCP Servers",
            "",
            "engram connected", "engram mcp --tools=agent",
            "context7 connected", "https://mcp.context7.com/mcp",
            "codegraph connected", "codegraph serve --mcp",
            "zotpilot disconnected", "zotpilot mcp serve",
            "",
            "4 server(s)",
          ].join("\n"),
          stderr: "",
        };
      }
      return healthyExecutor()(command, args);
    };
    const disconnected = zotFinding(await runDoctor({ ...options, executor: withDisconnected }), "ZotPilot MCP");
    expect(disconnected?.severity).toBe("WARN");
    expect(disconnected?.detail).toContain("not connected");
  });

  it("states the live-tool-inventory limitation as SKIP without invoking tools/list or mutating commands", async () => {
    const options = await healthyOptions();
    // A real project config participates so the no-config-touch check is meaningful.
    await writeFile(resolve(options.worktree, "aria.json"), JSON.stringify({
      roles: { researcher: { variant: "xhigh" } },
    }));
    const homeBefore = await snapshotDir(process.env.HOME as string);
    const worktreeBefore = await snapshotDir(options.worktree);

    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return healthyExecutor()(command, args);
    };
    const report = await runDoctor({ ...options, executor });

    const limitation = zotFinding(report, "live tool inventory");
    expect(limitation?.severity).toBe("SKIP");
    expect(limitation?.detail).toContain("tools/list");
    // The read-only `opencode debug config` depth probe is not a mutation, so
    // exclude it from the mutating-command trace assertions.
    const trace = calls.filter((call) => call !== "opencode debug config").join("\n");
    for (const forbidden of [
      "tools", "install", "add", "setup", "update", "upgrade", "index",
      "mcp serve", "archive", "compile", "lint", "write", "prompt",
      "mutation", "zotero", "config",
    ]) {
      expect(trace).not.toContain(forbidden);
    }
    // No write, install, repair, or config/Zotero touch: fixtures unchanged.
    expect(await snapshotDir(process.env.HOME as string)).toEqual(homeBefore);
    expect(await snapshotDir(options.worktree)).toEqual(worktreeBefore);
  });
});

describe("runDoctor skills findings", () => {
  function skillFinding(report: { findings: Array<{ area: string; severity: string; title: string; detail?: string }> }, title: string) {
    return report.findings.find((finding) => finding.area === "skills" && finding.title === title);
  }

  it("validates the packaged skills with matching name and metadata.owner: aria, reading only derived paths", async () => {
    const options = await healthyOptions();
    const readPaths: string[] = [];
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        readPaths.push(path);
        return readFile(path, "utf8");
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const skills = skillFinding(report, "packaged skills");
    expect(skills?.severity).toBe("PASS");
    expect(skills?.detail).toContain("21 of 21");
    expect(skills?.detail).toContain("metadata.owner: aria");
    // Only the exact derived skill paths are read — the skills directory is
    // never scanned, so user skills are never touched.
    for (const path of readPaths) {
      if (!path.includes(`${sep}skills${sep}`)) continue;
      expect(PACKAGE_SKILL_NAMES.some((name) => path.endsWith(`${sep}skills${sep}${name}${sep}SKILL.md`))).toBe(true);
    }
  });

  it("FAILs a missing packaged skill", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        if (path.endsWith(`${sep}skills${sep}rdc-code-exploration${sep}SKILL.md`)) throw new Error("ENOENT");
        return readFile(path, "utf8");
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const skills = skillFinding(report, "packaged skills");
    expect(skills?.severity).toBe("FAIL");
    expect(skills?.detail).toContain("rdc-code-exploration");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs a skill whose metadata.owner is not aria", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        const text = await readFile(path, "utf8");
        if (path.endsWith(`${sep}skills${sep}aria-wiki-lookup${sep}SKILL.md`)) {
          return text.replace("owner: aria", "owner: someone-else");
        }
        return text;
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const skills = skillFinding(report, "packaged skills");
    expect(skills?.severity).toBe("FAIL");
    expect(skills?.detail).toContain("metadata.owner");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("FAILs a skill whose frontmatter name does not match its package path", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: async (path) => {
        const text = await readFile(path, "utf8");
        if (path.endsWith(`${sep}skills${sep}rdc-code-exploration${sep}SKILL.md`)) {
          return text.replace("name: rdc-code-exploration", "name: renamed-skill");
        }
        return text;
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const skills = skillFinding(report, "packaged skills");
    expect(skills?.severity).toBe("FAIL");
    expect(skills?.detail).toContain("frontmatter name mismatch");
    expect(skills?.detail).toContain("renamed-skill");
    expect(doctorExitCode(report.findings)).toBe(1);
  });

  it("reports canonical role requirements and ZotPilot policy findings as PASS", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);

    const roles = skillFinding(report, "role permission requirements");
    expect(roles?.severity).toBe("PASS");
    expect(roles?.detail).toContain("writer/archivist are non-coding");
    const policy = skillFinding(report, "ZotPilot policy");
    expect(policy?.severity).toBe("PASS");
    expect(policy?.detail).toContain("no wildcards");
  });
});

describe("runDoctor Wiki findings", () => {
  function wikiFinding(report: { findings: Array<{ area: string; severity: string; title: string; detail?: string }> }, title: string) {
    return report.findings.find((finding) => finding.area === "wiki" && finding.title === title);
  }

  it("reports WIKI_DIR unset as SKIP and packaged pipeline assets as PASS", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);

    const assets = wikiFinding(report, "wiki pipeline assets");
    expect(assets?.severity).toBe("PASS");
    expect(assets?.detail).toContain("6 of 6");
    const wikiDir = wikiFinding(report, "WIKI_DIR");
    expect(wikiDir?.severity).toBe("SKIP");
    expect(doctorExitCode(report.findings)).toBe(0);
  });

  it("FAILs a configured WIKI_DIR that does not exist or is not a directory", async () => {
    const options = await healthyOptions();

    process.env.WIKI_DIR = resolve(options.worktree, "no-such-wiki");
    const missing = wikiFinding(await runDoctor(options), "WIKI_DIR");
    expect(missing?.severity).toBe("FAIL");
    expect(missing?.detail).toContain("does not exist");

    const filePath = resolve(options.worktree, "wiki-file");
    await writeFile(filePath, "not a directory");
    process.env.WIKI_DIR = filePath;
    const file = wikiFinding(await runDoctor(options), "WIKI_DIR");
    expect(file?.severity).toBe("FAIL");
    expect(file?.detail).toContain("not a directory");
    expect(doctorExitCode((await runDoctor(options)).findings)).toBe(1);
  });

  it("PASSes an accessible WIKI_DIR and FAILs one lacking read/write accessibility", async () => {
    const options = await healthyOptions();
    const wikiDir = await mkdtemp(resolve(tmpdir(), "aria-doctor-wiki-"));
    tempDirs.push(wikiDir);

    process.env.WIKI_DIR = wikiDir;
    const accessible = wikiFinding(await runDoctor(options), "WIKI_DIR");
    expect(accessible?.severity).toBe("PASS");
    expect(accessible?.detail).toContain("accessible directory");

    process.env.WIKI_DIR = wikiDir;
    const deniedFileOps: DoctorFileOps = {
      readText: (path) => readFile(path, "utf8"),
      access: async (path) => {
        if (path === wikiDir) throw new Error("EACCES: permission denied");
      },
    };
    const denied = wikiFinding(await runDoctor({ ...options, fileOps: deniedFileOps }), "WIKI_DIR");
    expect(denied?.severity).toBe("FAIL");
    expect(denied?.detail).toContain("read/write accessibility");
    expect(doctorExitCode((await runDoctor({ ...options, fileOps: deniedFileOps })).findings)).toBe(1);
  });

  it("FAILs a missing packaged wiki pipeline asset", async () => {
    const options = await healthyOptions();
    const fileOps: DoctorFileOps = {
      readText: (path) => readFile(path, "utf8"),
      stat: async (path) => {
        if (path.endsWith(`${sep}wiki-pipeline${sep}run.py`)) throw new Error("ENOENT");
        return fsStat(path);
      },
    };
    const report = await runDoctor({ ...options, fileOps });

    const assets = wikiFinding(report, "wiki pipeline assets");
    expect(assets?.severity).toBe("FAIL");
    expect(assets?.detail).toContain("run.py");
    expect(doctorExitCode(report.findings)).toBe(1);
  });
});

describe("runDoctor severity separation", () => {
  it("keeps optional ZotPilot/Wiki degradation WARN/SKIP while required integrations remain PASS", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);

    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
    expect(report.findings.find((finding) => finding.area === "zotpilot" && finding.title === "ZotPilot CLI")?.severity).toBe("WARN");
    expect(report.findings.find((finding) => finding.area === "zotpilot" && finding.title === "ZotPilot MCP")?.severity).toBe("WARN");
    expect(report.findings.find((finding) => finding.area === "zotpilot" && finding.title === "live tool inventory")?.severity).toBe("SKIP");
    expect(report.findings.find((finding) => finding.area === "wiki" && finding.title === "WIKI_DIR")?.severity).toBe("SKIP");
    expect(report.findings.filter((finding) => finding.area === "dependencies")
      .every((finding) => finding.severity === "PASS")).toBe(true);
    expect(doctorExitCode(report.findings)).toBe(0);
  });
});

describe("formatDoctorReport", () => {
  it("renders plain output with literal PASS labels and all eleven roles", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);
    const text = formatDoctorReport(report);

    expect(text).toContain("ARIA doctor");
    expect(text).toContain("[PASS] package.json version: ");
    for (const role of ROLES) expect(text).toContain(role);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("stays plain and JSON-free even with NO_COLOR set", async () => {
    const options = await healthyOptions();
    const report = await runDoctor(options);
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const text = formatDoctorReport(report);

      expect(text).toContain("ARIA doctor");
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/\x1b\[[0-9;]*m/);
      // No JSON mode or payload: no JSON open/close or serialized findings.
      expect(text.trimStart().startsWith("{")).toBe(false);
      expect(text).not.toContain('"findings"');
      expect(text).not.toContain('"severity"');
    } finally {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    }
  });
});
