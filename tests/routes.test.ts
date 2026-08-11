import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { formatRoutes } from "../src/routes";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("formatRoutes", () => {
  it("includes all eight roles with their built-in defaults when no override file exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).toBe(`Resolved RDC role routes:
director  opencode-go/deepseek-v4-pro
explorer  opencode-go/deepseek-v4-flash (high)
visualizer  opencode-go/kimi-k2.7-code
planner  openai/gpt-5.6-terra (xhigh)
architect  openai/gpt-5.6-sol (xhigh)
implementer  opencode-go/glm-5.2
reviewer  opencode-go/deepseek-v4-pro
wiki-compiler  opencode-go/deepseek-v4-pro`);
  });

  it("reflects model override while inheriting variant from defaults", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.4-mini" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("planner  openai/gpt-5.4-mini (xhigh)");
    expect(output).toContain("architect  openai/gpt-5.6-sol (xhigh)");
  });

  it("reflects variant override while inheriting model from defaults", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
      roles: { explorer: { variant: "xhigh" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("explorer  opencode-go/deepseek-v4-flash (xhigh)");
  });

  it("renders roles with no variant without parentheses", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).toContain("director  opencode-go/deepseek-v4-pro\n");
    expect(output).toContain("implementer  opencode-go/glm-5.2\n");
    expect(output).toContain("reviewer  opencode-go/deepseek-v4-pro");
    expect(output).not.toContain("director  opencode-go/deepseek-v4-pro ()");
  });

  it("does not use Markdown backticks around model identifiers", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).not.toMatch(/`opencode-go/);
    expect(output).not.toMatch(/`openai/);
  });

  it("propagates validation errors from invalid config", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "review-driven-code.json"), JSON.stringify({
      roles: { planner: { model: "" } },
    }));
    expect(() => formatRoutes(root)).toThrow();
  });

  it("propagates SyntaxError from malformed JSON config", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "review-driven-code-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "review-driven-code.json"), "{broken");
    expect(() => formatRoutes(root)).toThrow(SyntaxError);
  });
});