import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    });
  });
});
