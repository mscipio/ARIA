import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import aria from "../src/index";
import {
  createPlanTool,
  isFilesystemRoot,
  PLAN_TOOL_ACTIONS,
  planToolInputSchema,
  resolvePlanRootFromLocation,
  type PlanToolContext,
  type PlanToolResult,
} from "../src/plan-tool";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aria-plan-tool-"));
  tempDirs.push(root);
  return root;
}

async function symlinkToRoot(linkPath: string): Promise<void> {
  const root = parse(resolve(linkPath)).root;
  await symlink(root, linkPath, "junction");
}

function toolContext(
  agent: string,
  sessionID: string,
  extra?: Partial<PlanToolContext> & { signal?: AbortSignal },
): PlanToolContext {
  return {
    sessionID,
    agent,
    messageID: `msg-${sessionID || "none"}`,
    signal: extra?.signal ?? new AbortController().signal,
    progress: extra?.progress ?? (async () => undefined),
  };
}

function contentOf(result: PlanToolResult): string {
  return result.content;
}

function planIDOf(text: string): string {
  const match = text.match(/Plan ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (!match) throw new Error(`Plan ID not found in:\n${text}`);
  return match[1]!;
}

function revisionOf(text: string): number {
  const match = text.match(/Revision:\s*(\d+)/);
  if (!match) throw new Error(`Revision not found in:\n${text}`);
  return Number(match[1]);
}

describe("T006 native V2 plan tool", () => {
  it("registers natively via ctx.tool.transform(editor => editor.add(...)) with no command/MCP sidecar", async () => {
    const root = await project();
    const added: Array<{ name?: unknown }> = [];
    const toolTransform = vi.fn(async (callback: (editor: { add: (tool: never) => void }) => void) => {
      callback({ add: (tool) => void added.push(tool as { name?: unknown }) });
      return { dispose: async () => undefined };
    });
    const commandTransform = vi.fn();
    const mcpSpy = vi.fn();
    const ctx = {
      location: { directory: root, project: { id: "project-test", directory: root, canonical: root } },
      tool: { transform: toolTransform },
      agent: { transform: async () => ({ dispose: async () => undefined }) },
      command: { transform: commandTransform },
      mcp: { transform: mcpSpy },
    };
    const cleanup = await (aria.setup as (ctx: unknown) => Promise<unknown>)(ctx as never);
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => Promise<void> | void)();

    expect(toolTransform).toHaveBeenCalledTimes(1);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: "plan" });
    expect(commandTransform).not.toHaveBeenCalled();
    expect(mcpSpy).not.toHaveBeenCalled();
  });

  it("exposes the eight-action JSON-Schema input with action required", () => {
    expect([...PLAN_TOOL_ACTIONS].sort()).toEqual(
      ["add", "approve", "close", "create", "get", "remediate", "replace", "update"].sort(),
    );
    const schema = planToolInputSchema as {
      properties?: { action?: { enum?: string[] } };
      required?: string[];
    };
    expect(schema.properties?.action?.enum).toEqual(expect.arrayContaining([...PLAN_TOOL_ACTIONS]));
    expect(schema.required).toContain("action");
    const tool = createPlanTool("/tmp/aria-plan-tool-test");
    expect(tool.name).toBe("plan");
    expect(tool.description).toContain(".aria/rdc/TASKS.md");
  });

  it("enforces ToolContext authorization per role with sessionID required", async () => {
    const root = await project();
    const tool = createPlanTool(root);
    const coder = (session: string) => toolContext("coder", session);
    const created = await tool.execute({ action: "create", title: "ACL plan", tasks: ["Task"] }, coder("coder-create"));
    const planID = planIDOf(contentOf(created));
    const revision = revisionOf(contentOf(created));

    // planner: get + create allowed, mutations rejected
    const plannerGet = await tool.execute({ action: "get" }, toolContext("planner", "planner-get"));
    expect(contentOf(plannerGet)).toContain("Plan: ACL plan");
    expect(plannerGet.metadata.title).toBe("Check active plan");
    for (const args of [
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "X", tasks: ["T"] },
      { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID: "T001", status: "completed" },
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      { action: "remediate", expectedPlanID: planID, expectedRevision: revision, tasks: ["Fix"] },
      { action: "approve", expectedPlanID: planID, expectedRevision: revision },
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
    ]) {
      const denied = await tool.execute(args, toolContext("planner", `planner-${args.action}`));
      expect(contentOf(denied)).toMatch(new RegExp(`may not ${args.action}`));
      expect(denied.metadata.title).toBe("Error");
    }

    // architect: get + replace allowed, create/update/add/close rejected, coder-only approve rejected
    const architectGet = await tool.execute({ action: "get" }, toolContext("architect", "architect-get"));
    expect(contentOf(architectGet)).toContain("Plan: ACL plan");
    const replaced = await tool.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "Architect fix", tasks: ["Task"] },
      toolContext("architect", "architect-replace"),
    );
    expect(contentOf(replaced)).toContain("Architect fix");
    expect(replaced.metadata.title).toBe("Replace plan · Architect fix");
    for (const args of [
      { action: "create", title: "Arch", tasks: ["T"] },
      {
        action: "update",
        expectedPlanID: planID,
        expectedRevision: revision,
        taskID: "T001",
        status: "completed",
      },
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
    ]) {
      const denied = await tool.execute(args, toolContext("architect", `architect-${args.action}`));
      expect(contentOf(denied)).toMatch(new RegExp(`may not ${args.action}`));
      expect(denied.metadata.title).toBe("Error");
    }

    // reviewer: get allowed, every mutation rejected
    const reviewerGet = await tool.execute({ action: "get" }, toolContext("reviewer", "reviewer-get"));
    expect(contentOf(reviewerGet)).toContain("Plan: Architect fix");
    for (const args of [
      { action: "create", title: "R", tasks: ["T"] },
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "R", tasks: ["T"] },
      { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID: "T001", status: "completed" },
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      { action: "remediate", expectedPlanID: planID, expectedRevision: revision, tasks: ["Fix"] },
      { action: "approve", expectedPlanID: planID, expectedRevision: revision },
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
    ]) {
      const denied = await tool.execute(args, toolContext("reviewer", `reviewer-${args.action}`));
      expect(contentOf(denied)).toMatch(new RegExp(`may not ${args.action}`));
    }

    // coder: full V1 set allowed (replace stays architect-only), unknown roles rejected
    const coderGet = await tool.execute({ action: "get" }, coder("coder-get"));
    expect(contentOf(coderGet)).toContain("Plan: Architect fix");
    const coderReplace = await tool.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "X", tasks: ["T"] },
      coder("coder-replace"),
    );
    expect(contentOf(coderReplace)).toMatch(/may not replace/);
    expect(contentOf(await tool.execute({ action: "get" }, toolContext("researcher", "researcher-get")))).toMatch(
      /may not get/,
    );
    const missingSession = await tool.execute({ action: "get" }, toolContext("coder", ""));
    expect(contentOf(missingSession)).toMatch(/sessionID is required/);
    expect(missingSession.metadata.title).toBe("Error");
  });

  it("rejects stale plan id and revision (app-owned CAS)", async () => {
    const root = await project();
    const tool = createPlanTool(root);
    const coder = (session: string) => toolContext("coder", session);
    const created = await tool.execute({ action: "create", title: "Stale test", tasks: ["Task"] }, coder("create"));
    const planID = planIDOf(contentOf(created));
    const initialRevision = revisionOf(contentOf(created));

    const wrongID = await tool.execute(
      {
        action: "update",
        expectedPlanID: "00000000-0000-1000-8000-000000000000",
        expectedRevision: initialRevision,
        taskID: "T001",
        status: "completed",
      },
      coder("wrong-id"),
    );
    expect(contentOf(wrongID)).toMatch(/plan id conflict/);
    expect(wrongID.metadata.title).toBe("Error");

    const approved = await tool.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: initialRevision },
      coder("approve"),
    );
    const approvedRevision = revisionOf(contentOf(approved));
    const advanced = await tool.execute(
      {
        action: "update",
        expectedPlanID: planID,
        expectedRevision: approvedRevision,
        taskID: "T001",
        status: "completed",
        evidence: "done",
      },
      coder("advance"),
    );
    const advancedRevision = revisionOf(contentOf(advanced));
    expect(advancedRevision).toBe(approvedRevision + 1);

    const stale = await tool.execute(
      {
        action: "update",
        expectedPlanID: planID,
        expectedRevision: approvedRevision,
        taskID: "T001",
        status: "in_progress",
      },
      coder("stale"),
    );
    expect(contentOf(stale)).toMatch(/revision conflict/);
    expect(stale.metadata.title).toBe("Error");
  });

  it("guards filesystem-root and symlink-to-root startup locations", async () => {
    expect(isFilesystemRoot(parse(resolve("/tmp/aria-plan-tool-test")).root)).toBe(true);
    const root = await project();
    expect(isFilesystemRoot(root)).toBe(false);
    expect(resolvePlanRootFromLocation({ directory: "/", project: { directory: root } })).toBe(root);
    expect(resolvePlanRootFromLocation({ directory: "", project: { directory: "" } })).toBe("");
    expect(resolvePlanRootFromLocation(undefined)).toBe("");

    const symlinkDir = join(root, "root-link");
    await symlinkToRoot(symlinkDir);
    expect(resolvePlanRootFromLocation({ directory: symlinkDir, project: { directory: root } })).toBe(root);

    const originalCwd = process.cwd();
    const cwdDir = await project();
    try {
      process.chdir(cwdDir);
      const emptyTool = createPlanTool("");
      const getResult = await emptyTool.execute({ action: "get" }, toolContext("coder", "empty-get"));
      expect(contentOf(getResult)).toMatch(/meaningful OpenCode directory/);
      expect(getResult.metadata.title).toBe("Error");
      const createResult = await emptyTool.execute(
        { action: "create", title: "Should not exist", tasks: ["Task"] },
        toolContext("coder", "empty-create"),
      );
      expect(contentOf(createResult)).toMatch(/meaningful OpenCode directory/);
      await expect(readFile(join(cwdDir, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();
      await expect(readFile(join(parse(resolve("/tmp/x")).root, ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();

      const rootTool = createPlanTool(parse(resolve(symlinkDir)).root);
      const rootResult = await rootTool.execute({ action: "get" }, toolContext("coder", "root-get"));
      expect(contentOf(rootResult)).toMatch(/meaningful OpenCode directory/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects invalid input with the preserved V1 messages", async () => {
    const root = await project();
    const tool = createPlanTool(root);
    const coder = (session: string) => toolContext("coder", session);
    const architectCtx = (session: string) => toolContext("architect", session);
    const created = await tool.execute({ action: "create", title: "Invalid", tasks: ["Task"] }, coder("create"));
    const planID = planIDOf(contentOf(created));
    const revision = revisionOf(contentOf(created));

    const cases: Array<{ args: Record<string, unknown>; message: RegExp; role: "coder" | "architect" }> = [
      { role: "coder", args: { action: "create", title: "No tasks" }, message: /title and tasks are required for create/ },
      { role: "coder", args: { action: "create", tasks: ["No title"] }, message: /title and tasks are required for create/ },
      { role: "architect", args: { action: "replace", title: "X", tasks: ["T"] }, message: /expectedPlanID is required for replace/ },
      {
        role: "architect",
        args: { action: "replace", expectedPlanID: planID, title: "X", tasks: ["T"] },
        message: /expectedRevision is required for replace/,
      },
      {
        role: "architect",
        args: { action: "replace", expectedPlanID: planID, expectedRevision: revision },
        message: /title and tasks are required for replace/,
      },
      { role: "coder", args: { action: "add", expectedRevision: revision, tasks: ["T"] }, message: /expectedPlanID is required for add/ },
      { role: "coder", args: { action: "add", expectedPlanID: planID, tasks: ["T"] }, message: /expectedRevision is required for add/ },
      {
        role: "coder",
        args: { action: "add", expectedPlanID: planID, expectedRevision: revision },
        message: /tasks are required for add/,
      },
      {
        role: "coder",
        args: { action: "update", expectedRevision: revision, taskID: "T001", status: "completed" },
        message: /expectedPlanID is required for update/,
      },
      {
        role: "coder",
        args: { action: "update", expectedPlanID: planID, taskID: "T001", status: "completed" },
        message: /expectedRevision is required for update/,
      },
      {
        role: "coder",
        args: { action: "update", expectedPlanID: planID, expectedRevision: revision },
        message: /taskID and status are required for update/,
      },
      { role: "coder", args: { action: "approve", expectedRevision: revision }, message: /expectedPlanID is required for approve/ },
      { role: "coder", args: { action: "approve", expectedPlanID: planID }, message: /expectedRevision is required for approve/ },
      { role: "coder", args: { action: "close", expectedRevision: revision }, message: /expectedPlanID is required for close/ },
      { role: "coder", args: { action: "close", expectedPlanID: planID }, message: /expectedRevision is required for close/ },
    ];
    for (const { args, message, role } of cases) {
      const ctx = role === "architect" ? architectCtx(`invalid-${String(args.action)}`) : coder(`invalid-${String(args.action)}`);
      const result = await tool.execute(args, ctx);
      expect(contentOf(result), JSON.stringify(args)).toMatch(message);
      expect(result.metadata.title).toBe("Error");
    }
    const unknown = await tool.execute({ action: "nope" }, coder("unknown"));
    expect(contentOf(unknown)).toMatch(/Unknown plan action|may not nope/);
  });

  it("runs the eight-action happy path through planner, architect, and coder", async () => {
    const root = await project();
    const tool = createPlanTool(root);
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const coder = (session: string) => toolContext("coder", session);

    // create (planner) + get
    const created = await tool.execute(
      { action: "create", title: "Initial plan", tasks: ["Define model", "Build UI"] },
      planner("planner-create"),
    );
    expect(created.metadata.title).toBe("Create plan · Initial plan");
    expect(contentOf(created)).toContain("Approval: pending");
    expect(revisionOf(contentOf(created))).toBe(1);
    const planID = planIDOf(contentOf(created));

    // replace (architect) + get
    const replaced = await tool.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: 1, title: "Revised plan", tasks: ["Define schema", "Build UI"] },
      architect("architect-replace"),
    );
    expect(contentOf(replaced)).toContain("Plan: Revised plan");
    expect(revisionOf(contentOf(replaced))).toBe(2);
    const afterReplaceGet = await tool.execute({ action: "get" }, coder("coder-read"));
    expect(contentOf(afterReplaceGet)).toContain("Plan: Revised plan");

    // approve (coder)
    const approved = await tool.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: 2 },
      coder("coder-approve"),
    );
    expect(approved.metadata.title).toBe("Approve plan");
    expect(contentOf(approved)).toContain("Approval: approved");
    let revision = revisionOf(contentOf(approved));

    // add (coder) resets approval to pending, then re-approve
    const added = await tool.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Review"] },
      coder("coder-add"),
    );
    expect(added.metadata.title).toBe("Add plan tasks");
    expect(contentOf(added)).toContain("Approval: pending");
    revision = revisionOf(contentOf(added));
    const reApproved = await tool.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: revision },
      coder("coder-re-approve"),
    );
    revision = revisionOf(contentOf(reApproved));

    // update (coder) all three tasks to completed
    for (const taskID of ["T001", "T002", "T003"]) {
      const started = await tool.execute(
        { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID, status: "in_progress" },
        coder(`coder-start-${taskID}`),
      );
      expect(started.metadata.title).toBe(`Mark ${taskID} in progress`);
      revision = revisionOf(contentOf(started));
      const done = await tool.execute(
        {
          action: "update",
          expectedPlanID: planID,
          expectedRevision: revision,
          taskID,
          status: "completed",
          evidence: `verified ${taskID}`,
        },
        coder(`coder-done-${taskID}`),
      );
      revision = revisionOf(contentOf(done));
    }

    // remediate (coder) preserves approval, then complete the remediation task
    const remediated = await tool.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: revision, tasks: ["Fix blocking issue"] },
      coder("coder-remediate"),
    );
    expect(remediated.metadata.title).toBe("Add remediation tasks");
    expect(contentOf(remediated)).toContain("Approval: approved");
    expect(contentOf(remediated)).toContain("Fix blocking issue");
    revision = revisionOf(contentOf(remediated));
    const fixDone = await tool.execute(
      {
        action: "update",
        expectedPlanID: planID,
        expectedRevision: revision,
        taskID: "T004",
        status: "completed",
        evidence: "verified fix",
      },
      coder("coder-fix-done"),
    );
    revision = revisionOf(contentOf(fixDone));

    // close (coder) archives and removes the active file
    const closed = await tool.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
      coder("coder-close"),
    );
    expect(closed.metadata.title).toBe("Archive plan");
    expect(contentOf(closed)).toMatch(/Archived to/);
    expect(contentOf(closed)).toContain(`Plan ID: ${planID}`);
    await expect(readFile(join(root, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();
    const afterClose = await tool.execute({ action: "get" }, coder("coder-get-after-close"));
    expect(contentOf(afterClose)).toBe("No active plan.");
  });
});
