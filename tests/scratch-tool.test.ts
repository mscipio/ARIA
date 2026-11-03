import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import aria from "../src/index";
import { allocateUnplannedExecutionDir, resolveScratchRoot } from "../src/scratch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureWorktree(name: string): Promise<string> {
  const dir = await allocateUnplannedExecutionDir(REPO_ROOT, `vitest-${name}`);
  managed.push(dir);
  return dir;
}

type NativeTool = {
  name: string;
  input: Record<string, unknown>;
  execute: (input: unknown) => Promise<{ content: string; metadata: { title: string } }>;
};

async function registerTools(location?: unknown): Promise<Map<string, NativeTool>> {
  const added = new Map<string, NativeTool>();
  const toolTransform = vi.fn(async (callback: (editor: { add: (tool: never) => void }) => void) => {
    callback({ add: (tool) => {
      const nativeTool = tool as NativeTool;
      added.set(nativeTool.name, nativeTool);
    } });
  });
  const ctx = {
    ...(location === undefined ? {} : { location }),
    tool: { transform: toolTransform },
  };
  const cleanup = await (aria.setup as (context: unknown) => Promise<unknown>)(ctx as never);
  await (cleanup as (() => Promise<void> | void) | undefined)?.();
  expect(toolTransform).toHaveBeenCalledTimes(1);
  return added;
}

describe("scratch_task native tool", () => {
  it("allocates an unplanned execution and returns only namespace and executionDir", async () => {
    const root = await fixtureWorktree("scratch-tool-unplanned");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task");
    expect(tool?.input).toMatchObject({ type: "object", required: ["taskName"] });

    const result = await tool!.execute({ taskName: "Native Scratch Tool" });
    expect(result.metadata.title).toBe("Allocate scratch · Native Scratch Tool");
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["executionDir", "namespace"]);
    expect(payload.namespace).toBe("unplanned");
    const { scratch } = await resolveScratchRoot(root);
    expect(relative(scratch, payload.executionDir as string)).toMatch(/^unplanned\/\d{8}-\d{6}-native-scratch-tool(?:-[a-f0-9]{6})?$/);
  });

  it("allocates a planned execution for an exact planId and taskId, one new directory per call", async () => {
    const root = await fixtureWorktree("scratch-tool-planned");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;
    const planId = randomUUID();
    const { scratch } = await resolveScratchRoot(root);

    const first = JSON.parse((await tool.execute({ taskName: "Plan run", planId, taskId: "T021" })).content) as { namespace: string; executionDir: string };
    const second = JSON.parse((await tool.execute({ taskName: "Plan run", planId, taskId: "T021" })).content) as { executionDir: string };
    expect(first.namespace).toBe("plan");
    expect(relative(scratch, first.executionDir)).toMatch(new RegExp(`^${planId}/T021/\\d{8}-\\d{6}(?:-[a-f0-9]{6})?$`));
    expect(second.executionDir).not.toBe(first.executionDir);
  });

  it("returns an error for half-specified identity instead of falling back to unplanned", async () => {
    const root = await fixtureWorktree("scratch-tool-half");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;
    const onlyPlan = await tool.execute({ taskName: "x", planId: randomUUID() });
    expect(onlyPlan.metadata.title).toBe("Error");
    expect(onlyPlan.content).toContain("supplied together");
    const onlyTask = await tool.execute({ taskName: "x", taskId: "T001" });
    expect(onlyTask.content).toContain("supplied together");
  });

  it("rejects malformed identifiers and traversal without creating anything", async () => {
    const root = await fixtureWorktree("scratch-tool-bad-ids");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;
    const badPlan = await tool.execute({ taskName: "x", planId: "../escape", taskId: "T001" });
    expect(badPlan.metadata.title).toBe("Error");
    expect(badPlan.content).toMatch(/lowercase UUIDv4/);
    const badTask = await tool.execute({ taskName: "x", planId: randomUUID(), taskId: "T1/../x" });
    expect(badTask.content).toMatch(/plan task path component/);
  });

  it("fails closed without a project location", async () => {
    const withoutLocation = (await registerTools()).get("scratch_task")!;
    const missing = await withoutLocation.execute({ taskName: "No project location" });
    expect(missing.metadata.title).toBe("Error");
    expect(missing.content).toContain("no cwd fallback");
  });

  it("rejects every C0 and DEL control code while accepting Unicode descriptions", async () => {
    const root = await fixtureWorktree("scratch-tool-control");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;
    for (const codeUnit of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
      const result = await tool.execute({ taskName: `Bad${String.fromCharCode(codeUnit)}Name` });
      expect(result.metadata.title).toBe("Error");
      expect(result.content).toContain("without control characters");
    }
    const unicodeName = "Préparation 東京 🚀";
    const unicodeResult = await tool.execute({ taskName: unicodeName });
    expect(unicodeResult.metadata.title).toBe(`Allocate scratch · ${unicodeName}`);
  });

  it("keeps prompts on the two-category .aria/scratch policy", async () => {
    const visualizer = await readFile(join(REPO_ROOT, "defaults", "prompts", "visualizer.md"), "utf8");
    expect(visualizer).toContain(".aria/scratch/unplanned/<timestamp>-<description>/");
    expect(visualizer).not.toMatch(/\.aria\/scratch\/(fast-path|runtime)\b|exec-[A-Za-z0-9]{6}/);
    const coder = await readFile(join(REPO_ROOT, "defaults", "prompts", "coder.md"), "utf8");
    expect(coder).toContain(".aria/scratch/<plan-id>/<task-id>/<timestamp>/");
    expect(coder).toContain("independent tool output, including Playwright MCP, goes under");
    const implementer = await readFile(join(REPO_ROOT, "defaults", "prompts", "implementer.md"), "utf8");
    expect(implementer).toContain("write only to the execution directory named in your cold-start prompt");
    const reviewer = await readFile(join(REPO_ROOT, "defaults", "prompts", "reviewer.md"), "utf8");
    expect(reviewer).toContain("The Reviewer is read-only and creates no files");
  });
});
