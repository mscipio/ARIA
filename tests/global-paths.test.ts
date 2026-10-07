import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultAgentsDir } from "../src/agents.js";
import { discoverConfigPath, opencodeConfigPath } from "../src/deps.js";
import { configureModels, type ModelDiscovery } from "../src/model-config.js";
import { globalAriaConfigPath, readGlobalAriaOverrides, resolveAriaConfig } from "../src/overrides.js";
import { openCodeGlobalDir } from "../src/paths.js";
import { defaultGlobalConfigPath } from "../src/setup-config.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Isolated env: empty HOME plus XDG root; proves no production fallback. */
async function isolateXdg(): Promise<{ fakeHome: string; xdgRoot: string; xdgGlobal: string }> {
  const fakeHome = await mkdtemp(resolve(tmpdir(), "t002-home-"));
  const xdgRoot = await mkdtemp(resolve(tmpdir(), "t002-xdg-"));
  tempDirs.push(fakeHome, xdgRoot);
  process.env.HOME = fakeHome;
  process.env.XDG_CONFIG_HOME = xdgRoot;
  return { fakeHome, xdgRoot, xdgGlobal: join(xdgRoot, "opencode") };
}

// Model fixture with no variants on the chosen model, so no variant prompt
// runs and no inherited-variant behavior is exercised.
const NO_VARIANT_MODELS: ModelDiscovery = {
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

describe("T002 isolated XDG global paths", () => {
  it("deps helpers resolve under XDG and keep .json→.jsonc discovery with explicit winning", async () => {
    const { xdgGlobal } = await isolateXdg();
    await mkdir(xdgGlobal, { recursive: true });
    await writeFile(join(xdgGlobal, "opencode.jsonc"), "{}");

    // No explicit: XDG base, .jsonc discovered when .json absent.
    expect(opencodeConfigPath()).toBe(join(xdgGlobal, "opencode.json"));
    expect(discoverConfigPath()).toBe(join(xdgGlobal, "opencode.jsonc"));

    // .json preferred when both exist.
    await writeFile(join(xdgGlobal, "opencode.json"), "{}");
    expect(discoverConfigPath()).toBe(join(xdgGlobal, "opencode.json"));

    // Explicit base wins over XDG for both helpers.
    const explicit = await mkdtemp(resolve(tmpdir(), "t002-explicit-"));
    tempDirs.push(explicit);
    await writeFile(join(explicit, "opencode.jsonc"), "{}");
    expect(opencodeConfigPath(explicit)).toBe(join(explicit, "opencode.json"));
    expect(discoverConfigPath(explicit)).toBe(join(explicit, "opencode.jsonc"));
    expect(openCodeGlobalDir(explicit)).toBe(explicit);
  });

  it("agents dir and setup delegate resolve under XDG with explicit winning", async () => {
    const { xdgGlobal } = await isolateXdg();
    expect(defaultAgentsDir()).toBe(join(xdgGlobal, "agents"));
    expect(defaultGlobalConfigPath()).toBe(join(xdgGlobal, "opencode.json"));
    expect(defaultGlobalConfigPath()).toBe(opencodeConfigPath());

    const explicit = await mkdtemp(resolve(tmpdir(), "t002-explicit-"));
    tempDirs.push(explicit);
    expect(defaultAgentsDir(explicit)).toBe(join(explicit, "agents"));
    expect(defaultGlobalConfigPath(explicit)).toBe(join(explicit, "opencode.json"));
  });

  it("global override prefers canonical aria.json, falls back to legacy, isolated from HOME", async () => {
    const { fakeHome, xdgGlobal } = await isolateXdg();
    // HOME has no global config: proves XDG is used without production fallback.
    expect(existsSync(join(fakeHome, ".config", "opencode", "aria.json"))).toBe(false);

    // Neither XDG file exists.
    expect(globalAriaConfigPath()).toBeUndefined();
    expect(readGlobalAriaOverrides()).toEqual({});

    // Legacy fallback under XDG.
    await mkdir(xdgGlobal, { recursive: true });
    await writeFile(
      join(xdgGlobal, "review-driven-code.json"),
      JSON.stringify({ roles: { planner: { model: "openai/legacy-global-model" } } }),
    );
    expect(globalAriaConfigPath()).toBe(join(xdgGlobal, "review-driven-code.json"));
    expect(readGlobalAriaOverrides().roles?.planner?.model).toBe("openai/legacy-global-model");

    // Canonical wins when both exist (global write stays canonical-only).
    await writeFile(
      join(xdgGlobal, "aria.json"),
      JSON.stringify({ roles: { planner: { model: "openai/canonical-global-model" } } }),
    );
    expect(globalAriaConfigPath()).toBe(join(xdgGlobal, "aria.json"));
    expect(readGlobalAriaOverrides().roles?.planner?.model).toBe("openai/canonical-global-model");

    // Explicit base wins over XDG.
    const explicit = await mkdtemp(resolve(tmpdir(), "t002-explicit-"));
    tempDirs.push(explicit);
    await writeFile(
      join(explicit, "aria.json"),
      JSON.stringify({ roles: { planner: { model: "openai/explicit-model" } } }),
    );
    expect(globalAriaConfigPath(explicit)).toBe(join(explicit, "aria.json"));
    expect(readGlobalAriaOverrides(explicit).roles?.planner?.model).toBe("openai/explicit-model");
  });

  it("resolveAriaConfig reads the XDG global layer while project-local stays unchanged", async () => {
    const { xdgGlobal } = await isolateXdg();
    await mkdir(xdgGlobal, { recursive: true });
    await writeFile(
      join(xdgGlobal, "aria.json"),
      JSON.stringify({ roles: { planner: { model: "openai/global-model" } } }),
    );

    const worktree = await mkdtemp(resolve(tmpdir(), "t002-worktree-"));
    tempDirs.push(worktree);
    // Empty HOME + XDG global only: resolved planner comes from XDG.
    expect(resolveAriaConfig(worktree).roles.planner.model).toBe("openai/global-model");

    // Project-local override still wins over the XDG global layer.
    await writeFile(
      join(worktree, "aria.json"),
      JSON.stringify({ roles: { planner: { model: "openai/project-model" } } }),
    );
    expect(resolveAriaConfig(worktree).roles.planner.model).toBe("openai/project-model");
  });

  it("configureModels reads legacy and writes canonical under XDG without touching HOME", async () => {
    const { fakeHome, xdgGlobal } = await isolateXdg();
    await mkdir(xdgGlobal, { recursive: true });
    const legacyPath = join(xdgGlobal, "review-driven-code.json");
    await writeFile(
      legacyPath,
      `${JSON.stringify({ roles: { coder: { model: "opencode-go/legacy-coder" } } }, null, 2)}\n`,
    );
    const legacyBefore = await readFile(legacyPath, "utf8");
    const canonicalPath = join(xdgGlobal, "aria.json");
    expect(existsSync(canonicalPath)).toBe(false);

    const worktree = await mkdtemp(resolve(tmpdir(), "t002-worktree-"));
    tempDirs.push(worktree);
    const answers = ["2", "researcher", "opencode-go/deepseek-v4-pro"];
    let index = 0;
    const result = await configureModels(worktree, {
      discovery: async () => NO_VARIANT_MODELS,
      input: async () => answers[index++] ?? "",
      output: () => undefined,
      tty: true,
    });

    expect(result.status).toBe("configured");
    expect(result.wrotePath).toBe(canonicalPath);
    const written = JSON.parse(await readFile(canonicalPath, "utf8")) as {
      roles?: Record<string, unknown>;
    };
    // Legacy seed carried forward; edited role is model-only (no variant).
    expect(written.roles?.coder).toEqual({ model: "opencode-go/legacy-coder" });
    expect(written.roles?.researcher).toEqual({ model: "opencode-go/deepseek-v4-pro" });
    // Legacy file left untouched; nothing written under HOME.
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBefore);
    expect(existsSync(join(fakeHome, ".config", "opencode", "aria.json"))).toBe(false);
  });
});
