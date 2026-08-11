import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import reviewDrivenCodePlugin, { reviewDrivenCodePlugin as pluginModule } from "../src/index";
import { getPackageRoot } from "../src/defaults";

const server = pluginModule.server;
const tempDirs: string[] = [];
const plugins: Array<Awaited<ReturnType<typeof server>>> = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-driven-code-plugin-"));
  tempDirs.push(root);
  return root;
}

async function load(input: Parameters<typeof server>[0]) {
  const plugin = await server(input, {});
  plugins.push(plugin);
  return plugin;
}

function toolContext(agent: string, sessionID: string, abort?: AbortSignal) {
  return {
    agent,
    sessionID,
    abort,
    metadata() {},
  } as never;
}

function outputOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "output" in result) {
    return String((result as { output: unknown }).output);
  }
  throw new Error("Expected a tool result with output");
}

function titleOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "title" in result) {
    return String((result as { title: unknown }).title);
  }
  return undefined;
}

function revisionOf(text: string): number {
  const match = text.match(/Revision:\s*(\d+)/);
  if (!match) throw new Error(`Revision not found in:\n${text}`);
  return Number(match[1]);
}

function planIDOf(text: string): string {
  const match = text.match(/Plan ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (!match) throw new Error(`Plan ID not found in:\n${text}`);
  return match[1]!;
}

function assertPlanOutput(text: string, planID?: string): void {
  expect(text).toContain("Plan ID:");
  if (planID) expect(text).toContain(`Plan ID: ${planID}`);
}

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.dispose?.()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("reviewDrivenCodePlugin", () => {
  it("exports the OpenCode npm plugin shape", () => {
    expect(reviewDrivenCodePlugin).toMatchObject({ id: "review-driven-code", server });
    expect(typeof server).toBe("function");
  });

  it("registers exactly eight agents and the plan tool", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);

    expect(Object.keys(config.agent ?? {})).toEqual([
      "director",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "wiki-compiler",
    ]);
    expect(config.agent?.director?.mode).toBe("primary");
    expect(config.agent?.planner?.model).toBe("openai/gpt-5.6-terra");
    expect(config.agent?.planner?.mode).toBe("subagent");
    expect(config.agent?.architect?.mode).toBe("subagent");
    expect(config.agent?.["wiki-compiler"]?.mode).toBe("subagent");
    expect(config.agent?.researcher).toBeUndefined();
    expect(config.agent?.tester).toBeUndefined();
    expect(config.command).toBeUndefined();
    expect(Object.keys(plugin.tool ?? {})).toEqual(["plan"]);
    expect(plugin.event).toBeUndefined();
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
    expect(plugin["experimental.session.compacting"]).toBeUndefined();
  });

  it("declares plan permissions with approve, remediate, and reviewer get", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;

    expect(permission("director")).toMatchObject({
      "engram_*": "allow",
      "context7_*": "allow",
      "codegraph_*": "allow",
      edit: "deny",
      bash: "deny",
      plan: "allow",
      task: {
        "*": "deny",
        explorer: "allow",
        visualizer: "allow",
        planner: "allow",
        architect: "allow",
        implementer: "allow",
        reviewer: "allow",
        "wiki-compiler": "allow",
      },
    });
    expect(permission("explorer")).toMatchObject({ edit: "deny", bash: "deny", glob: "allow" });
    expect(permission("planner")).toMatchObject({ edit: "deny", bash: "deny", webfetch: "allow", plan: "allow" });
    expect(permission("architect")).toMatchObject({ edit: "deny", bash: "deny", websearch: "allow", plan: "allow" });
    expect(permission("implementer")).toMatchObject({
      edit: { "*": "allow", "*.env": "ask" },
      bash: { "*": "allow", "rm *": "deny", "npm publish*": "deny" },
      plan: "deny",
    });
    expect(permission("reviewer")).toMatchObject({ edit: "deny", bash: "allow", plan: "allow" });
    for (const role of ["director", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"]) {
      expect(permission(role)).toMatchObject({
        "engram_*": "allow",
        "context7_*": "allow",
        "codegraph_*": "allow",
      });
      expect(permission(role)).not.toHaveProperty("engram_mem_context");
      expect(permission(role)).not.toHaveProperty("engram_mem_search");
      expect(permission(role)).not.toHaveProperty("engram_mem_get_observation");
      expect(permission(role)).not.toHaveProperty("engram_mem_timeline");
    }
    // reviewer has plan "allow" so it can get; but not create/replace/update/add/remediate/approve/close
    for (const role of ["explorer", "visualizer", "implementer", "reviewer", "wiki-compiler"]) {
      expect(permission(role)).toMatchObject({ task: "deny" });
    }
    // wiki-compiler: genuinely deny-by-default with scoped access only when WIKI_DIR is set
    const wikiPerm = permission("wiki-compiler");
    const pipelineRun = `${getPackageRoot()}/wiki-pipeline/run.py`;
    expect(wikiPerm).toMatchObject({
      "*": "deny",
      plan: "deny",
      task: "deny",
    });
    // MCP: no Engram, CodeGraph, or Context7 access ? wiki-compiler
    // reads engram from the local engram.db via archive-engram command
    expect(wikiPerm).not.toHaveProperty("codegraph_*");
    expect(wikiPerm).not.toHaveProperty("context7_*");
    // Never has blanket engram_* or any engram MCP tools (not even read-only)
    expect(wikiPerm).not.toHaveProperty("engram_*");
    expect(wikiPerm).not.toHaveProperty("engram_mem_save");
    expect(wikiPerm).not.toHaveProperty("engram_mem_judge");
    expect(wikiPerm).not.toHaveProperty("engram_mem_session_summary");
    expect(wikiPerm).not.toHaveProperty("engram_mem_search");
    expect(wikiPerm).not.toHaveProperty("engram_mem_get_observation");
    expect(wikiPerm).not.toHaveProperty("engram_mem_context");
    expect(wikiPerm).not.toHaveProperty("engram_mem_timeline");
    // Bash: only explicit run.py subcommands, no wildcard python
    expect(permission("wiki-compiler")).toMatchObject({
      bash: {
        "*": "deny",
        [`python ${pipelineRun} archive-opencode`]: "allow",
        [`python ${pipelineRun} archive-engram`]: "allow",
        [`python ${pipelineRun} archive-all`]: "allow",
        [`python ${pipelineRun} lint`]: "allow",
        [`python ${pipelineRun} primer`]: "allow",
      },
    });

    const wikiBash = wikiPerm.bash as Record<string, unknown>;

    expect(wikiBash).not.toHaveProperty(
      "python *wiki-pipeline/run.py archive-opencode",
    );
    expect(wikiBash).not.toHaveProperty(
      "python *wiki-pipeline/run.py archive-opencode *",
    );
    expect(wikiBash).not.toHaveProperty(
      "python *wiki-pipeline/run.py archive-engram",
    );
    expect(wikiBash).not.toHaveProperty(
      "python *wiki-pipeline/run.py archive-engram *",
    );
    expect(wikiBash).not.toHaveProperty("python -c *");
    expect(wikiBash).not.toHaveProperty("python *run.py*");
    expect(wikiBash).not.toHaveProperty("python *");
    // external_directory, read, edit, glob, grep, list are scoped or denied depending on WIKI_DIR
    if (process.env.WIKI_DIR) {
      const wikiDir = process.env.WIKI_DIR;
      const pipelineRoot = join(getPackageRoot(), "wiki-pipeline");

      const wikiRelative = relative(root, wikiDir).replaceAll("\\", "/");
      const pipelineRelative = relative(root, pipelineRoot).replaceAll("\\", "/");

      expect(wikiPerm).toMatchObject({
        read: { "*": "deny" },
        edit: { "*": "deny" },
        external_directory: { "*": "deny" },
      });

      // read/edit permissions are relative to the OpenCode worktree
      expect(wikiPerm.read).toHaveProperty(wikiRelative, "allow");
      expect(wikiPerm.read).toHaveProperty(`${wikiRelative}/**`, "allow");
      expect(wikiPerm.read).toHaveProperty(pipelineRelative, "allow");
      expect(wikiPerm.read).toHaveProperty(`${pipelineRelative}/**`, "allow");

      expect(wikiPerm.edit).toHaveProperty(wikiRelative, "allow");
      expect(wikiPerm.edit).toHaveProperty(`${wikiRelative}/**`, "allow");

      // external_directory permissions remain absolute
      expect(wikiPerm.external_directory).toHaveProperty(
        `${wikiDir}/**`,
        "allow",
      );
      expect(wikiPerm.external_directory).toHaveProperty(
        `${pipelineRoot}/**`,
        "allow",
      );

      // discovery tools stay disabled
      expect(wikiPerm.glob).toBe("deny");
      expect(wikiPerm.grep).toBe("deny");
      expect(wikiPerm.list).toBe("deny");
    } else {
      expect(wikiPerm).toMatchObject({
        glob: "deny",
        grep: "deny",
        list: "deny",
        read: { "*": "deny" },
        edit: { "*": "deny" },
        bash: { "*": "deny" },
        external_directory: "deny",
      });
    }
  });

  it("enforces the runtime plan ACL per role and action", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const director = (session: string) => toolContext("director", session);
    const reviewer = (session: string) => toolContext("reviewer", session);

    const created = await plan.execute(
      { action: "create", title: "ACL plan", tasks: ["Task"] },
      director("director-create"),
    );
    const planID = planIDOf(outputOf(created));
    const revision = revisionOf(outputOf(created));

    // planner can get, create
    expect(outputOf(await plan.execute({ action: "get" }, planner("planner-get")))).toContain("Plan: ACL plan");
    expect(outputOf(await plan.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "X", tasks: ["T"] },
      planner("planner-replace"),
    ))).toMatch(/may not replace/);
    expect(outputOf(await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID: "T001", status: "completed" },
      planner("planner-update"),
    ))).toMatch(/may not update/);
    expect(outputOf(await plan.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      planner("planner-add"),
    ))).toMatch(/may not add/);
    expect(outputOf(await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: revision, tasks: ["Fix"] },
      planner("planner-remediate"),
    ))).toMatch(/may not remediate/);
    expect(outputOf(await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: revision },
      planner("planner-approve"),
    ))).toMatch(/may not approve/);
    expect(outputOf(await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
      planner("planner-close"),
    ))).toMatch(/may not close/);

    // architect can get, replace
    expect(outputOf(await plan.execute({ action: "get" }, architect("architect-get")))).toContain("Plan: ACL plan");
    const replaced = await plan.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "Architect fix", tasks: ["Task"] },
      architect("architect-replace"),
    );
    expect(outputOf(replaced)).toContain("Architect fix");
    expect(outputOf(await plan.execute(
      { action: "create", title: "Arch", tasks: ["T"] },
      architect("architect-create"),
    ))).toMatch(/may not create/);
    expect(outputOf(await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID: "T001", status: "completed" },
      architect("architect-update"),
    ))).toMatch(/may not update/);
    expect(outputOf(await plan.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      architect("architect-add"),
    ))).toMatch(/may not add/);
    expect(outputOf(await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
      architect("architect-close"),
    ))).toMatch(/may not close/);

    // reviewer can get, but not mutate
    const getOutput = outputOf(await plan.execute({ action: "get" }, reviewer("reviewer-get")));
    expect(getOutput).toContain("Plan: Architect fix");
    expect(outputOf(await plan.execute({ action: "create", title: "R", tasks: ["T"] }, reviewer("reviewer-create")))).toMatch(/may not create/);
    expect(outputOf(await plan.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: revision, title: "R", tasks: ["T"] },
      reviewer("reviewer-replace"),
    ))).toMatch(/may not replace/);
    expect(outputOf(await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: revision, taskID: "T001", status: "completed" },
      reviewer("reviewer-update"),
    ))).toMatch(/may not update/);
    expect(outputOf(await plan.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: revision, tasks: ["Extra"] },
      reviewer("reviewer-add"),
    ))).toMatch(/may not add/);
    expect(outputOf(await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: revision, tasks: ["Fix"] },
      reviewer("reviewer-remediate"),
    ))).toMatch(/may not remediate/);
    expect(outputOf(await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: revision },
      reviewer("reviewer-approve"),
    ))).toMatch(/may not approve/);
    expect(outputOf(await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: revision },
      reviewer("reviewer-close"),
    ))).toMatch(/may not close/);

    expect(outputOf(await plan.execute({ action: "get" }, toolContext("director", "")))).toMatch(/sessionID is required/);
  });

  it("runs planner -> architect -> approve -> implement -> remediate -> review happy path", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const director = (session: string) => toolContext("director", session);

    // 1. planner creates
    const created = await plan.execute(
      { action: "create", title: "Initial plan", tasks: ["Define model", "Build UI", "Review"] },
      planner("planner-create"),
    );
    const createdText = outputOf(created);
    expect(createdText).toContain("Plan: Initial plan");
    expect(createdText).toContain("Approval: pending");
    expect(revisionOf(createdText)).toBe(1);
    const planID = planIDOf(createdText);
    assertPlanOutput(createdText, planID);

    // 2. architect reads and revises
    const architectRead = await plan.execute({ action: "get" }, architect("architect-get"));
    assertPlanOutput(outputOf(architectRead), planID);

    const replaced = await plan.execute(
      {
        action: "replace",
        expectedPlanID: planID,
        expectedRevision: 1,
        title: "Revised plan",
        tasks: ["Define schema", "Build UI", "Review"],
      },
      architect("architect-replace"),
    );
    const replacedText = outputOf(replaced);
    expect(replacedText).toContain("Plan: Revised plan");
    expect(replacedText).toContain("Approval: pending");
    expect(revisionOf(replacedText)).toBe(2);
    assertPlanOutput(replacedText, planID);

    // 3. director reads, presents to user (simulated), user approves
    const directorRead = await plan.execute({ action: "get" }, director("director-read"));
    expect(outputOf(directorRead)).toContain("Plan: Revised plan");
    assertPlanOutput(outputOf(directorRead), planID);

    // 4. director approves
    let currentRevision = 2;
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("director-approve"),
    );
    expect(outputOf(approved)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(approved));

    // 5. implement tasks
    for (const taskID of ["T001", "T002", "T003"] as const) {
      const inProgress = await plan.execute(
        { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID, status: "in_progress" },
        director("director-start"),
      );
      currentRevision = revisionOf(outputOf(inProgress));
      assertPlanOutput(outputOf(inProgress), planID);
      expect(outputOf(inProgress)).toContain(taskID);

      const completed = await plan.execute(
        {
          action: "update",
          expectedPlanID: planID,
          expectedRevision: currentRevision,
          taskID,
          status: "completed",
          evidence: `verified ${taskID}`,
        },
        director("director-complete"),
      );
      currentRevision = revisionOf(outputOf(completed));
      assertPlanOutput(outputOf(completed), planID);
    }

    // 6. close
    const closed = await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: currentRevision },
      director("director-close"),
    );
    const closedText = outputOf(closed);
    expect(closedText).toMatch(/Archived to/);
    assertPlanOutput(closedText, planID);
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8").catch(() => "")).toBe("");
  });

  it("scopes the shared plan to the worktree instead of a nested directory", async () => {
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Worktree plan", tasks: ["Task"] },
      toolContext("director", "session"),
    );
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8")).toContain("Worktree plan");
  });

  it("rejects stale plan id and revision on mutations", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Stale test", tasks: ["Task"] },
      director("director-create"),
    );
    const planID = planIDOf(outputOf(created));
    const initialRevision = revisionOf(outputOf(created));

    const wrongID = await plan.execute(
      {
        action: "update",
        expectedPlanID: "00000000-0000-1000-8000-000000000000",
        expectedRevision: initialRevision,
        taskID: "T001",
        status: "completed",
      },
      director("director-wrong-id"),
    );
    expect(outputOf(wrongID)).toMatch(/plan id conflict/);
    expect(titleOf(wrongID)).toBe("Error");

    // approve first, then update
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: initialRevision },
      director("director-approve"),
    );
    const approvedRevision = revisionOf(outputOf(approved));

    const advanced = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: approvedRevision, taskID: "T001", status: "completed", evidence: "done" },
      director("director-advance"),
    );
    const advancedRevision = revisionOf(outputOf(advanced));

    const staleRevision = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: approvedRevision, taskID: "T001", status: "in_progress" },
      director("director-stale"),
    );
    expect(outputOf(staleRevision)).toMatch(/revision conflict/);
    expect(titleOf(staleRevision)).toBe("Error");
    expect(advancedRevision).toBe(approvedRevision + 1);
  });

  it("replaces the plan title and tasks through the architect", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);

    const created = await plan.execute(
      { action: "create", title: "Old title", tasks: ["Old task"] },
      planner("planner-create"),
    );
    const planID = planIDOf(outputOf(created));
    const initialRevision = revisionOf(outputOf(created));

    const replaced = await plan.execute(
      {
        action: "replace",
        expectedPlanID: planID,
        expectedRevision: initialRevision,
        title: "New titled plan",
        tasks: ["New task A", "New task B"],
      },
      architect("architect-replace"),
    );
    const replacedText = outputOf(replaced);
    expect(replacedText).toContain("Plan: New titled plan");
    expect(replacedText).toContain("New task A");
    expect(replacedText).toContain("New task B");
    expect(replacedText).toContain("Approval: pending");
    expect(replacedText).not.toContain("Old title");
    expect(replacedText).not.toContain("Old task");
    expect(revisionOf(replacedText)).toBe(initialRevision + 1);
    assertPlanOutput(replacedText, planID);
  });

  it("uses readable titles for plan actions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Dashboard", tasks: ["Build UI"] },
      planner("planner-create"),
    );
    expect(titleOf(created)).toBe("Create plan · Dashboard");
    const planID = planIDOf(outputOf(created));
    const initialRevision = revisionOf(outputOf(created));

    const checked = await plan.execute({ action: "get" }, director("director-get"));
    expect(titleOf(checked)).toBe("Check active plan");

    const replaced = await plan.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: initialRevision, title: "Dashboard v2", tasks: ["Build UI"] },
      architect("architect-replace"),
    );
    expect(titleOf(replaced)).toBe("Replace plan · Dashboard v2");

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: initialRevision + 1 },
      director("director-approve"),
    );
    expect(titleOf(approved)).toBe("Approve plan");

    const updated = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: initialRevision + 2, taskID: "T001", status: "in_progress" },
      director("director-update"),
    );
    expect(titleOf(updated)).toBe("Mark T001 in progress");
  });

  it("add on approved plan resets approval to pending", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Add gate", tasks: ["Task"] },
      director("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("approve"),
    );
    expect(outputOf(approved)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(approved));

    const added = await plan.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["New scope"] },
      director("add"),
    );
    expect(outputOf(added)).toContain("Approval: pending");
    currentRevision = revisionOf(outputOf(added));

    // cannot update until re-approved
    const blocked = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "in_progress" },
      director("update"),
    );
    expect(outputOf(blocked)).toMatch(/must be approved/);

    // re-approve
    const reApproved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("re-approve"),
    );
    expect(outputOf(reApproved)).toContain("Approval: approved");
  });

  it("remediate preserves approved state", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate", tasks: ["Task"] },
      director("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));

    const completed = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "completed", evidence: "done" },
      director("complete"),
    );
    currentRevision = revisionOf(outputOf(completed));

    const remediated = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix bug"] },
      director("remediate"),
    );
    expect(outputOf(remediated)).toContain("Approval: approved");
    expect(outputOf(remediated)).toContain("Fix bug");
  });

  it("remediate rejects unapproved plan and incomplete tasks", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate guards", tasks: ["A", "B"] },
      director("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    // unapproved
    const unapproved = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix"] },
      director("remediate-unapproved"),
    );
    expect(outputOf(unapproved)).toMatch(/must be approved/);

    // approved but incomplete
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));
    const incomplete = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix"] },
      director("remediate-incomplete"),
    );
    expect(outputOf(incomplete)).toMatch(/All existing tasks must be completed/);
  });

  it("remediates the plan through the director after review", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const director = (session: string) => toolContext("director", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate flow", tasks: ["Task"] },
      director("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      director("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));

    const completed = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "completed", evidence: "done" },
      director("complete"),
    );
    currentRevision = revisionOf(outputOf(completed));

    // remediation
    const remediated = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix blocking issue"] },
      director("remediate"),
    );
    expect(outputOf(remediated)).toContain("Fix blocking issue");
    expect(outputOf(remediated)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(remediated));

    const fixDone = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T002", status: "completed", evidence: "verified fix" },
      director("complete-fix"),
    );
    currentRevision = revisionOf(outputOf(fixDone));

    // close
    const closed = await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: currentRevision },
      director("close"),
    );
    expect(outputOf(closed)).toMatch(/Archived to/);
  });
});