import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2/types";

import {
  configureModels,
  discoverAvailableModels,
  ModelDiscoveryError,
  normalizeAvailableModels,
  normalizeAvailableProviders,
  type ModelConfigureInput,
  type ModelConfigureOutput,
  type ModelDiscovery,
} from "../src/model-config.js";
import { resolveAriaConfig } from "../src/overrides.js";

// ---------------------------------------------------------------------------
// SDK seam mocks (only the discoverAvailableModels tests exercise them)
// ---------------------------------------------------------------------------

const sdkMocks = vi.hoisted(() => ({
  createOpencodeServer: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeServer: sdkMocks.createOpencodeServer,
}));

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: sdkMocks.createOpencodeClient,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  vi.clearAllMocks();
  sdkMocks.createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4321", close: () => undefined });
  sdkMocks.createOpencodeClient.mockReturnValue({
    v2: {
      model: { list: async () => ({ data: { data: [] }, error: undefined }) },
      provider: { list: async () => ({ data: { data: [] }, error: undefined }) },
    },
  });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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
  "archivist",
  "writer",
] as const;

/** ModelV2Info fixture; variant entries may carry a defensive `disabled` flag. */
function makeModelInfo(
  overrides: Omit<Partial<ModelV2Info>, "variants"> & {
    variants?: Array<{ id: string; disabled?: boolean }>;
  },
): ModelV2Info {
  return {
    id: "deepseek-v4-pro",
    providerID: "opencode-go",
    name: "DeepSeek V4 Pro",
    api: { id: "ai-sdk", type: "aisdk", package: "ai-sdk" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128000, output: 32000 },
    ...overrides,
  } as ModelV2Info;
}

function makeProviderInfo(overrides: Partial<ProviderV2Info>): ProviderV2Info {
  return {
    id: "opencode-go",
    name: "OpenCode Go",
    api: { type: "openai-compatible", url: "http://localhost" },
    request: {},
    ...overrides,
  } as ProviderV2Info;
}

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
  providers: [],
};

// ---------------------------------------------------------------------------
// normalizeAvailableModels / normalizeAvailableProviders
// ---------------------------------------------------------------------------

describe("normalizeAvailableModels", () => {
  it("retains enabled models with active providers and normalizes identifiers", () => {
    const providers = [
      makeProviderInfo({ id: "opencode-go" }),
      makeProviderInfo({ id: "openai", disabled: true }),
      makeProviderInfo({ id: "other", name: "Other" }),
    ];
    const models = [
      makeModelInfo({ providerID: "opencode-go", id: "deepseek-v4-pro" }),
      // Model already reports the provider prefix — must not be double-prefixed.
      makeModelInfo({ providerID: "opencode-go", id: "opencode-go/deepseek-v4-flash" }),
      // Enabled model whose provider is disabled — not offered.
      makeModelInfo({ providerID: "openai", id: "gpt-5.6-terra" }),
      // Disabled model — not offered.
      makeModelInfo({ providerID: "opencode-go", id: "disabled-model", enabled: false }),
      // Model from a provider missing from the provider list — not offered.
      makeModelInfo({ providerID: "ghost", id: "ghost-model" }),
    ];

    const normalized = normalizeAvailableModels(models, providers);

    expect(normalized.map((model) => model.id)).toEqual([
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash",
    ]);
    expect(normalized[1]?.modelID).toBe("deepseek-v4-flash");
  });

  it("exposes only enabled, non-empty reported variants", () => {
    const providers = [makeProviderInfo({})];
    const models = [
      makeModelInfo({
        variants: [
          { id: "xhigh" },
          { id: "low", disabled: true },
          { id: "   " },
        ],
      }),
    ];

    const normalized = normalizeAvailableModels(models, providers);
    expect(normalized[0]?.variants).toEqual(["xhigh"]);
  });
});

describe("normalizeAvailableProviders", () => {
  it("retains only active providers", () => {
    const providers = [
      makeProviderInfo({ id: "opencode-go" }),
      makeProviderInfo({ id: "disabled-provider", disabled: true }),
    ];

    expect(normalizeAvailableProviders(providers).map((provider) => provider.id)).toEqual([
      "opencode-go",
    ]);
  });
});

// ---------------------------------------------------------------------------
// discoverAvailableModels
// ---------------------------------------------------------------------------

describe("discoverAvailableModels", () => {
  it("discovers models and providers, then closes the ephemeral server", async () => {
    const close = vi.fn();
    sdkMocks.createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4321", close });
    sdkMocks.createOpencodeClient.mockReturnValue({
      v2: {
        model: {
          list: vi.fn(async () => ({
            data: { data: [makeModelInfo({ variants: [{ id: "high" }] })] },
            error: undefined,
          })),
        },
        provider: {
          list: vi.fn(async () => ({
            data: { data: [makeProviderInfo({})] },
            error: undefined,
          })),
        },
      },
    });

    const worktree = "/tmp/example-worktree";
    const discovered = await discoverAvailableModels(worktree);

    expect(discovered).toEqual({
      models: [
        {
          id: "opencode-go/deepseek-v4-pro",
          providerID: "opencode-go",
          modelID: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          variants: ["high"],
        },
      ],
      providers: [{ id: "opencode-go", name: "OpenCode Go" }],
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(sdkMocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4321",
      directory: worktree,
    });
  });

  it("fails discovery on a V2 endpoint response error, closing the server", async () => {
    const close = vi.fn();
    sdkMocks.createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4321", close });
    sdkMocks.createOpencodeClient.mockReturnValue({
      v2: {
        model: {
          list: async () => ({ data: undefined, error: { message: "service unavailable" } }),
        },
        provider: { list: async () => ({ data: { data: [] }, error: undefined }) },
      },
    });

    const error = await discoverAvailableModels("/tmp/worktree").then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ModelDiscoveryError);
    expect((error as Error).message).toContain("model discovery failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the OpenCode server fails to start", async () => {
    sdkMocks.createOpencodeServer.mockRejectedValue(new Error("spawn failed"));

    await expect(discoverAvailableModels("/tmp/worktree")).rejects.toThrow(
      /OpenCode server failed to start/,
    );
  });
});

// ---------------------------------------------------------------------------
// configureModels
// ---------------------------------------------------------------------------

describe("configureModels", () => {
  it("shows all nine roles with current and recommended availability diagnostics", async () => {
    await makeHome(); // isolate from the real user global config
    const worktree = await makeWorktree();
    const { input } = scriptedInput([""]); // cancel at the top choice
    const { output, lines } = collectOutput();

    const discovery = vi.fn(async () => ({
      models: [DISCOVERED_MODELS.models[0]!],
      providers: [],
    }));

    const result = await configureModels(worktree, { discovery, input, output, tty: true });
    expect(result.status).toBe("unchanged");

    const text = lines.join("\n");
    for (const role of ROLES) {
      expect(text).toContain(`  ${role.padEnd(11)} current:`);
    }
    expect((text.match(/current:/g) ?? []).length).toBe(9);
    expect((text.match(/recommended:/g) ?? []).length).toBe(9);
    // Discovered model → available; undiscovered recommended route → unavailable.
    expect(text).toMatch(/coder\s+current:\s+opencode-go\/deepseek-v4-pro \[available\]/);
    expect(text).toMatch(/planner\s+current:\s+openai\/gpt-5\.6-terra \(xhigh\) \[unavailable\]/);
    expect(text).toContain("recommended: openai/gpt-5.6-terra (xhigh) [unavailable]");
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

  it("keeps recommended defaults without writing when nothing diverges", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const { input } = scriptedInput(["1"]);
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("unchanged");
    expect(result.message).toContain("recommended defaults");
    expect(existsSync(resolve(globalConfigDir(home), "aria.json"))).toBe(false);
  });

  it("distinguishes keep-current (no writes) from keep-recommended-default (removes diverging overrides)", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini", variant: "high" },
    });
    const before = await readFile(configPath, "utf8");
    const options = {
      discovery: async () => DISCOVERED_MODELS,
      tty: true as const,
    };

    // Keep current assignments: nothing is written.
    const keepCurrent = await configureModels(worktree, {
      ...options,
      input: scriptedInput(["2"]).input,
      output: collectOutput().output,
    });
    expect(keepCurrent.status).toBe("unchanged");
    expect(keepCurrent.message).toContain("Keeping current assignments");
    expect(await readFile(configPath, "utf8")).toBe(before);

    // Keep recommended defaults: the diverging planner override is removed.
    const keepRecommended = await configureModels(worktree, {
      ...options,
      input: scriptedInput(["1"]).input,
      output: collectOutput().output,
    });
    expect(keepRecommended.status).toBe("configured");
    expect(keepRecommended.changedRoles).toEqual(["planner"]);

    const written = JSON.parse(await readFile(configPath, "utf8")) as { roles?: Record<string, unknown> };
    expect(written.roles?.planner).toBeUndefined();
  });

  it("replaces a role model and removes a stale variant on an explicit edit", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.6-terra", variant: "low" }, // stale variant
    });
    const { input } = scriptedInput(["3", "planner", "2", "2"]); // configure → planner → terra → high
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

  it("removes a role for recommended-default without writing sentinels", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.4-mini", variant: "xhigh" },
    });
    const { input } = scriptedInput(["3", "planner", "0"]); // configure → planner → recommended default
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
    expect(written.roles?.planner).toBeUndefined();
    expect(text).not.toContain("null");
  });

  it("preserves untouched global roles while editing one role", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    const configPath = await writeGlobalConfig(home, {
      planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
      architect: { model: "openai/gpt-5.6-sol", variant: "low" },
      reviewer: { model: "opencode-go/custom-reviewer" },
    });
    const { input } = scriptedInput(["3", "reviewer", "1"]); // reviewer → deepseek-v4-pro
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

    const { input } = scriptedInput(["3", "reviewer", "1"]); // reviewer → deepseek-v4-pro
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

    const { input } = scriptedInput(["3", "planner", "1"]); // planner → deepseek-v4-pro
    const { output } = collectOutput();

    const result = await configureModels(worktree, {
      discovery: async () => DISCOVERED_MODELS,
      input,
      output,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.maskedRoles).toEqual(["planner"]);
    expect(result.message).toContain("project-local aria.json pins the model field for planner");
    expect(result.message).toContain("aria routes");
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

    const { input } = scriptedInput(["3", "planner", "1"]); // planner → deepseek-v4-pro
    const { output } = collectOutput();

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
    expect(result.message).toContain("project-local aria.json pins the variant field for planner");
    expect(result.message).not.toContain("resolved routes");
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

    const { input } = scriptedInput(["3", "planner", "1"]); // planner → deepseek-v4-pro
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
    expect(result.message).toContain("project-local aria.json pins the model field for planner");
    expect(result.message).toContain("aria routes");
    expect(lines.join("\n")).toMatch(/planner\s+current:.*\[project override\]/);
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
  });

  it("leaves an existing configuration untouched when discovery fails", async () => {
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

  it("reports a write failure without creating or mutating configuration", async () => {
    const home = await makeHome();
    const worktree = await makeWorktree();
    // `~/.config/opencode` exists as a file, so the atomic write cannot happen.
    await mkdir(resolve(home, ".config"), { recursive: true });
    await writeFile(globalConfigDir(home), "not a directory");

    const { input } = scriptedInput(["3", "planner", "1"]); // planner → deepseek-v4-pro
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
    const { input } = scriptedInput(["3", "planner", "1"]); // planner → deepseek-v4-pro (no variants)
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
});
