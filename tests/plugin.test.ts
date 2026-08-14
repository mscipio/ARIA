import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import ariaPlugin, { ariaPlugin as pluginModule } from "../src/index";
import { getPackageRoot } from "../src/defaults";

const server = pluginModule.server;
const tempDirs: string[] = [];
const plugins: Array<Awaited<ReturnType<typeof server>>> = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aria-plugin-"));
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

describe("ariaPlugin", () => {
  it("exports the OpenCode npm plugin shape", () => {
    expect(ariaPlugin).toMatchObject({ id: "aria", server });
    expect(typeof server).toBe("function");
  });

  it("registers exactly eleven agents and the plan tool", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);

    expect(Object.keys(config.agent ?? {})).toEqual([
      "coder",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
      "writer",
      "scientist",
    ]);
    expect(config.agent?.coder?.mode).toBe("all");
    expect(config.agent?.planner?.model).toBe("openai/gpt-5.6-terra");
    expect(config.agent?.planner?.mode).toBe("subagent");
    expect(config.agent?.architect?.mode).toBe("subagent");
    expect(config.agent?.researcher?.mode).toBe("all");
    expect(config.agent?.researcher?.model).toBe("openai/gpt-5.6-sol");
    expect(config.agent?.researcher?.variant).toBe("medium");
    expect(config.agent?.["archivist"]?.mode).toBe("all");
    expect(config.agent?.writer?.mode).toBe("all");
    expect(config.agent?.scientist?.mode).toBe("all");
    expect(config.agent?.scientist?.model).toBe("openai/gpt-5.6-sol");
    expect(config.agent?.scientist?.variant).toBe("medium");
    expect(config.agent?.researcher?.description).toBe(
      "Direct or delegated specialist for external literature and evidence research.",
    );
    expect(config.agent?.scientist?.description).toBe(
      "Scientific authority for question specification and result interpretation; delegates evidence to researcher, prose to writer, and computation to coder.",
    );
    const extendedConfig = config as Config & { skills?: { paths?: string[] } };
    expect(extendedConfig.skills?.paths).toContain(join(getPackageRoot(), "skills"));
    expect(config.agent?.tester).toBeUndefined();
    expect(config.command).toBeUndefined();
    expect(Object.keys(plugin.tool ?? {})).toEqual(["plan"]);
    expect(plugin.event).toBeUndefined();
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
    expect(plugin["experimental.session.compacting"]).toBeUndefined();
  });


  it("preserves existing skill paths", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config = {
      skills: { paths: ["/custom/skills"] },
    } as Config & { skills?: { paths?: string[] } };
    await plugin.config?.(config);

    expect(config.skills?.paths).toEqual(["/custom/skills", join(getPackageRoot(), "skills")]);
  });

  it("declares plan permissions with approve, remediate, and reviewer get", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;

    expect(permission("coder")).toMatchObject({
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
        researcher: "allow",
        "archivist": "allow",
        scientist: "allow",
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
    // writer is writing-only with read access, narrow Wiki delegation, and
    // evidence-only researcher delegation plus scientist handoff
    expect(permission("writer")).toMatchObject({
      edit: "deny",
      bash: "deny",
      glob: "deny",
      grep: "deny",
      list: "deny",
      task: {
        "*": "deny",
        "archivist": "allow",
        "researcher": "allow",
        "scientist": "allow",
      },
      plan: "deny",
      read: { "*": "allow", "*.env": "deny" },
    });
    expect(permission("writer")).not.toHaveProperty("engram_*");
    expect(permission("writer")).not.toHaveProperty("codegraph_*");
    expect(permission("writer")).not.toHaveProperty("context7_*");
    expect(permission("explorer")).toMatchObject({
      skill: { "*": "deny", "rdc-code-exploration": "allow" },
    });
    expect(permission("planner")).toMatchObject({
      skill: {
        "*": "deny",
        "rdc-implementation-planning": "allow",
        "rdc-testing-discipline": "allow",
      },
    });
    expect(permission("architect")).toMatchObject({
      skill: {
        "*": "deny",
        "rdc-plan-review": "allow",
        "rdc-scope-assessment": "allow",
        "rdc-testing-discipline": "allow",
      },
    });
    expect(permission("implementer")).toMatchObject({
      skill: { "*": "deny", "rdc-code-implementation": "allow", "rdc-testing-discipline": "allow" },
    });
    expect(permission("reviewer")).toMatchObject({
      skill: { "*": "deny", "rdc-implementation-review": "allow", "rdc-testing-discipline": "allow" },
    });
    expect(permission("writer")).toMatchObject({
      skill: {
        "*": "deny",
        "aria-academic-writing": "allow",
        "aria-writing-anti-ai": "allow",
        "aria-review-response": "allow",
        "aria-paper-self-review": "allow",
        "aria-document-design": "allow",
      },
    });
    // aria-document-design stays writer-only: no other role grants it.
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "researcher", "archivist", "scientist"]) {
      expect(permission(role)?.skill ?? {}).not.toHaveProperty("aria-document-design");
    }
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"]) {
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
    for (const role of ["explorer", "visualizer", "implementer", "reviewer", "archivist"]) {
      expect(permission(role)).toMatchObject({ task: "deny" });
    }
    // archivist: genuinely deny-by-default with scoped access only when WIKI_DIR is set
    const wikiPerm = permission("archivist");
    expect(wikiPerm).toMatchObject({
      "*": "deny",
      plan: "deny",
      task: "deny",
      skill: {
        "*": "deny",
        "aria-wiki-lookup": "allow",
        "aria-wiki-archive": "allow",
        "aria-wiki-compile": "allow",
      },
    });
    // MCP: no Engram, CodeGraph, or Context7 access ? archivist
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
    const wikiBash = wikiPerm.bash as Record<string, unknown>;
    if (process.env.WIKI_DIR) {
      const pipelineRun = `${getPackageRoot()}/wiki-pipeline/run.py`;
      expect(wikiBash).toMatchObject({
        "*": "deny",
        [`python ${pipelineRun} archive-opencode`]: "allow",
        [`python ${pipelineRun} archive-engram`]: "allow",
        [`python ${pipelineRun} archive-all`]: "allow",
        [`python ${pipelineRun} lint`]: "allow",
        [`python ${pipelineRun} primer`]: "allow",
      });
    }

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

  it("registers researcher with research-only ZotPilot MCP access and approval-gated mutations", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;
    const researcher = permission("researcher");

    // Research-only base: read/navigation and web evidence allowed; every
    // mutation, delegation, plan, and external-directory surface denied.
    expect(researcher.edit).toBe("deny");
    expect(researcher.task).toEqual({ "*": "deny", scientist: "allow" });
    expect(researcher.plan).toBe("deny");
    expect(researcher.external_directory).toBe("deny");
    expect(researcher.todowrite).toBe("deny");
    expect(researcher.webfetch).toBe("allow");
    expect(researcher.websearch).toBe("allow");
    expect(researcher.glob).toBe("allow");
    expect(researcher.grep).toBe("allow");
    expect(researcher.list).toBe("allow");
    expect(researcher.lsp).toBe("deny");
    expect(researcher.read).toMatchObject({ "*": "allow", "*.env": "deny", "*.env.example": "allow" });
    expect(researcher.skill).toEqual({ "*": "deny", "aria-research-evidence": "allow" });

    // Context7 only; no Engram, CodeGraph, Wiki, or wildcard MCP authority.
    expect(researcher["context7_*"]).toBe("allow");
    expect(researcher).not.toHaveProperty("engram_*");
    expect(researcher).not.toHaveProperty("codegraph_*");
    expect(researcher).not.toHaveProperty("engram_mem_search");
    expect(researcher).not.toHaveProperty("engram_mem_save");
    expect(researcher).not.toHaveProperty("engram_mem_context");
    expect(researcher).not.toHaveProperty("codegraph_codegraph_explore");

    // Verified ZotPilot research/read MCP tools (zotpilot 0.5.3 live
    // tools/list inventory): allowed directly.
    for (const tool of [
      "search_papers",
      "search_topic",
      "search_boolean",
      "search_formulas",
      "advanced_search",
      "search_academic_databases",
      "browse_library",
      "get_paper_details",
      "get_notes",
      "get_annotations",
      "get_citations",
      "get_passage_context",
      "get_index_stats",
      "get_paper_for_tutor",
    ]) {
      expect(researcher[`zotpilot_${tool}`]).toBe("allow");
    }

    // Verified ZotPilot mutation tools: approval-gated, never allowed.
    for (const tool of [
      "index_library",
      "index_formulas",
      "ingest_by_identifiers",
      "create_note",
      "manage_tags",
      "manage_collections",
      "annotate_pdf",
      "save_reading_persona",
    ]) {
      expect(researcher[`zotpilot_${tool}`]).toBe("ask");
    }

    // No broad or wildcard ZotPilot grant; tools outside the verified
    // inventory fall back to the base `*` deny.
    expect(researcher).not.toHaveProperty("zotpilot_*");
    expect(researcher).not.toHaveProperty("zotpilot_search_tables");
    expect(researcher).not.toHaveProperty("zotpilot_search_figures");
    expect(researcher).not.toHaveProperty("zotpilot_manage_library");

    // Bash deny-by-default: only the zotpilot executable family is
    // approval-gated as a fallback path; nothing is allowed and unrelated
    // shell commands stay denied.
    expect(researcher.bash).toMatchObject({
      "*": "deny",
      "zotpilot": "ask",
      "zotpilot *": "ask",
    });
    const researcherBash = researcher.bash as Record<string, unknown>;
    expect(Object.keys(researcherBash).sort()).toEqual(["*", "zotpilot", "zotpilot *"]);
    expect(researcherBash).not.toHaveProperty("zotpilot **");
    expect(researcherBash).not.toHaveProperty("zotpilot*");
    expect(researcherBash).not.toHaveProperty("python *");
    expect(researcherBash).not.toHaveProperty("npm *");
    expect(researcherBash).not.toHaveProperty("ls");
  });

  it("grants scientist only bounded tool and skill authority", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;
    const scientist = permission("scientist");

    // Read-only navigation tools plus deny-by-default mutation surfaces.
    expect(scientist).toMatchObject({
      edit: "deny",
      bash: "deny",
      plan: "deny",
      external_directory: "deny",
      todowrite: "deny",
      question: "deny",
      webfetch: "deny",
      websearch: "deny",
      lsp: "deny",
      glob: "allow",
      grep: "allow",
      list: "allow",
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
      skill: {
        "*": "deny",
        "aria-research-planning": "allow",
        "aria-results-analysis": "allow",
      },
      task: { "*": "deny", researcher: "allow", writer: "allow", coder: "allow" },
    });
    // No MCP or persistence authority of any kind.
    expect(scientist).not.toHaveProperty("engram_*");
    expect(scientist).not.toHaveProperty("context7_*");
    expect(scientist).not.toHaveProperty("codegraph_*");
    expect(scientist).not.toHaveProperty("zotpilot_*");
    expect(scientist).not.toHaveProperty("engram_mem_save");
  });

  it("binds scientist cooperation to exactly six task edges and keeps coder's six specialist edges", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;
    const taskMap = (role: string) => permission(role).task as Record<string, unknown>;

    // Scientist outbound: exactly researcher, writer, coder.
    expect(taskMap("scientist")).toEqual({
      "*": "deny",
      researcher: "allow",
      writer: "allow",
      coder: "allow",
    });

    // Scientist inbound: exactly coder, researcher, writer.
    expect(taskMap("coder").scientist).toBe("allow");
    expect(taskMap("researcher")).toEqual({ "*": "deny", scientist: "allow" });
    expect(taskMap("writer").scientist).toBe("allow");

    // No other role delegates to scientist: no all-to-all durable-role graph.
    for (const role of ["explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "archivist"]) {
      expect(permission(role).task).toBe("deny");
    }

    // Coder retains its six RDC specialist targets.
    const coderTask = taskMap("coder");
    expect(coderTask["*"]).toBe("deny");
    for (const target of ["explorer", "visualizer", "planner", "architect", "implementer", "reviewer"]) {
      expect(coderTask[target]).toBe("allow");
    }
  });

  it("enforces the runtime plan ACL per role and action", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const coder = (session: string) => toolContext("coder", session);
    const reviewer = (session: string) => toolContext("reviewer", session);

    const created = await plan.execute(
      { action: "create", title: "ACL plan", tasks: ["Task"] },
      coder("coder-create"),
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

    // researcher has no plan access at all
    expect(outputOf(await plan.execute({ action: "get" }, toolContext("researcher", "researcher-get")))).toMatch(/may not get/);

    expect(outputOf(await plan.execute({ action: "get" }, toolContext("coder", "")))).toMatch(/sessionID is required/);
  });

  it("runs planner -> architect -> approve -> implement -> remediate -> review happy path", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session);
    const architect = (session: string) => toolContext("architect", session);
    const coder = (session: string) => toolContext("coder", session);

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

    // 3. coder reads, presents to user (simulated), user approves
    const coderRead = await plan.execute({ action: "get" }, coder("coder-read"));
    expect(outputOf(coderRead)).toContain("Plan: Revised plan");
    assertPlanOutput(outputOf(coderRead), planID);

    // 4. coder approves
    let currentRevision = 2;
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("coder-approve"),
    );
    expect(outputOf(approved)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(approved));

    // 5. implement tasks
    for (const taskID of ["T001", "T002", "T003"] as const) {
      const inProgress = await plan.execute(
        { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID, status: "in_progress" },
        coder("coder-start"),
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
        coder("coder-complete"),
      );
      currentRevision = revisionOf(outputOf(completed));
      assertPlanOutput(outputOf(completed), planID);
    }

    // 6. close
    const closed = await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("coder-close"),
    );
    const closedText = outputOf(closed);
    expect(closedText).toMatch(/Archived to/);
    assertPlanOutput(closedText, planID);
    expect(await readFile(join(root, ".aria/rdc", "TASKS.md"), "utf8").catch(() => "")).toBe("");
  });

  it("scopes the shared plan to the worktree instead of a nested directory", async () => {
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Worktree plan", tasks: ["Task"] },
      toolContext("coder", "session"),
    );
    expect(await readFile(join(root, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Worktree plan");
  });

  it("rejects stale plan id and revision on mutations", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Stale test", tasks: ["Task"] },
      coder("coder-create"),
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
      coder("coder-wrong-id"),
    );
    expect(outputOf(wrongID)).toMatch(/plan id conflict/);
    expect(titleOf(wrongID)).toBe("Error");

    // approve first, then update
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: initialRevision },
      coder("coder-approve"),
    );
    const approvedRevision = revisionOf(outputOf(approved));

    const advanced = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: approvedRevision, taskID: "T001", status: "completed", evidence: "done" },
      coder("coder-advance"),
    );
    const advancedRevision = revisionOf(outputOf(advanced));

    const staleRevision = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: approvedRevision, taskID: "T001", status: "in_progress" },
      coder("coder-stale"),
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
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Dashboard", tasks: ["Build UI"] },
      planner("planner-create"),
    );
    expect(titleOf(created)).toBe("Create plan · Dashboard");
    const planID = planIDOf(outputOf(created));
    const initialRevision = revisionOf(outputOf(created));

    const checked = await plan.execute({ action: "get" }, coder("coder-get"));
    expect(titleOf(checked)).toBe("Check active plan");

    const replaced = await plan.execute(
      { action: "replace", expectedPlanID: planID, expectedRevision: initialRevision, title: "Dashboard v2", tasks: ["Build UI"] },
      architect("architect-replace"),
    );
    expect(titleOf(replaced)).toBe("Replace plan · Dashboard v2");

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: initialRevision + 1 },
      coder("coder-approve"),
    );
    expect(titleOf(approved)).toBe("Approve plan");

    const updated = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: initialRevision + 2, taskID: "T001", status: "in_progress" },
      coder("coder-update"),
    );
    expect(titleOf(updated)).toBe("Mark T001 in progress");
  });

  it("add on approved plan resets approval to pending", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Add gate", tasks: ["Task"] },
      coder("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("approve"),
    );
    expect(outputOf(approved)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(approved));

    const added = await plan.execute(
      { action: "add", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["New scope"] },
      coder("add"),
    );
    expect(outputOf(added)).toContain("Approval: pending");
    currentRevision = revisionOf(outputOf(added));

    // cannot update until re-approved
    const blocked = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "in_progress" },
      coder("update"),
    );
    expect(outputOf(blocked)).toMatch(/must be approved/);

    // re-approve
    const reApproved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("re-approve"),
    );
    expect(outputOf(reApproved)).toContain("Approval: approved");
  });

  it("remediate preserves approved state", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate", tasks: ["Task"] },
      coder("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));

    const completed = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "completed", evidence: "done" },
      coder("complete"),
    );
    currentRevision = revisionOf(outputOf(completed));

    const remediated = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix bug"] },
      coder("remediate"),
    );
    expect(outputOf(remediated)).toContain("Approval: approved");
    expect(outputOf(remediated)).toContain("Fix bug");
  });

  it("remediate rejects unapproved plan and incomplete tasks", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate guards", tasks: ["A", "B"] },
      coder("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    // unapproved
    const unapproved = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix"] },
      coder("remediate-unapproved"),
    );
    expect(outputOf(unapproved)).toMatch(/must be approved/);

    // approved but incomplete
    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));
    const incomplete = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix"] },
      coder("remediate-incomplete"),
    );
    expect(outputOf(incomplete)).toMatch(/All existing tasks must be completed/);
  });

  it("remediates the plan through the coder after review", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session);

    const created = await plan.execute(
      { action: "create", title: "Remediate flow", tasks: ["Task"] },
      coder("create"),
    );
    let currentRevision = revisionOf(outputOf(created));
    const planID = planIDOf(outputOf(created));

    const approved = await plan.execute(
      { action: "approve", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("approve"),
    );
    currentRevision = revisionOf(outputOf(approved));

    const completed = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T001", status: "completed", evidence: "done" },
      coder("complete"),
    );
    currentRevision = revisionOf(outputOf(completed));

    // remediation
    const remediated = await plan.execute(
      { action: "remediate", expectedPlanID: planID, expectedRevision: currentRevision, tasks: ["Fix blocking issue"] },
      coder("remediate"),
    );
    expect(outputOf(remediated)).toContain("Fix blocking issue");
    expect(outputOf(remediated)).toContain("Approval: approved");
    currentRevision = revisionOf(outputOf(remediated));

    const fixDone = await plan.execute(
      { action: "update", expectedPlanID: planID, expectedRevision: currentRevision, taskID: "T002", status: "completed", evidence: "verified fix" },
      coder("complete-fix"),
    );
    currentRevision = revisionOf(outputOf(fixDone));

    // close
    const closed = await plan.execute(
      { action: "close", expectedPlanID: planID, expectedRevision: currentRevision },
      coder("close"),
    );
    expect(outputOf(closed)).toMatch(/Archived to/);
  });
});

describe("ariaPlugin config hook depth", () => {
  type HookConfig = Config & {
    skills?: { paths?: string[] };
    subagent_depth?: number | null;
  };

  it("applies subagent_depth 3 only when absent or nullish", async () => {
    const absent: HookConfig = {};
    const plugin = await load({ directory: await project() } as never);
    await plugin.config?.(absent);
    expect(absent.subagent_depth).toBe(3);

    const undefinedDepth: HookConfig = { subagent_depth: undefined };
    await plugin.config?.(undefinedDepth);
    expect(undefinedDepth.subagent_depth).toBe(3);

    const nullDepth: HookConfig = { subagent_depth: null };
    await plugin.config?.(nullDepth);
    expect(nullDepth.subagent_depth).toBe(3);
  });

  it("preserves explicit shallow depths 0, 1, and 2", async () => {
    for (const depth of [0, 1, 2] as const) {
      const plugin = await load({ directory: await project() } as never);
      const config: HookConfig = { subagent_depth: depth };
      await plugin.config?.(config);
      expect(config.subagent_depth).toBe(depth);
    }
  });

  it("preserves explicit depths of 3 and above", async () => {
    for (const depth of [3, 5] as const) {
      const plugin = await load({ directory: await project() } as never);
      const config: HookConfig = { subagent_depth: depth };
      await plugin.config?.(config);
      expect(config.subagent_depth).toBe(depth);
    }
  });
});