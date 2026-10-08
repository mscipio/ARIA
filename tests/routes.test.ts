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
  it("includes all eleven roles with their built-in defaults when no override file exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).toBe(`Resolved ARIA role routes:
coder  opencode-go/muse-spark-1.3-contributor (xhigh)
explorer  opencode-go/muse-spark-1.3-contributor (high)
visualizer  opencode-go/muse-spark-1.3-contributor (xhigh)
planner  openai/gpt-6-luna (xhigh)
architect  openai/gpt-6.1-sol (high)
implementer  opencode-go/muse-spark-1.3-contributor (xhigh)
reviewer  openai/gpt-6.1-sol (medium)
researcher  openai/gpt-6.1-sol (medium)
archivist  opencode-go/muse-spark-1.3-contributor (high)
writer  openai/gpt-6-luna (xhigh)
scientist  openai/gpt-6.1-sol (medium)`);
  });

  it("reflects scientist model override and clears the inherited default variant", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { scientist: { model: "openai/gpt-5.6-terra" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("scientist  openai/gpt-5.6-terra");
    expect(output).not.toContain("scientist  openai/gpt-5.6-terra (medium)");
    expect(output).not.toContain("scientist  openai/gpt-5.6-sol");
  });

  it("reflects researcher model override and clears the inherited default variant", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { researcher: { model: "openai/gpt-5.6-terra" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("researcher  openai/gpt-5.6-terra");
    expect(output).not.toContain("researcher  openai/gpt-5.6-terra (medium)");
    expect(output).not.toContain("researcher  openai/gpt-5.6-sol");
  });

  it("reflects researcher variant override while inheriting model from defaults", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { researcher: { variant: "xhigh" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("researcher  openai/gpt-6.1-sol (xhigh)");
  });

  it("reflects model override and clears the inherited default variant", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.4-mini" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("planner  openai/gpt-5.4-mini");
    expect(output).not.toContain("planner  openai/gpt-5.4-mini (xhigh)");
    expect(output).toContain("architect  openai/gpt-6.1-sol (high)");
  });

  it("reflects variant override while inheriting model from defaults", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { explorer: { variant: "xhigh" } },
    }));
    const output = formatRoutes(root);
    expect(output).toContain("explorer  opencode-go/muse-spark-1.3-contributor (xhigh)");
  });

  it("renders every baseline role with its variant in parentheses", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).toContain("coder  opencode-go/muse-spark-1.3-contributor (xhigh)\n");
    expect(output).toContain("implementer  opencode-go/muse-spark-1.3-contributor (xhigh)\n");
    expect(output).toContain("reviewer  openai/gpt-6.1-sol (medium)");
    expect(output).not.toContain(" ()");
  });

  it("does not use Markdown backticks around model identifiers", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    const output = formatRoutes(root);
    expect(output).not.toMatch(/`opencode-go/);
    expect(output).not.toMatch(/`openai/);
  });

  it("propagates validation errors from invalid config", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { planner: { model: "" } },
    }));
    expect(() => formatRoutes(root)).toThrow();
  });

  it("propagates SyntaxError from malformed JSON config", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-routes-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), "{broken");
    expect(() => formatRoutes(root)).toThrow(SyntaxError);
  });
});