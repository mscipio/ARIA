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
  it("accepts only models and variants", () => {
    expect(parseOverrides({
      models: { reviewer: "opencode-go/glm-5.2" },
      variants: { planner: "high" },
    })).toMatchObject({
      models: { reviewer: "opencode-go/glm-5.2" },
      variants: { planner: "high" },
    });
  });

  it("rejects removed configuration surfaces", () => {
    expect(() => parseOverrides({ transitions: { autoLoop: true } })).toThrow(ConfigValidationError);
    expect(() => parseOverrides({ subagents: { disable: ["reviewer"] } })).toThrow(ConfigValidationError);
    expect(() => parseOverrides({ prompts: { director: "./director.md" } })).toThrow(ConfigValidationError);
    expect(() => parseOverrides({ fallbacks: { planner: ["opencode-go/glm-5.2"] } })).toThrow(ConfigValidationError);
  });

  it("rejects unknown roles and malformed model identifiers", () => {
    expect(() => parseOverrides({ models: { tester: "opencode-go/model" } })).toThrow(/valid role/);
    expect(() => parseOverrides({ models: { planner: "gpt-5" } })).toThrow(/provider\/model/);
  });

  it("auto-discovers review-driven-code.json", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-overrides-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
      models: { reviewer: "opencode-go/custom-reviewer" },
    }));
    expect(resolveReviewDrivenCodeConfig(root).roles.reviewer.model).toBe("opencode-go/custom-reviewer");
  });
});
