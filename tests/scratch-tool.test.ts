import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import aria from "../src/index";
import { createUniqueScratchDir } from "../src/scratch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureWorktree(name: string): Promise<string> {
  const dir = await createUniqueScratchDir(REPO_ROOT, "tests/fixtures", name);
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

describe("native task scratch tool", () => {
  it("registers through ctx.tool.transform and returns canonical task paths beneath the project", async () => {
    const root = await fixtureWorktree("scratch-tool-paths");
    const tools = await registerTools({ project: { directory: root } });
    const tool = tools.get("scratch_task");

    expect([...tools.keys()]).toEqual(expect.arrayContaining(["plan", "scratch_task"]));
    expect(tool?.input).toMatchObject({
      type: "object",
      required: ["taskName"],
    });
    expect(tool).toBeDefined();
    const result = await tool!.execute({ taskId: "T021", taskName: "Native Scratch Tool" });
    expect(result.metadata.title).toBe("Allocate scratch · Native Scratch Tool");
    const payload = JSON.parse(result.content) as {
      scratch: string;
      taskDir: string;
      dirs: Record<string, string>;
    };
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const expectedDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(relative(payload.scratch, payload.taskDir)).toMatch(new RegExp(`^${expectedDate}/\\d{6}-native-scratch-tool(?:-[a-f0-9]{6})?$`));
    expect(payload.scratch).toBe(join(root, "scratch"));
    expect(payload.dirs.tmp).toBe(join(payload.taskDir, "tmp"));
    expect(payload.dirs.testFixtures).toBe(join(payload.taskDir, "tests", "fixtures"));
    expect(payload.dirs.logs).toBe(join(payload.taskDir, "logs"));
    for (const path of Object.values(payload.dirs)) {
      const relativePath = relative(payload.scratch, path);
      expect(relativePath.length).toBeGreaterThan(0);
      expect(relativePath).not.toBe("..");
      expect(relativePath.startsWith(`..${sep}`)).toBe(false);
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const sanitizedName = await tool!.execute({ taskId: "T022", taskName: "../../safe task" });
    const sanitizedPayload = JSON.parse(sanitizedName.content) as { taskDir: string; scratch: string };
    expect(relative(sanitizedPayload.scratch, sanitizedPayload.taskDir)).toMatch(new RegExp(`^${expectedDate}/\\d{6}-safe-task(?:-\\d+)?$`));
    expect(relative(sanitizedPayload.scratch, sanitizedPayload.taskDir).startsWith(`..${sep}`)).toBe(false);
  });

  it("fails closed for missing project location and invalid task identity", async () => {
    const withoutLocation = await registerTools();
    const missingLocationResult = await withoutLocation.get("scratch_task")!.execute({
      taskId: "T021",
      taskName: "No project location",
    });
    expect(missingLocationResult.metadata.title).toBe("Error");
    expect(missingLocationResult.content).toContain("no cwd fallback");

    const root = await fixtureWorktree("scratch-tool-invalid-input");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;
    const ignoredTaskId = await tool.execute({ taskId: "../escape", taskName: "Task-independent" });
    expect(ignoredTaskId.metadata.title).toContain("Task-independent");
    const unsafeName = await tool.execute({ taskId: "T021", taskName: "Bad\u0000Name" });
    expect(unsafeName.metadata.title).toBe("Error");
    expect(unsafeName.content).toContain("without control characters");
  });

  it("rejects every C0 and DEL control code while accepting Unicode task descriptions", async () => {
    const root = await fixtureWorktree("scratch-tool-control-characters");
    const tool = (await registerTools({ project: { directory: root } })).get("scratch_task")!;

    for (const codeUnit of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
      const result = await tool.execute({
        taskId: "T021",
        taskName: `Bad${String.fromCharCode(codeUnit)}Name`,
      });
      expect(result.metadata.title).toBe("Error");
      expect(result.content).toContain("without control characters");
    }

    const unicodeName = "Préparation 東京 🚀";
    const unicodeResult = await tool.execute({ taskId: "T022", taskName: unicodeName });
    expect(unicodeResult.metadata.title).toBe(`Allocate scratch · ${unicodeName}`);
    expect(JSON.parse(unicodeResult.content)).toMatchObject({ scratch: join(root, "scratch") });
  });

  it("keeps prompts on the current worktree-local scratch policy", async () => {
    const prompts = await Promise.all(
      ["coder", "implementer", "visualizer", "reviewer"].map((role) =>
        readFile(join(REPO_ROOT, "defaults", "prompts", `${role}.md`), "utf8"),
      ),
    );
    expect(prompts[0]?.toLowerCase()).toContain("no taskid, approved plan, or `scratch_task` allocation is required");
    expect(prompts[1]?.toLowerCase()).toContain("no taskid, approved plan, or `scratch_task` allocation is required");
    expect(prompts[2]).toContain("./scratch/YYYY-MM-DD/HHMMSS-title/");
    expect(prompts[3]?.toLowerCase()).toContain("no taskid, approved plan, or `scratch_task` allocation is required");
  });
});
