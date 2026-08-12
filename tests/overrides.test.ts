import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ConfigValidationError, parseOverrides, resolveAriaConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ARIA overrides", () => {
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

  describe("resolveAriaConfig", () => {
    it("inherits all defaults with empty override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), "{}");
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
      expect(config.roles.reviewer.model).toBe("opencode-go/deepseek-v4-pro");
    });

    it("inherits defaults with { roles: {} }", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({ roles: {} }));
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
    });

    it("overrides model only, inherits variant from defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/gpt-5.4-mini" } },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("overrides variant only, inherits model from defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: { variant: "high" } },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("high");
    });

    it("overrides model + variant", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: {
          planner: { model: "openai/gpt-5.4-mini", variant: "high" },
          architect: { model: "openai/gpt-5.6-sol" },
        },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
      expect(config.roles.planner.variant).toBe("high");
      expect(config.roles.architect.model).toBe("openai/gpt-5.6-sol");
      expect(config.roles.architect.variant).toBe("xhigh");
    });

    it("empty role override inherits defaults", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: {} },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("auto-discovers aria.json", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { reviewer: { model: "opencode-go/custom-reviewer" } },
      }));
      expect(resolveAriaConfig(root).roles.reviewer.model).toBe("opencode-go/custom-reviewer");
    });

    it("falls back to legacy project review-driven-code.json when aria.json is absent", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { reviewer: { model: "opencode-go/legacy-project-reviewer" } },
      }));
      expect(resolveAriaConfig(root).roles.reviewer.model).toBe("opencode-go/legacy-project-reviewer");
    });

    it("prefers aria.json over legacy project config when both exist", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
        roles: { reviewer: { model: "opencode-go/legacy-project-reviewer" } },
      }));
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { reviewer: { model: "opencode-go/aria-project-reviewer" } },
      }));
      expect(resolveAriaConfig(root).roles.reviewer.model).toBe("opencode-go/aria-project-reviewer");
    });

    it("accepts legacy director and wiki-compiler override keys", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: {
          director: { model: "opencode-go/legacy-coder" },
          "wiki-compiler": { model: "opencode-go/legacy-archivist" },
        },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.coder.model).toBe("opencode-go/legacy-coder");
      expect(config.roles.archivist.model).toBe("opencode-go/legacy-archivist");
    });

    it("rejects duplicate canonical and legacy overrides for the same role", () => {
      expect(() => parseOverrides({
        roles: {
          coder: { model: "opencode-go/coder" },
          director: { model: "opencode-go/legacy-coder" },
        },
      })).toThrow(/duplicated via alias/);
    });

    it("injects resolved routing into coder prompt", () => {
      const config = resolveAriaConfig(tmpdir());
      expect(config.roles.coder.promptText).toContain("Configured routes:");
      expect(config.roles.coder.promptText).toContain("coder: `coder` → opencode-go/deepseek-v4-pro");
      expect(config.roles.coder.promptText).toContain("explorer: `explorer` → opencode-go/deepseek-v4-flash [high]");
      expect(config.roles.coder.promptText).toContain("planner: `planner` → openai/gpt-5.6-terra [xhigh]");
      expect(config.roles.coder.promptText).toContain("architect: `architect` → openai/gpt-5.6-sol [xhigh]");
      expect(config.roles.coder.promptText).toContain("implementer: `implementer` → opencode-go/glm-5.2");
      expect(config.roles.coder.promptText).toContain("reviewer: `reviewer` → opencode-go/deepseek-v4-pro");
      expect(config.roles.coder.promptText).toContain("visualizer: `visualizer` → opencode-go/kimi-k2.7-code");
      expect(config.roles.coder.promptText).toContain("writer: `writer`");
      expect(config.roles.coder.promptText).toContain("openai/gpt-5.6-sol [medium]");
      expect(config.roles.coder.promptText).toContain("archivist: `archivist` → opencode-go/deepseek-v4-pro");
    });

    it("routing reflects project model override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/gpt-5.4-mini" } },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.coder.promptText).toContain("planner: `planner` → openai/gpt-5.4-mini [xhigh]");
    });

    it("routing reflects project variant override", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { explorer: { variant: "xhigh" } },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles.coder.promptText).toContain("explorer: `explorer` → opencode-go/deepseek-v4-flash [xhigh]");
    });

    it("roles without variants render cleanly without fake variant text", () => {
      const config = resolveAriaConfig(tmpdir());
      expect(config.roles.coder.promptText).toContain("coder: `coder` → opencode-go/deepseek-v4-pro\n");
      expect(config.roles.coder.promptText).toContain("implementer: `implementer` → opencode-go/glm-5.2\n");
      expect(config.roles.coder.promptText).toContain("reviewer: `reviewer` → opencode-go/deepseek-v4-pro\n");
      expect(config.roles.coder.promptText).toContain("visualizer: `visualizer` → opencode-go/kimi-k2.7-code\n");
      expect(config.roles.coder.promptText).toContain("archivist: `archivist` → opencode-go/deepseek-v4-pro\n");
    });

    it("archivist model and variant overrides resolve correctly", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "aria-overrides-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { "archivist": { model: "openai/gpt-5.4-mini", variant: "high" } },
      }));
      const config = resolveAriaConfig(root);
      expect(config.roles["archivist"].model).toBe("openai/gpt-5.4-mini");
      expect(config.roles["archivist"].variant).toBe("high");
      expect(config.roles.coder.promptText).toContain("archivist: `archivist` → openai/gpt-5.4-mini [high]");
    });

    it("archivist defaults resolve without WIKI_DIR env (missing env does not break startup)", () => {
      delete process.env.WIKI_DIR;
      const config = resolveAriaConfig(tmpdir());
      expect(config.roles["archivist"].model).toBe("opencode-go/deepseek-v4-pro");
      expect(config.roles["archivist"].promptText).toBeDefined();
      expect(config.roles["archivist"].promptText.length).toBeGreaterThan(0);
      // Coder prompt must never contain packageRoot or WIKI_DIR paths.
      expect(config.roles.coder.promptText).not.toContain("{{packageRoot}}");
      expect(config.roles.coder.promptText).not.toContain("{{WIKI_DIR}}");
    });

    it("archivist prompt receives resolved packageRoot and WIKI_DIR when set", () => {
      process.env.WIKI_DIR = "/home/user/wiki";
      const config = resolveAriaConfig(tmpdir());
      delete process.env.WIKI_DIR;
      // Path placeholders resolved in archivist prompt only.
      expect(config.roles["archivist"].promptText).toContain("WIKI_DIR: `/home/user/wiki`");
      expect(config.roles["archivist"].promptText).toContain("PACKAGE_ROOT:");
      expect(config.roles["archivist"].promptText).not.toContain("{{WIKI_DIR}}");
      expect(config.roles["archivist"].promptText).not.toContain("{{packageRoot}}");
      // Other roles must never receive these paths.
      expect(config.roles.coder.promptText).not.toContain("/home/user/wiki");
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
      const root = await mkdtemp(resolve(tmpdir(), "aria-no-global-"));
      tempDirs.push(root);
      process.env.HOME = root;
      const config = resolveAriaConfig(resolve(root, "worktree"));
      expect(config.roles.planner.model).toBe("openai/gpt-5.6-terra");
      expect(config.roles.planner.variant).toBe("xhigh");
    });

    it("falls back to legacy global review-driven-code.json when aria.json is absent", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "aria-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "review-driven-code.json"), JSON.stringify({
        roles: { planner: { model: "openai/legacy-global-model" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "aria-proj-"));
      tempDirs.push(root);
      expect(resolveAriaConfig(root).roles.planner.model).toBe("openai/legacy-global-model");
    });

    it("reads global override when no project config exists", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "aria-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "aria-proj-"));
      tempDirs.push(root);

      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/global-model");
      expect(config.roles.planner.variant).toBe("xhigh"); // from default
    });

    it("project overrides global per-field", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "aria-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model", variant: "global-variant" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "aria-proj-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: { variant: "project-variant" } },
      }));

      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/global-model"); // from global
      expect(config.roles.planner.variant).toBe("project-variant"); // project wins
    });

    it("project model overrides global model", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "aria-home-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/global-model", variant: "global-variant" } },
      }));

      const root = await mkdtemp(resolve(tmpdir(), "aria-proj-"));
      tempDirs.push(root);
      await writeFile(resolve(root, "aria.json"), JSON.stringify({
        roles: { planner: { model: "openai/project-model" } },
      }));

      const config = resolveAriaConfig(root);
      expect(config.roles.planner.model).toBe("openai/project-model"); // project wins
      expect(config.roles.planner.variant).toBe("global-variant"); // inherited from global
    });
  });

  describe("global diagnostics", () => {
    it("includes global path in error messages", () => {
      const globalPath = "/home/user/.config/opencode/aria.json";
      expect(() => parseOverrides({ models: {} }, globalPath))
        .toThrow(globalPath);
    });

    it("malformed global JSON includes global path in syntax error", async () => {
      const home = await mkdtemp(resolve(tmpdir(), "aria-bad-json-"));
      tempDirs.push(home);
      process.env.HOME = home;

      const globalConfigDir = resolve(home, ".config", "opencode");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(resolve(globalConfigDir, "aria.json"), "{bad json");

      const root = await mkdtemp(resolve(tmpdir(), "aria-proj-"));
      tempDirs.push(root);

      const expectedPath = resolve(home, ".config", "opencode", "aria.json");
      expect(() => resolveAriaConfig(root)).toThrow(expectedPath);
    });
  });
});
