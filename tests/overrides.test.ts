import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ConfigValidationError, parseOverrides, resolveReviewDrivenCodeConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("review-driven-code overrides", () => {
  describe("parseOverrides", () => {
    it("accepts model-only role override", () => {
      expect(parseOverrides({
        roles: { planner: { model: "openai/gpt-5.6-terra" } },
      })).toEqual({
        roles: { planner: { model: "openai/gpt-5.6-terra" } },
      });
    });

    it("accepts variant-only role override", () => {
      expect(parseOverrides({
        roles: { planner: { variant: "xhigh" } },
      })).toEqual({
        roles: { planner: { variant: "xhigh" } },
      });
    });

    it("accepts model + variant override", () => {
      expect(parseOverrides({
        roles: {
          planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
          architect: { model: "openai/gpt-5.6-sol" },
        },
      })).toEqual({
        roles: {
          planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
          architect: { model: "openai/gpt-5.6-sol" },
        },
      });
    });

    it("accepts empty object {} as no overrides", () => {
      expect(parseOverrides({})).toEqual({});
    });

    it("accepts { roles: {} } as no overrides", () => {
      expect(parseOverrides({ roles: {} })).toEqual({ roles: {} });
    });

    it("accepts { roles: { planner: {} } } inheriting planner defaults", () => {
      expect(parseOverrides({ roles: { planner: {} } })).toEqual({ roles: { planner: {} } });
    });

    it("rejects old { models: ... } format", () => {
      expect(() => parseOverrides({ models: { planner: "openai/gpt-5.6-terra" } }))
        .toThrow(ConfigValidationError);
    });

    it("rejects old { variants: ... } format", () => {
      expect(() => parseOverrides({ variants: { planner: "xhigh" } }))
        .toThrow(ConfigValidationError);
    });

    it("rejects unknown top-level field", () => {
      expect(() => parseOverrides({ roles: {}, transitions: {} }))
        .toThrow(ConfigValidationError);
    });

    it("rejects unknown role name", () => {
      expect(() => parseOverrides({ roles: { tester: {} } }))
        .toThrow(/valid role/);
    });

    it("rejects non-object role value", () => {
      expect(() => parseOverrides({ roles: { planner: "high" } }))
        .toThrow(/object/);
    });

    it("rejects unknown role-level field", () => {
      expect(() => parseOverrides({ roles: { planner: { mode: "primary" } } }))
        .toThrow(/'model' or 'variant'/);
    });

    it("rejects empty model string", () => {
      expect(() => parseOverrides({ roles: { planner: { model: "" } } }))
        .toThrow(/model identifier/);
    });

    it("rejects malformed model identifier", () => {
      expect(() => parseOverrides({ roles: { planner: { model: "gpt-5" } } }))
        .toThrow(/provider\/model/);
    });

    it("rejects empty variant string", () => {
      expect(() => parseOverrides({ roles: { planner: { variant: "" } } }))
        .toThrow(/non-empty string/);
    });

    it("rejects non-string variant", () => {
      expect(() => parseOverrides({ roles: { planner: { variant: 42 } } }))
        .toThrow(/non-empty string/);
    });

    it("rejects non-object root", () => {
      expect(() => parseOverrides("bad")).toThrow(ConfigValidationError);
    });

    it("rejects array root", () => {
      expect(() => parseOverrides([1])).toThrow(ConfigValidationError);
    });

    it("rejects roles as non-object", () => {
      expect(() => parseOverrides({ roles: "bad" })).toThrow(/object/);
    });
  });

  describe("resolveReviewDrivenCodeConfig", () => {
    it("inherits all defaults with empty override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), "{}");
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
      expect(config.roles.reviewer.model).toBe("opencode-go/deepseek-v4-pro");
    });

    it("inherits defaults with { roles: {} }", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({ roles: {} }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
    });

    it("overrides model only, inherits variant from defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/gpt-5.4-mini" } },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("overrides variant only, inherits model from defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { variant: "high" } },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("high");
    });

    it("overrides model + variant", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: {
          planner: { model: "openai/gpt-5.4-mini", variant: "high" },
          architect: { model: "openai/gpt-5.6-sol" },
        },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
      expect(config.roles.planner.variant).toBe("high");
      expect(config.roles.architect.model).toBe("openai/gpt-5.6-sol");
      expect(config.roles.architect.variant).toBe("xhigh");
    });

    it("empty role override inherits defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: {} },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("auto-discovers review-driven-code.json", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { reviewer: { model: "opencode-go/custom-reviewer" } },
      }));
      expect(resolveReviewDrivenCodeConfig(root).roles.reviewer.model).toBe("opencode-go/custom-reviewer");
    });

    it("injects resolved routing into director prompt", () => {
      const config = resolveReviewDrivenCodeConfig(tmpdir());
      expect(config.roles.director.promptText).toContain("Configured routes:");
      expect(config.roles.director.promptText).toContain("director: `director` → opencode-go/deepseek-v4-pro");
      expect(config.roles.director.promptText).toContain("explorer: `explorer` → opencode-go/deepseek-v4-flash [high]");
      expect(config.roles.director.promptText).toContain("planner: `planner` → openai/gpt-5.6-terra [xhigh]");
      expect(config.roles.director.promptText).toContain("architect: `architect` → openai/gpt-5.6-sol [xhigh]");
      expect(config.roles.director.promptText).toContain("implementer: `implementer` → opencode-go/glm-5.2");
      expect(config.roles.director.promptText).toContain("reviewer: `reviewer` → opencode-go/deepseek-v4-pro");
      expect(config.roles.director.promptText).toContain("visualizer: `visualizer` → opencode-go/kimi-k2.7-code");
      expect(config.roles.director.promptText).toContain("wiki-compiler: `wiki-compiler` → opencode-go/deepseek-v4-pro");
    });

    it("routing reflects project model override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/gpt-5.4-mini" } },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.director.promptText).toContain("planner: `planner` → openai/gpt-5.4-mini [xhigh]");
    });

    it("routing reflects project variant override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { explorer: { variant: "xhigh" } },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.director.promptText).toContain("explorer: `explorer` → opencode-go/deepseek-v4-flash [xhigh]");
    });

    it("roles without variants render cleanly without fake variant text", () => {
      const config = resolveReviewDrivenCodeConfig(tmpdir());
      expect(config.roles.director.promptText).toContain("director: `director` → opencode-go/deepseek-v4-pro\n");
      expect(config.roles.director.promptText).toContain("implementer: `implementer` → opencode-go/glm-5.2\n");
      expect(config.roles.director.promptText).toContain("reviewer: `reviewer` → opencode-go/deepseek-v4-pro\n");
      expect(config.roles.director.promptText).toContain("visualizer: `visualizer` → opencode-go/kimi-k2.7-code\n");
      expect(config.roles.director.promptText).toContain("wiki-compiler: `wiki-compiler` → opencode-go/deepseek-v4-pro\n");
    });

    it("wiki-compiler model and variant overrides resolve correctly", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { "wiki-compiler": { model: "openai/gpt-5.4-mini", variant: "high" } },
      }));
      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles["wiki-compiler"].model).toBe("openai/gpt-5.4-mini");
      expect(config.roles["wiki-compiler"].variant).toBe("high");
      expect(config.roles.director.promptText).toContain("wiki-compiler: `wiki-compiler` → openai/gpt-5.4-mini [high]");
    });

    it("wiki-compiler defaults resolve without WIKI_DIR env (missing env does not break startup)", () => {
      delete process.env.WIKI_DIR;
      const config = resolveReviewDrivenCodeConfig(tmpdir());
      expect(config.roles["wiki-compiler"].model).toBe("opencode-go/deepseek-v4-pro");
      expect(config.roles["wiki-compiler"].promptText).toBeDefined();
      expect(config.roles["wiki-compiler"].promptText.length).toBeGreaterThan(0);
      // Director prompt must never contain packageRoot or WIKI_DIR paths.
      expect(config.roles.director.promptText).not.toContain("{{packageRoot}}");
      expect(config.roles.director.promptText).not.toContain("{{WIKI_DIR}}");
    });

    it("wiki-compiler prompt receives resolved packageRoot and WIKI_DIR when set", () => {
      process.env.WIKI_DIR = "/home/user/wiki";
      const config = resolveReviewDrivenCodeConfig(tmpdir());
      delete process.env.WIKI_DIR;
      // Path placeholders resolved in wiki-compiler prompt only.
      expect(config.roles["wiki-compiler"].promptText).toContain("/home/user/wiki/wiki/");
      expect(config.roles["wiki-compiler"].promptText).toContain("/home/user/wiki/raw/");
      expect(config.roles["wiki-compiler"].promptText).not.toContain("{{WIKI_DIR}}");
      expect(config.roles["wiki-compiler"].promptText).not.toContain("{{packageRoot}}");
      // Other roles must never receive these paths.
      expect(config.roles.director.promptText).not.toContain("/home/user/wiki");
      expect(config.roles.planner.promptText).not.toContain("/home/user/wiki");
    });
  });

  describe("global config discovery", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
      originalHome = process.env.HOME;
    });

    afterEach(() => {
      process.env.HOME = originalHome;
    });

    it("survives missing global config (non-fatal)", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-no-global-"));
      tempDirs.push(root);
      process.env.HOME = root;
      const config = resolveReviewDrivenCodeConfig(resolve(root, "worktree"));
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("reads global override when no project config exists", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "review-driven-code-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-proj-"));
      tempDirs.push(root);

      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/global-model");
      expect(config.roles.planner.variant).toBe("xhigh"); // from default
    });

    it("project overrides global per-field", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "review-driven-code-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model", variant: "global-variant" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-proj-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { variant: "project-variant" } },
      }));

      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/global-model"); // from global
      expect(config.roles.planner.variant).toBe("project-variant"); // project wins
    });

    it("project model overrides global model", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "review-driven-code-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model", variant: "global-variant" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-proj-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/project-model" } },
      }));

      const config = resolveReviewDrivenCodeConfig(root);
      expect(config.roles.planner.model).toBe("openai/project-model"); // project wins
      expect(config.roles.planner.variant).toBe("global-variant"); // inherited from global
    });
  });

  describe("global diagnostics", () => {
    it("includes global path in error messages", () => {
      const globalPath = "/home/user/.config/opencode/review-driven-code.json";
      expect(() => parseOverrides({ models: {} }, globalPath))
        .toThrow(globalPath);
    });

    it("malformed global JSON includes global path in syntax error", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "review-driven-code-bad-json-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "review-driven-code.json"), "{bad json");

      const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-proj-"));
      tempDirs.push(root);

      const expectedPath = resolve(home, ".config", "opencode", "review-driven-code.json");
      expect(() => resolveReviewDrivenCodeConfig(root)).toThrow(expectedPath);
    });
  });
});
