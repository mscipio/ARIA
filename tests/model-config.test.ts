import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  configureModels,
  discoverAvailableModels,
  ModelDiscoveryError,
  parseModelList,
  parseModelVerbose,
  type ModelConfigureInput,
  type ModelConfigureOutput,
  type ModelDiscovery,
} from "../src/model-config.js";
import { resolveAriaConfig } from "../src/overrides.js";

// ---------------------------------------------------------------------------
// opencode CLI seam mock (only the discoverAvailableModels tests exercise it)
// ---------------------------------------------------------------------------

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const execMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execMocks.execFile,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalNoColor: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR; // ANSI styling enabled unless a test sets it
  vi.clearAllMocks();
  execMocks.execFile.mockReset();
  execMocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      callback(null, "", "");
    },
  );
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ROLES = [
  "coder",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "researcher",
  "archivist",
  "writer",
] as const;

/** Scripted input seam: answers in order, then empty string (cancel). */
function scriptedInput(answers: string[]): { input: ModelConfigureInput; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    input: async (prompt: string) => {
      calls.push(prompt);
      return answers[index++] ?? "";
    },
  };
}

/** Output seam that records every emitted line. */
function collectOutput(): { output: ModelConfigureOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    output: (text: string) => {
      lines.push(...text.split("\n"));
    },
  };
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "aria-model-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  return home;
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-model-worktree-"));
  tempDirs.push(worktree);
  return worktree;
}

function globalConfigDir(home: string): string {
  return resolve(home, ".config", "opencode");
}

async function writeGlobalConfig(
  home: string,
  roles: Record<string, { model?: string; variant?: string }>,
  filename = "aria.json",
): Promise<string> {
  const configDir = globalConfigDir(home);
  await mkdir(configDir, { recursive: true });
  const path = resolve(configDir, filename);
  await writeFile(path, `${JSON.stringify({ roles }, null, 2)}\n`);
  return path;
}

async function readWrittenRoles(home: string): Promise<Record<string, { model?: string; variant?: string }>> {
  const written = JSON.parse(
    await readFile(resolve(globalConfigDir(home), "aria.json"), "utf8"),
  ) as { roles?: Record<string, { model?: string; variant?: string }> };
  return written.roles ?? {};
}

const PLAIN_MODELS_OUTPUT = [
  "opencode-go/deepseek-v4-pro",
  "openai/gpt-5.6-terra",
].join("\n");

const VERBOSE_MODELS_OUTPUT = [
  "opencode-go/deepseek-v4-pro",
  "{",
  '  "id": "deepseek-v4-pro",',
  '  "providerID": "opencode-go",',
  '  "name": "DeepSeek V4 Pro",',
  '  "variants": {',
  '    "low": { "reasoningEffort": "low" },',
  '    "high": { "reasoningEffort": "high" }',
  "  }",
  "}",
  "openai/gpt-5.6-terra",
  "{",
  '  "id": "gpt-5.6-terra",',
  '  "providerID": "openai",',
  '  "name": "GPT 5.6 Terra",',
  '  "variants": {',
  '    "xhigh": { "reasoningEffort": "xhigh" },',
  '    "high": { "reasoningEffort": "high" }',
  "  }",
  "}",
].join("\n");

const DISCOVERED_MODELS: ModelDiscovery = {
  models: [
    {
      id: "opencode-go/deepseek-v4-pro",
      providerID: "opencode-go",
      modelID: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      variants: [],
    },
    {
      id: "openai/gpt-5.6-terra",
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      name: "GPT 5.6 Terra",
      variants: ["xhigh", "high"],
    },
  ],
};

/** `count` discovered models sharing the `bench/model-NN` identifier family. */
function makeManyModels(count: number): ModelDiscovery {
  return {
    models: Array.from({ length: count }, (_unused, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        id: `bench/model-${number}`,
        providerID: "bench",
        modelID: `model-${number}`,
        name: `Model ${number}`,
        variants: [],
      };
    }),
  };
}

/** DISCOVERED_MODELS plus a second gpt-5.6 model for multi-match searches. */
const WITH_LUNA_MODELS: ModelDiscovery = {
  models: [
    ...DISCOVERED_MODELS.models,
    {
      id: "openai/gpt-5.6-luna",
      providerID: "openai",
      modelID: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      variants: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// opencode CLI output parsers
// ---------------------------------------------------------------------------

describe("parseModelList", () => {
  it("parses one usable model identifier per line", () => {
    const models = parseModelList("opencode/deepseek-v4-flash\n\nopenai/gpt-5.6-terra\n");

    expect(models).toEqual([
      {
        id: "opencode/deepseek-v4-flash",
        providerID: "opencode",
        modelID: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        variants: [],
      },
      {
        id: "openai/gpt-5.6-terra",
        providerID: "openai",
        modelID: "gpt-5.6-terra",
        name: "gpt-5.6-terra",
        variants: [],
      },
    ]);
  });

  it("ignores blank and malformed lines", () => {
    expect(parseModelList("\nnot a model\nbroken/model id\n")).toEqual([]);
  });

  it("leaves variant metadata unobservable for the plain model list", () => {
    const models = parseModelList("opencode/deepseek-v4-flash\n");
    expect(models[0]?.variants).toEqual([]);
    expect(models[0]?.variantsObservable).toBeUndefined();
  });
});

describe("parseModelVerbose", () => {
  it("extracts models with names and reported variants", () => {
    const models = parseModelVerbose(VERBOSE_MODELS_OUTPUT);

    expect(models.map((model) => model.id)).toEqual([
      "opencode-go/deepseek-v4-pro",
      "openai/gpt-5.6-terra",
    ]);
    expect(models[0]).toMatchObject({
      id: "opencode-go/deepseek-v4-pro",
      providerID: "opencode-go",
      modelID: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      variants: ["low", "high"],
    });
    expect(models[1]?.variants).toEqual(["xhigh", "high"]);
  });

  it("reports no variants for an empty variants object", () => {
    const models = parseModelVerbose([
      "openai/gpt-5.6-terra",
      "{",
      '  "id": "gpt-5.6-terra",',
      '  "providerID": "openai",',
      '  "name": "GPT 5.6 Terra",',
      '  "variants": {}',
      "}",
    ].join("\n"));

    expect(models).toHaveLength(1);
    expect(models[0]?.variants).toEqual([]);
    expect(models[0]?.variantsObservable).toBe(true);
  });

  it("marks variant metadata observable for a reported variants object", () => {
    const models = parseModelVerbose(VERBOSE_MODELS_OUTPUT);
    expect(models[0]?.variantsObservable).toBe(true);
  });

  it("marks variant metadata not observable when the verbose block omits variants", () => {
    const models = parseModelVerbose([
      "openai/gpt-5.6-terra",
      "{",
      '  "id": "gpt-5.6-terra",',
      '  "providerID": "openai",',
      '  "name": "GPT 5.6 Terra"',
      "}",
    ].join("\n"));

    expect(models).toHaveLength(1);
    expect(models[0]?.variantsObservable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverAvailableModels
// ---------------------------------------------------------------------------

describe("discoverAvailableModels", () => {
  it("merges opencode models with --verbose metadata", async () => {
    execMocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, args.includes("--verbose") ? VERBOSE_MODELS_OUTPUT : PLAIN_MODELS_OUTPUT, "");
      },
    );

    const discovered = await discoverAvailableModels("/tmp/example-worktree");

    expect(discovered.models.map((model) => model.id)).toEqual([
      "opencode-go/deepseek-v4-pro",
      "openai/gpt-5.6-terra",
    ]);
    expect(discovered.models[0]?.variants).toEqual(["low", "high"]);
    expect(discovered.models[0]?.name).toBe("DeepSeek V4 Pro");
    expect(execMocks.execFile).toHaveBeenCalledTimes(2);
    expect(execMocks.execFile).toHaveBeenCalledWith(
      "opencode",
      ["models"],
      expect.objectContaining({ cwd: "/tmp/example-worktree" }),
      expect.any(Function),
    );
    expect(execMocks.execFile).toHaveBeenCalledWith(
      "opencode",
      ["models", "--verbose"],
      expect.objectContaining({ cwd: "/tmp/example-worktree" }),
      expect.any(Function),
    );
  });

  it("fails cleanly when the opencode CLI exits non-zero", async () => {
    execMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(Object.assign(new Error("opencode: command not found"), { code: "ENOENT" }));
      },
    );

    const error = await discoverAvailableModels("/tmp/worktree").then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ModelDiscoveryError);
    expect((error as Error).message).toContain("opencode models failed");
  });

  it("fails cleanly when opencode models lists nothing", async () => {
    execMocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, args.includes("--verbose") ? VERBOSE_MODELS_OUTPUT : "", "");
      },
    );

    await expect(discoverAvailableModels("/tmp/worktree")).rejects.toThrow(
      /no usable models/,
    );
  });
});

// ---------------------------------------------------------------------------
// configureModels
// ---------------------------------------------------------------------------

describe("configureModels", () => {
  it("shows the four-layer precedence for all ten roles and the simplified menu", async () => {
    await makeHome(); // isolate from the real user global config
    const worktree = await makeWorktree();
    const { input } = scriptedInput([""]); // Enter at the top menu keeps current
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("unchanged");
    expect(result.message).toContain("Keeping current configuration");

    const text = lines.join("\n");
    expect(text).toContain(
      "What would you like to do?\n\n  1) Exit without changes\n  2) Configure roles",
    );
    for (const role of ROLES) {
      expect(text).toContain(`  ${role}\n    default:`);
    }
    expect((text.match(/\n {4}default: {3}/g) ?? []).length).toBe(10);
    expect((text.match(/\n {4}global: {4}/g) ?? []).length).toBe(10);
    expect((text.match(/\n {4}project: {3}/g) ?? []).length).toBe(10);
    expect((text.match(/\n {4}resolved: {2}/g) ?? []).length).toBe(10);
    // researcher appears between reviewer and archivist with its packaged
    // sol/medium default (absent global/project layers render as dashes).
    expect(text).toContain(
      "  researcher\n    default:   openai/gpt-5.6-sol (medium)\n    global:    -\n    project:   -\n    resolved:  \x1b[1mopenai/gpt-5.6-sol (medium)\x1b[0m [not listed by OpenCode]",
    );
    // Absent layers render as plain hyphens; coder resolves to its ARIA
    // default, whose value is bolded in TTY output.
    expect(text).toContain(
      "  coder\n    default:   opencode-go/deepseek-v4-pro\n    global:    -\n    project:   -\n    resolved:  \x1b[1mopencode-go/deepseek-v4-pro\x1b[0m",
    );
    // Resolved models the CLI did not list are flagged; listed ones are not
    // labeled available/unavailable.
    expect(text).toContain(
      "resolved:  \x1b[1mopencode-go/deepseek-v4-flash (high)\x1b[0m [not listed by OpenCode]",
    );
    expect(text).toContain("resolved:  \x1b[1mopenai/gpt-5.6-terra (xhigh)\x1b[0m\n");
    expect(text).not.toContain("[available]");
    expect(text).not.toContain("[unavailable]");
  });

  it("shows global and project layers when overrides exist", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "opencode-go/deepseek-v4-flash" } });
    await writeFile(resolve(worktree, "aria.json"), `${JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.6-luna", variant: "xhigh" } },
    })}\n`);
    const { input } = scriptedInput([""]);
    const { output, lines } = collectOutput();

    await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(lines.join("\n")).toContain(
      "  planner\n"
      + "    default:   openai/gpt-5.6-terra (xhigh)\n"
      + "    global:    opencode-go/deepseek-v4-flash\n"
      + "    project:   openai/gpt-5.6-luna (xhigh)\n"
      + "    resolved:  \x1b[1mopenai/gpt-5.6-luna (xhigh)\x1b[0m [not listed by OpenCode]",
    );
  });

  it("uses 'default' terminology throughout", async () => {
    await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput(["2", "planner", "openai/gpt-5.6-terra", "2"]); // variant "high" diverges
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    const forbidden = ["re", "commended"].join("");
    expect(lines.join("\n")).not.toContain(forbidden);
  });

  it("skips without discovery, prompts, or file creation when stdin is not a TTY", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput([]);
    const { output, lines } = collectOutput();
    const discovery = vi.fn(async (): Promise<ModelDiscovery> => {
      throw new Error("discovery must not run");
    });

    const result = await configureModels(worktree, { discovery, input, output, tty: false });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not a terminal");
    expect(discovery).not.toHaveBeenCalled();
    expect(lines.join("\n")).toBe("");
    expect(existsSync(resolve(globalConfigDir(home), "aria.json"))).toBe(false);
  });

  it("keeps current configuration for option 1 without writing", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini", variant: "high" },
    });
    const before = await readFile(configPath, "utf8");
    const { input } = scriptedInput(["1"]);

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output: collectOutput().output,
      tty: true,
    });

    expect(result.status).toBe("unchanged");
    expect(result.message).toContain("Keeping current configuration");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("accepts an exact model ID and selects a variant", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput(["2", "planner", "openai/gpt-5.6-terra", "2"]); // exact ID → variant "high"
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["planner"]);
    const text = lines.join("\n");
    expect(text).toContain(
      "Model:\n  Enter      keep current\n  0          use ARIA default\n  <text>     search OpenCode models",
    );
    expect(text).toContain("Variant:\n  Enter   no variant override\n  1) xhigh\n  2) high");
    expect(await readWrittenRoles(home)).toEqual({
      planner: { model: "openai/gpt-5.6-terra", variant: "high" },
    });
  });

  it("configures researcher and clears the inherited variant on a model-only change", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // deepseek-v4-pro reports no variants, so choosing it clears the
    // researcher default's inherited medium variant.
    const { input } = scriptedInput(["2", "researcher", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["researcher"]);
    expect(lines.join("\n")).toContain("Roles available: coder, explorer, visualizer, planner, architect, implementer, reviewer, researcher, archivist, writer");
    expect(await readWrittenRoles(home)).toEqual({
      researcher: { model: "opencode-go/deepseek-v4-pro" },
    });

    // Model-only override clears the inherited variant as existing behavior
    // requires; other roles keep their packaged defaults.
    const resolved = resolveAriaConfig(worktree);
    expect(resolved.roles.researcher.model).toBe("opencode-go/deepseek-v4-pro");
    expect(resolved.roles.researcher.variant).toBeUndefined();
    expect(resolved.roles.writer.variant).toBe("medium");
  });

  it("shows numbered choices for a substring search and honors no-variant", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // Seed a diverging planner override so the edit is a real change.
    await writeGlobalConfig(home, { planner: { model: "opencode-go/deepseek-v4-flash" } });
    // "gpt-5.6" matches terra and luna; pick terra, then Enter keeps no variant.
    const { input } = scriptedInput(["2", "planner", "gpt-5.6", "1", ""]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => WITH_LUNA_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    const text = lines.join("\n");
    expect(text).toContain("[1] openai/gpt-5.6-terra");
    expect(text).toContain("[2] openai/gpt-5.6-luna");
    expect(text).toContain("Variant:\n  Enter   no variant override\n  1) xhigh\n  2) high");
    expect(await readWrittenRoles(home)).toEqual({
      planner: { model: "openai/gpt-5.6-terra" },
    });
  });

  it("asks to refine a search with more than ten matches", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // "model" matches all twelve; "model-0" narrows to the nine 01..09 models.
    const { input } = scriptedInput(["2", "planner", "model", "model-0", "1"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => makeManyModels(12),
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    const text = lines.join("\n");
    expect(text).toContain("12 matches — please refine your search.");
    expect(text).toContain("[1] bench/model-01");
    expect(await readWrittenRoles(home)).toEqual({
      planner: { model: "bench/model-01" },
    });
  });

  it("re-prompts on a search with no matches", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput(["2", "planner", "zzz", "openai/gpt-5.6-luna"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => WITH_LUNA_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(lines.join("\n")).toContain("No matches. Please try again.");
    expect(await readWrittenRoles(home)).toEqual({
      planner: { model: "openai/gpt-5.6-luna" },
    });
  });

  it("keeps the current assignment when the model prompt is left empty", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini", variant: "high" },
    });
    const before = await readFile(configPath, "utf8");
    const { input } = scriptedInput(["2", "planner", ""]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("unchanged");
    expect(lines.join("\n")).not.toContain("Variant:");
    // The single-role view renders the absent project layer as a plain hyphen.
    expect(lines.join("\n")).toContain(
      "  planner\n"
      + "    default:   openai/gpt-5.6-terra (xhigh)\n"
      + "    global:    openai/gpt-5.4-mini (high)\n"
      + "    project:   -\n"
      + "    resolved:  \x1b[1mopenai/gpt-5.4-mini (high)\x1b[0m [not listed by OpenCode]",
    );
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("removes the global override for 0 (use ARIA default)", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini", variant: "xhigh" },
    });
    const { input } = scriptedInput(["2", "planner", "0"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["planner"]);
    expect(lines.join("\n")).not.toContain("Variant:");
    const written = JSON.parse(await readFile(configPath, "utf8")) as { roles?: Record<string, unknown> };
    expect(written.roles?.planner).toBeUndefined();
  });

  it("replaces a role model and removes a stale variant on an explicit edit", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.6-terra", variant: "low" }, // stale variant
    });
    const { input } = scriptedInput(["2", "planner", "openai/gpt-5.6-terra", "2"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["planner"]);

    const text = await readFile(configPath, "utf8");
    const written = JSON.parse(text) as { roles?: Record<string, unknown> };
    expect(written.roles?.planner).toEqual({
      model: "openai/gpt-5.6-terra",
      variant: "high",
    });
    expect(text).not.toContain("low");
  });

  it("preserves untouched global roles while editing one role", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
      architect: { model: "openai/gpt-5.6-sol", variant: "low" },
      reviewer: { model: "opencode-go/custom-reviewer" },
    });
    const { input } = scriptedInput(["2", "reviewer", "opencode-go/deepseek-v4-pro"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["reviewer"]);

    const written = JSON.parse(await readFile(configPath, "utf8")) as { roles?: Record<string, unknown> };
    expect(written.roles?.planner).toEqual({ model: "openai/gpt-5.6-terra", variant: "xhigh" });
    expect(written.roles?.architect).toEqual({ model: "openai/gpt-5.6-sol", variant: "low" });
    expect(written.roles?.reviewer).toEqual({ model: "opencode-go/deepseek-v4-pro" });
  });

  it("seeds from legacy-global choices when the canonical file is absent", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const legacyPath = await writeGlobalConfig(
      home,
      {
        coder: { model: "opencode-go/legacy-coder" },
        reviewer: { model: "opencode-go/legacy-reviewer" },
      },
      "review-driven-code.json",
    );
    const legacyBefore = await readFile(legacyPath, "utf8");
    const canonicalPath = resolve(globalConfigDir(home), "aria.json");
    expect(existsSync(canonicalPath)).toBe(false);

    const { input } = scriptedInput(["2", "reviewer", "opencode-go/deepseek-v4-pro"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["reviewer"]);
    expect(result.wrotePath).toBe(canonicalPath);

    const written = JSON.parse(await readFile(canonicalPath, "utf8")) as { roles?: Record<string, unknown> };
    expect(written.roles?.coder).toEqual({ model: "opencode-go/legacy-coder" }); // seeded
    expect(written.roles?.reviewer).toEqual({ model: "opencode-go/deepseek-v4-pro" }); // edited
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBefore); // legacy left untouched
  });

  it("reports project overrides masking a global edit and never writes project files", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    const projectPath = resolve(worktree, "aria.json");
    await writeFile(projectPath, `${JSON.stringify({
      roles: { planner: { model: "openai/project-planner" } },
    })}\n`);
    const projectBefore = await readFile(projectPath, "utf8");

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.maskedRoles).toEqual(["planner"]);
    expect(lines.join("\n")).toContain(
      "WARNING: Project-local aria.json pins the model field for planner",
    );
    expect(lines.join("\n")).toContain("aria routes");
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
  });

  it("reports only the masked field when a project override pins just the variant", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini", variant: "xhigh" } });
    const projectPath = resolve(worktree, "aria.json");
    await writeFile(projectPath, `${JSON.stringify({
      roles: { planner: { variant: "high" } },
    })}\n`);
    const projectBefore = await readFile(projectPath, "utf8");

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    // The global model edit takes effect; only the project-pinned variant is
    // reported as unchangeable.
    expect(result.status).toBe("configured");
    expect(result.maskedRoles).toEqual(["planner"]);
    const text = lines.join("\n");
    expect(text).toContain("WARNING: Project-local aria.json pins the variant field for planner");
    expect(text).not.toContain("resolved routes");
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
  });

  it("reports masking when a project override equals the current global value", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    const projectPath = resolve(worktree, "aria.json");
    await writeFile(projectPath, `${JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.4-mini" } }, // same value as the global
    })}\n`);
    const projectBefore = await readFile(projectPath, "utf8");

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    // The edit is written, but the project still pins planner, so the
    // masking warning fires even though the override value equals the old
    // global value.
    expect(result.status).toBe("configured");
    expect(result.maskedRoles).toEqual(["planner"]);
    expect(lines.join("\n")).toContain(
      "WARNING: Project-local aria.json pins the model field for planner",
    );
    expect(lines.join("\n")).toContain("aria routes");
    expect(lines.join("\n")).toContain(
      "  planner\n"
      + "    default:   openai/gpt-5.6-terra (xhigh)\n"
      + "    global:    openai/gpt-5.4-mini\n"
      + "    project:   openai/gpt-5.4-mini\n"
      + "    resolved:  \x1b[1mopenai/gpt-5.4-mini\x1b[0m [not listed by OpenCode]",
    );
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
  });

  it("leaves an existing configuration untouched when the seam discovery fails", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini" },
    });
    const before = await readFile(configPath, "utf8");
    const { input, calls } = scriptedInput([]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => {
        throw new Error("server down");
      },
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("server down");
    expect(result.message).toContain("left untouched");
    expect(calls.length).toBe(0); // no prompt was ever asked
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("leaves an existing configuration untouched when the opencode CLI discovery fails", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini" },
    });
    const before = await readFile(configPath, "utf8");
    execMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(Object.assign(new Error("opencode: command not found"), { code: "ENOENT" }));
      },
    );
    const { input, calls } = scriptedInput([]);
    const { output } = collectOutput();

    // Real discovery (no seam): shells out to the mocked CLI, which fails.
    const result = await configureModels(worktree, { input, output, tty: true });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("opencode: command not found");
    expect(result.message).toContain("left untouched");
    expect(calls.length).toBe(0); // no prompt was ever asked
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("reports a write failure without creating or mutating configuration", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // `~/.config/opencode` exists as a file, so the atomic write cannot happen.
    await mkdir(resolve(home, ".config"), { recursive: true });
    await writeFile(globalConfigDir(home), "not a directory");

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("failed to write");
    expect(result.message).toContain("no changes were persisted");

    const configEntries = await readdir(resolve(home, ".config"));
    expect(configEntries).toEqual(["opencode"]); // no new files were created
  });

  it("persists a model-only planner override and resolves it with no variant on the next read", async () => {
    const home = await makeHome(); // no global aria.json
    const worktree = await makeWorktree(); // no project aria.json
    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.changedRoles).toEqual(["planner"]);

    // Persisted global override is model-only: no variant field is written.
    const configPath = resolve(globalConfigDir(home), "aria.json");
    const written = JSON.parse(await readFile(configPath, "utf8")) as { roles?: Record<string, unknown> };
    expect(written.roles?.planner).toEqual({ model: "opencode-go/deepseek-v4-pro" });

    // End-to-end round-trip: resolving the same worktree sees the model
    // override and no variant for planner.
    const resolved = resolveAriaConfig(worktree);
    expect(resolved.roles.planner.model).toBe("opencode-go/deepseek-v4-pro");
    expect(resolved.roles.planner.variant).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Presentation (T001-T007): separators, bold resolved values, red warnings,
  // ANSI/NO_COLOR behavior, and wording.
  // -------------------------------------------------------------------------

  it("separates overview role blocks with 60-hyphen rules, but not the single-role view", async () => {
    await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput(["2", "planner", ""]); // reach the single-role view, keep current
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("unchanged");
    const text = lines.join("\n");
    const rule = `  ${"-".repeat(60)}`;
    expect(text.split("\n").filter((line) => line === rule)).toHaveLength(9); // between the ten roles
    expect(text).toContain(`${rule}\n  explorer`); // after coder's block
    expect(text).not.toContain(`${rule}\n\nWhat would you like to do?`); // never after writer
    // The single-role configuration view starts after the roles prompt line.
    const singleRoleView = text.slice(text.indexOf("Roles available:"));
    expect(singleRoleView).toContain("  planner\n    default:");
    expect(singleRoleView).not.toContain(rule);
  });

  it("bolds only the resolved route value in TTY output", async () => {
    await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput([""]);
    const { output, lines } = collectOutput();

    await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    const text = lines.join("\n");
    expect(text).toContain("resolved:  \x1b[1mopencode-go/deepseek-v4-pro\x1b[0m");
    // Exactly one bold segment per role (the resolved value); labels and other
    // layers stay unbolded, and no warnings render here.
    expect(text.split("\x1b[1m").length - 1).toBe(10);
    expect(text.split("\x1b[31m").length - 1).toBe(0);
  });

  it("renders project-mask warnings in red in TTY output and keeps results ANSI-free", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    await writeFile(resolve(worktree, "aria.json"), `${JSON.stringify({
      roles: { planner: { model: "openai/project-planner" } },
    })}\n`);

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.maskedRoles).toEqual(["planner"]);
    const text = lines.join("\n");
    // Pre-prompt and post-write warnings are both red.
    expect(text).toContain(
      "\x1b[31mWARNING: Project-local aria.json pins the model field for planner",
    );
    expect(text.split("\x1b[31m").length - 1).toBe(2);
    // Styling never leaks into the result object.
    expect(JSON.stringify(result)).not.toContain("\x1b[");
  });

  it("warns that a fully masked role's resolved route is unaffected", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    await writeFile(resolve(worktree, "aria.json"), `${JSON.stringify({
      roles: { planner: { model: "openai/project-planner", variant: "high" } },
    })}\n`);

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(lines.join("\n")).toContain(
      "WARNING: Project-local aria.json overrides planner, so this global change does not "
      + "affect its currently resolved route. Run `aria routes` for the authoritative result.",
    );
  });

  it("emits plain text without ANSI escapes when NO_COLOR is set", async () => {
    process.env.NO_COLOR = "1";
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    await writeFile(resolve(worktree, "aria.json"), `${JSON.stringify({
      roles: { planner: { model: "openai/project-planner" } },
    })}\n`);

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    const text = lines.join("\n");
    expect(text).not.toContain("\x1b[");
    // Content is still present, just unstyled.
    expect(text).toContain("WARNING: Project-local aria.json pins the model field for planner");
    expect(text).toContain("resolved:  opencode-go/deepseek-v4-pro");
  });

  it("emits plain text without ANSI escapes when NO_COLOR is an empty string", async () => {
    process.env.NO_COLOR = "";
    const home = await makeHome();
    const worktree = await makeWorktree();
    await writeGlobalConfig(home, { planner: { model: "openai/gpt-5.4-mini" } });
    await writeFile(resolve(worktree, "aria.json"), `${JSON.stringify({
      roles: { planner: { model: "openai/project-planner" } },
    })}\n`);

    const { input } = scriptedInput(["2", "planner", "opencode-go/deepseek-v4-pro"]);
    const { output, lines } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    const text = lines.join("\n");
    expect(text).not.toContain("\x1b[");
    // Content is still present, just unstyled.
    expect(text).toContain("WARNING: Project-local aria.json pins the model field for planner");
    expect(text).toContain("resolved:  opencode-go/deepseek-v4-pro");
  });
});
