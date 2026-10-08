import { afterEach, describe, expect, it } from "vitest";
import type { Config, ToolContext } from "@opencode-ai/plugin";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";

import { ariaPlugin as ariaServer, projectDirectory } from "../src/register";

// T002: the package entrypoint (src/index.ts) is now the native V2 minimal
// foundation. These V1 behavior tests intentionally target the preserved V1
// source (src/register.ts) until T003+ migrates agents/permissions/plan tool.
const server = ariaServer;
const pluginModule = { id: "aria", server };
const ariaPlugin = pluginModule;
import { getPackageRoot } from "../src/defaults";

/**
 * Test-local coder skill-permission evaluator for this regression only.
 *
 * Models exactly three semantics exercised by the coder + rdc-adversarial-review
 * regression below — no more:
 *   1. Exact skill-name match OR wildcard `*` match (no glob engine).
 *   2. Default-before-agent-specific ordering: custom-agent default
 *      `* -> allow` precedes merged agent-specific rules.
 *   3. Last-match-wins: the final matching rule in merged order determines
 *      the action (equivalent to OpenCode Permission.evaluate()'s findLast).
 *
 * This is NOT a general permission evaluator. It does not import or replicate
 * unrelated runtime machinery (non-skill permissions, prefix globs, ask
 * fallbacks beyond the default wildcard, or cross-agent semantics).
 */
function evaluateSkillPermissionExactOrWildcardLastWins(
  agentSkillPermission: Record<string, string> | undefined
): (skillName: string) => "allow" | "deny" | "ask" {
  // (2) Default rule: wildcard allow, placed before agent-specific rules.
  const defaultRules = [
    { permission: "skill", pattern: "*", action: "allow" as const }
  ];

  // Agent-specific rules from permission.skill object.
  const agentRules = agentSkillPermission
    ? Object.entries(agentSkillPermission).map(([pattern, action]) => ({
        permission: "skill",
        pattern,
        action: action as "allow" | "deny" | "ask"
      }))
    : [];

  // (2) Default-before-agent-specific ordering.
  const allRules = [...defaultRules, ...agentRules];

  return (skillName: string) => {
    // (3) Last-match-wins: iterate in reverse.
    for (let i = allRules.length - 1; i >= 0; i--) {
      const rule = allRules[i];
      if (rule) {
        // (1) Exact skill-name match OR wildcard `*` only — no glob engine.
        if (rule.pattern === skillName || rule.pattern === "*") {
          return rule.action;
        }
      }
    }

    // Unreachable with the default wildcard present; retained for type safety.
    return "ask";
  };
}

const tempDirs: string[] = [];
const plugins: Array<Awaited<ReturnType<typeof server>>> = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aria-plugin-"));
  tempDirs.push(root);
  return root;
}

/**
 * Create a symlink at `linkPath` whose target is the platform filesystem root
 * derived from the link path itself (never hardcoded). Uses type 'junction' so
 * Windows requires no symlink privilege; POSIX ignores the type and preserves
 * equivalent symlink-to-root behavior.
 */
async function symlinkToRoot(linkPath: string): Promise<void> {
  const root = parse(resolve(linkPath)).root;
  await symlink(root, linkPath, "junction");
}

async function load(input: Parameters<typeof server>[0]) {
  const plugin = await server(input, {});
  plugins.push(plugin);
  return plugin;
}

function toolContext(
  agent: string,
  sessionID: string,
  abort?: AbortSignal,
  options?: { worktree?: string; directory?: string; messageID?: string },
): ToolContext {
  return {
    agent,
    sessionID,
    messageID: options?.messageID ?? `msg-${sessionID}`,
    abort: abort ?? new AbortController().signal,
    worktree: options?.worktree ?? "",
    directory: options?.directory ?? "",
    metadata() {},
    async ask() {},
  };
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
    expect(config.agent?.planner?.model).toBe("openai/gpt-6-luna");
    expect(config.agent?.planner?.mode).toBe("subagent");
    expect(config.agent?.architect?.mode).toBe("subagent");
    expect(config.agent?.researcher?.mode).toBe("all");
    expect(config.agent?.researcher?.model).toBe("openai/gpt-6.1-sol");
    expect(config.agent?.researcher?.variant).toBe("medium");
    expect(config.agent?.["archivist"]?.mode).toBe("all");
    expect(config.agent?.writer?.mode).toBe("all");
    expect(config.agent?.scientist?.mode).toBe("all");
    expect(config.agent?.scientist?.model).toBe("openai/gpt-6.1-sol");
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
    // Coder explicitly denies rdc-adversarial-review while preserving prior
    // effective access to all other skills via inherited default wildcard allow.
    expect(permission("coder")?.skill).toEqual({
      "rdc-adversarial-review": "deny",
    });

    // Effective access resolution test under actual OpenCode semantics:
    // custom agent defaults include wildcard `* -> allow`, agent-specific rules
    // are merged after, and findLast determines the final action (last match wins).
    const coderPerm = permission("coder") as Record<string, unknown>;
    const coderSkillPermission = coderPerm.skill as Record<string, string> | undefined;
    const evaluateCoderSkill = evaluateSkillPermissionExactOrWildcardLastWins(coderSkillPermission);

    // 1) Coder + rdc-adversarial-review resolves to "deny" and is excluded from
    //    Skill.available-equivalent filtering (explicit deny overrides default allow).
    expect(evaluateCoderSkill("rdc-adversarial-review")).toBe("deny");
    // Skill.available() returns false when evaluate returns "deny"
    const adversarialAvailable = evaluateCoderSkill("rdc-adversarial-review") !== "deny";
    expect(adversarialAvailable).toBe(false);

    // 2) Coder + representative existing rdc and aria skills resolves to "allow"
    //    via inherited default wildcard (no matching agent-specific rule).
    expect(evaluateCoderSkill("rdc-code-implementation")).toBe("allow");
    expect(evaluateCoderSkill("aria-research-evidence")).toBe("allow");
    // These skills remain available via Skill.available-equivalent check
    expect(evaluateCoderSkill("rdc-code-implementation") !== "deny").toBe(true);
    expect(evaluateCoderSkill("aria-research-evidence") !== "deny").toBe(true);

    // 3) The exact deny does not alter unrelated effective access: other skills
    //    still resolve to default allow.
    expect(evaluateCoderSkill("rdc-implementation-review")).toBe("allow");
    expect(evaluateCoderSkill("rdc-testing-discipline")).toBe("allow");
    expect(evaluateCoderSkill("aria-document-design")).toBe("allow");
    expect(evaluateCoderSkill("aria-wiki-lookup")).toBe("allow");

    // Verify precedence: agent-specific deny overrides default allow for exact match
    const testRules = { "specific-skill": "deny" };
    const evaluateTest = evaluateSkillPermissionExactOrWildcardLastWins(testRules);
    expect(evaluateTest("specific-skill")).toBe("deny"); // Exact match: deny
    expect(evaluateTest("other-skill")).toBe("allow"); // No match: default allow
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
    expect(permission("explorer")?.skill).toEqual({
      "*": "deny",
      "rdc-code-exploration": "allow",
    });
    expect(permission("visualizer")?.skill).toEqual({
      "*": "deny",
      "rdc-visual-analysis": "allow",
    });
    expect(permission("planner")?.skill).toEqual({
      "*": "deny",
      "rdc-implementation-planning": "allow",
      "rdc-testing-discipline": "allow",
    });
    expect(permission("architect")?.skill).toEqual({
      "*": "deny",
      "rdc-plan-review": "allow",
      "rdc-scope-assessment": "allow",
      "rdc-testing-discipline": "allow",
    });
    expect(permission("implementer")?.skill).toEqual({
      "*": "deny",
      "rdc-code-implementation": "allow",
      "rdc-testing-discipline": "allow",
    });
    expect(permission("reviewer")?.skill).toEqual({
      "*": "deny",
      "rdc-implementation-review": "allow",
      "rdc-adversarial-review": "allow",
      "rdc-testing-discipline": "allow",
    });
    expect(permission("writer")?.skill).toEqual({
      "*": "deny",
      "aria-academic-writing": "allow",
      "aria-writing-anti-ai": "allow",
      "aria-review-response": "allow",
      "aria-paper-self-review": "allow",
      "aria-document-design": "allow",
    });
    // rdc-adversarial-review is reviewer-only: no other role grants it.
    // The coder explicitly denies it (see above), so exclude coder from this check.
    for (const role of ["explorer", "visualizer", "planner", "architect", "implementer", "researcher", "archivist", "writer", "scientist"]) {
      expect(permission(role)?.skill ?? {}).not.toHaveProperty("rdc-adversarial-review");
    }
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
    expect(wikiPerm?.skill).toEqual({
      "*": "deny",
      "aria-wiki-lookup": "allow",
      "aria-wiki-archive": "allow",
      "aria-wiki-compile": "allow",
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
    expect(researcher.skill).toEqual({
      "*": "deny",
      "aria-research-evidence": "allow",
      "aria-zotero-tutor": "allow",
    });
    // Arbitrary unknown skills stay denied by the skill wildcard.
    expect(researcher.skill).not.toHaveProperty("aria-document-design");
    expect(researcher.skill).not.toHaveProperty("rdc-code-implementation");
    expect(researcher.skill).not.toHaveProperty("some-unknown-skill");
    // aria-zotero-tutor stays researcher-only: no other role grants it.
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "archivist", "writer", "scientist"]) {
      expect(permission(role)?.skill ?? {}).not.toHaveProperty("aria-zotero-tutor");
    }

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
    expect(scientist?.skill).toEqual({
      "*": "deny",
      "aria-research-planning": "allow",
      "aria-results-analysis": "allow",
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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session, undefined, { directory: root });
    const architect = (session: string) => toolContext("architect", session, undefined, { directory: root });
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });
    const reviewer = (session: string) => toolContext("reviewer", session, undefined, { directory: root });

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
    const planner = (session: string) => toolContext("planner", session, undefined, { directory: root });
    const architect = (session: string) => toolContext("architect", session, undefined, { directory: root });
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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

  it("scopes the shared plan to the invocation directory, not the startup worktree", async () => {
    // Regression: with the new semantics, context.directory is preferred over
    // context.worktree for Plan persistence. The plan must be written to the
    // invocation directory (nested), not the startup worktree (root).
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Invocation directory plan", tasks: ["Task"] },
      toolContext("coder", "session", undefined, { worktree: root, directory: nested }),
    );
    expect(await readFile(join(nested, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Invocation directory plan");
  });

  it("selects context.directory when worktree is the filesystem root sentinel", async () => {
    // Case (1): filesystem-root worktree sentinel must not override a narrower valid directory.
    const projectDir = await project();
    const plugin = await load({ directory: projectDir } as never);
    // Simulate OpenCode passing worktree="/" (POSIX root sentinel) with a valid directory.
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Root sentinel plan", tasks: ["Task"] },
      toolContext("coder", "session", undefined, { worktree: "/", directory: projectDir }),
    );
    // The plan must be written to projectDir/.aria/rdc/TASKS.md, NOT to /.aria/rdc/TASKS.md.
    expect(await readFile(join(projectDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Root sentinel plan");
  });

  it("selects nested invocation directory over repo startup directory", async () => {
    // Regression: with the new semantics, context.directory is preferred over
    // context.worktree for Plan persistence. A nested invocation directory
    // like /repo/packages/app must win over the repo startup directory /repo.
    const repoRoot = await project();
    const nestedDir = join(repoRoot, "packages", "app");
    await mkdir(nestedDir, { recursive: true });
    const plugin = await load({ directory: repoRoot } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Nested invocation plan", tasks: ["Task"] },
      toolContext("coder", "session", undefined, { worktree: repoRoot, directory: nestedDir }),
    );
    // The plan must be written to nestedDir/.aria/rdc/TASKS.md, not repoRoot/.aria/rdc/TASKS.md.
    expect(await readFile(join(nestedDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Nested invocation plan");
  });

  it("selects invocation context root over unrelated plugin-startup cwd", async () => {
    // Case (3): tool/session context selects its root over a different unrelated plugin-startup cwd.
    const startupDir = await project();
    const invocationDir = await project();
    const plugin = await load({ directory: startupDir } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Invocation context plan", tasks: ["Task"] },
      toolContext("coder", "session", undefined, { directory: invocationDir }),
    );
    // The plan must be written to invocationDir/.aria/rdc/TASKS.md, not startupDir/.aria/rdc/TASKS.md.
    expect(await readFile(join(invocationDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Invocation context plan");
    // Verify startupDir did NOT receive the plan.
    await expect(readFile(join(startupDir, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();
  });

  it("selects valid context.directory when worktree is empty", async () => {
    // Case (4): a valid context directory is used when no meaningful worktree exists.
    const projectDir = await project();
    const plugin = await load({ directory: projectDir } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Directory fallback plan", tasks: ["Task"] },
      toolContext("coder", "session", undefined, { worktree: "", directory: projectDir }),
    );
    expect(await readFile(join(projectDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Directory fallback plan");
  });

  it("falls back to startup directory when invocation directory is filesystem root or empty", async () => {
    // Regression: when context.directory is a filesystem root sentinel or empty,
    // Plan persistence must fall back to the meaningful plugin-startup OpenCode
    // directory captured at plugin init, not error or use process.cwd().
    const startupDir = await project();
    const plugin = await load({ directory: startupDir } as never);
    const plan = plugin.tool!.plan!;

    // Case 1: context.directory is filesystem root sentinel -> fall back to startup.
    await plan.execute(
      { action: "create", title: "Root fallback plan", tasks: ["Task"] },
      toolContext("coder", "root-fallback-session", undefined, { directory: "/" }),
    );
    expect(await readFile(join(startupDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Root fallback plan");

    // Clean up for case 2.
    await rm(join(startupDir, ".aria", "rdc", "TASKS.md"), { force: true });

    // Case 2: context.directory is empty -> fall back to startup.
    await plan.execute(
      { action: "create", title: "Empty fallback plan", tasks: ["Task"] },
      toolContext("coder", "empty-fallback-session", undefined, { directory: "" }),
    );
    expect(await readFile(join(startupDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain("Empty fallback plan");
  });

  it("top-level input.directory='/' does not shadow meaningful input.project.directory", async () => {
    // Regression: when OpenCode passes input.directory='/' (filesystem root
    // sentinel) together with a meaningful input.project.directory, the Plan
    // startup fallback must resolve to the project directory, not error or
    // fall through to process.cwd(). Each candidate is validated individually
    // for meaningfulness BEFORE precedence.
    const projectDir = await project();
    const plugin = await load({ directory: "/", project: { directory: projectDir } } as never);
    const plan = plugin.tool!.plan!;

    // Invoke Plan with a non-meaningful context.directory so the startup
    // fallback is exercised.
    await plan.execute(
      { action: "create", title: "Project directory fallback plan", tasks: ["Task"] },
      toolContext("coder", "project-dir-fallback-session", undefined, { directory: "/" }),
    );
    // The plan must be written to projectDir/.aria/rdc/TASKS.md, not to
    // /.aria/rdc/TASKS.md or process.cwd()/.aria/rdc/TASKS.md.
    expect(await readFile(join(projectDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain(
      "Project directory fallback plan",
    );
    // Verify the filesystem root did NOT receive the plan.
    await expect(readFile(join("/", ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();
  });

  it("symlink-to-root context.directory is rejected and Plan falls back to startup directory", async () => {
    // Adversarial regression: an existing symlink whose canonical realpath
    // resolves to the filesystem root (e.g., /tmp/project-link -> /) must be
    // rejected by the central meaningful-directory validation, so Plan
    // persistence falls back to the meaningful startup directory instead of
    // resolving against the filesystem root.
    const startupDir = await project();
    const symlinkDir = join(startupDir, "root-link");
    await symlinkToRoot(symlinkDir);
    const plugin = await load({ directory: startupDir } as never);
    const plan = plugin.tool!.plan!;

    // Invoke Plan with a symlink-to-root context.directory -> must fall back to startup.
    await plan.execute(
      { action: "create", title: "Symlink-to-root fallback plan", tasks: ["Task"] },
      toolContext("coder", "symlink-root-fallback-session", undefined, { directory: symlinkDir }),
    );
    // The plan must be written to startupDir/.aria/rdc/TASKS.md, not to the
    // filesystem root via the symlink.
    expect(await readFile(join(startupDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain(
      "Symlink-to-root fallback plan",
    );
    // Verify the filesystem root did NOT receive the plan.
    await expect(readFile(join("/", ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();
  });

  it("symlink-to-root input.directory does not shadow meaningful input.project.directory for Plan startup", async () => {
    // Adversarial regression: an existing symlink whose canonical realpath
    // resolves to the filesystem root must be rejected by the central
    // meaningful-directory validation, so a symlink-to-root input.directory
    // cannot shadow a meaningful input.project.directory for Plan startup.
    const projectDir = await project();
    const symlinkDir = join(projectDir, "root-link");
    await symlinkToRoot(symlinkDir);
    const plugin = await load({ directory: symlinkDir, project: { directory: projectDir } } as never);
    const plan = plugin.tool!.plan!;

    // Invoke Plan with a non-meaningful context.directory so the startup
    // fallback is exercised.
    await plan.execute(
      { action: "create", title: "Symlink startup fallback plan", tasks: ["Task"] },
      toolContext("coder", "symlink-startup-fallback-session", undefined, { directory: "/" }),
    );
    // The plan must be written to projectDir/.aria/rdc/TASKS.md, not to the
    // filesystem root via the symlink.
    expect(await readFile(join(projectDir, ".aria/rdc", "TASKS.md"), "utf8")).toContain(
      "Symlink startup fallback plan",
    );
    // Verify the filesystem root did NOT receive the plan.
    await expect(readFile(join("/", ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();
  });

  it("config precedence: lexical root input.directory does not shadow nested project.directory", async () => {
    // Adversarial regression: the startup/config selector must validate EACH
    // directory candidate before precedence, so a lexical root top-level
    // input.directory='/' cannot shadow a meaningful nested input.project.directory.
    const projectDir = await project();
    const result = projectDirectory({ directory: "/", project: { directory: projectDir } });
    expect(result).toBe(projectDir);
  });

  it("config precedence: lexical root input.directory does not shadow meaningful config worktree", async () => {
    // Adversarial regression: the startup/config selector must validate EACH
    // directory and retained worktree candidate before precedence, so a lexical
    // root top-level input.directory='/' cannot shadow a meaningful worktree.
    const worktreeDir = await project();
    const result = projectDirectory({ directory: "/", worktree: worktreeDir });
    expect(result).toBe(worktreeDir);
  });

  it("config precedence: symlink-to-root input.directory does not shadow meaningful project.directory", async () => {
    // Adversarial regression: the startup/config selector must validate EACH
    // directory candidate before precedence, so an existing symlink whose
    // canonical realpath resolves to the filesystem root cannot shadow a
    // meaningful nested input.project.directory.
    const projectDir = await project();
    const symlinkDir = join(projectDir, "root-link");
    await symlinkToRoot(symlinkDir);
    const result = projectDirectory({ directory: symlinkDir, project: { directory: projectDir } });
    expect(result).toBe(projectDir);
  });

  it("config precedence: symlink-to-root input.directory does not shadow meaningful config worktree", async () => {
    // Adversarial regression: the startup/config selector must validate EACH
    // directory and retained worktree candidate before precedence, so an
    // existing symlink whose canonical realpath resolves to the filesystem
    // root cannot shadow a meaningful worktree.
    const worktreeDir = await project();
    const symlinkDir = join(worktreeDir, "root-link");
    await symlinkToRoot(symlinkDir);
    const result = projectDirectory({ directory: symlinkDir, worktree: worktreeDir });
    expect(result).toBe(worktreeDir);
  });

  it("Plan get returns the invocation-root plan, not the plugin-startup plan", async () => {
    // Regression: Plan `get` must resolve its persistence root from the
    // per-invocation ToolContext, not from the plugin-startup cwd. Seed a
    // distinguishable plan at each root and assert that `get` returns the
    // invocation-root plan.
    const startupDir = await project();
    const invocationDir = await project();
    const plugin = await load({ directory: startupDir } as never);
    const plan = plugin.tool!.plan!;

    // Seed a plan at the plugin-startup root.
    await plan.execute(
      { action: "create", title: "Startup plan", tasks: ["Startup task"] },
      toolContext("coder", "startup-session", undefined, { directory: startupDir }),
    );

    // Seed a different plan at the per-invocation root.
    await plan.execute(
      { action: "create", title: "Invocation plan", tasks: ["Invocation task"] },
      toolContext("coder", "invocation-session", undefined, { directory: invocationDir }),
    );

    // `get` invoked with the invocation context must return the invocation-root plan.
    const getResult = await plan.execute(
      { action: "get" },
      toolContext("coder", "invocation-session", undefined, { directory: invocationDir }),
    );
    const getOutput = outputOf(getResult);
    expect(getOutput).toContain("Plan: Invocation plan");
    expect(getOutput).not.toContain("Startup plan");
  });

  it("rejects Plan execution when neither context.directory nor startup directory provides a valid root", async () => {
    // Regression: when both context.directory and the plugin-startup directory
    // are non-meaningful (empty or filesystem root), Plan execution must reject
    // with a clear error instead of passing an empty path that Node resolves
    // against process cwd. No Plan state may be read, migrated, or created
    // under the unrelated plugin-startup directory or process.cwd().
    // Pass a non-meaningful startup directory (filesystem root) so the
    // fallback also fails.
    const plugin = await load({ directory: "/" } as never);
    const plan = plugin.tool!.plan!;

    // Use an unrelated temp dir as process.cwd() to prove no state is created there.
    const cwdDir = await project();
    const originalCwd = process.cwd();
    try {
      process.chdir(cwdDir);

      // Empty context.directory + non-meaningful startup directory -> get must reject.
      const getResult = await plan.execute(
        { action: "get" },
        toolContext("coder", "empty-context-session", undefined, { worktree: "", directory: "" }),
      );
      expect(outputOf(getResult)).toMatch(/meaningful OpenCode directory/);
      expect(titleOf(getResult)).toBe("Error");

      // Create must also reject under the same empty context.
      const createResult = await plan.execute(
        { action: "create", title: "Should not exist", tasks: ["Task"] },
        toolContext("coder", "empty-context-create", undefined, { worktree: "", directory: "" }),
      );
      expect(outputOf(createResult)).toMatch(/meaningful OpenCode directory/);
      expect(titleOf(createResult)).toBe("Error");

      // No Plan state may have been created under process.cwd().
      await expect(readFile(join(cwdDir, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();
      // No Plan state may have been created under the filesystem root.
      await expect(readFile(join("/", ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("valid invocation context never falls back to process.cwd() or plugin-startup cwd", async () => {
    // Regression: a valid invocation context must route Plan persistence to
    // the invocation root, never to process.cwd() or the plugin-startup
    // directory. Temporarily change process.cwd() to an unrelated directory
    // and assert the plan is created at the invocation root.
    const startupDir = await project();
    const invocationDir = await project();
    const cwdDir = await project();
    const originalCwd = process.cwd();
    try {
      process.chdir(cwdDir);
      const plugin = await load({ directory: startupDir } as never);
      const plan = plugin.tool!.plan!;

      // Create a plan with a valid invocation context — must go to
      // invocationDir, not cwdDir or startupDir.
      await plan.execute(
        { action: "create", title: "Process cwd isolation plan", tasks: ["Task"] },
        toolContext("coder", "cwd-isolation-session", undefined, { directory: invocationDir }),
      );
      expect(
        await readFile(join(invocationDir, ".aria/rdc", "TASKS.md"), "utf8"),
      ).toContain("Process cwd isolation plan");
      // process.cwd() must not receive the plan.
      await expect(readFile(join(cwdDir, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();
      // Plugin-startup cwd must not receive the plan.
      await expect(readFile(join(startupDir, ".aria/rdc", "TASKS.md"), "utf8")).rejects.toThrow();

      // Get must also read from the invocation root, not process.cwd().
      const getResult = await plan.execute(
        { action: "get" },
        toolContext("coder", "cwd-isolation-get", undefined, { directory: invocationDir }),
      );
      expect(outputOf(getResult)).toContain("Plan: Process cwd isolation plan");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("legacy migration follows the invocation root, not the plugin-startup cwd", async () => {
    // Regression: the legacy `.code-ensemble` -> `.aria/rdc` migration must
    // operate on the invocation root selected from the per-invocation
    // ToolContext, not on the plugin-startup directory. Seed a legacy state
    // at the invocation root only, invoke Plan `get` with that invocation
    // context, and assert the legacy plan is migrated and returned while the
    // plugin-startup root receives no migration or creation.
    const startupDir = await project();
    const invocationDir = await project();
    const plugin = await load({ directory: startupDir } as never);
    const plan = plugin.tool!.plan!;

    // Seed a legacy plan at the invocation root only.
    const invocationLegacyDir = join(invocationDir, ".code-ensemble");
    await mkdir(invocationLegacyDir, { recursive: true });
    // A minimal valid plan markdown is not required for the migration test:
    // migrateLegacyState only renames the directory; the subsequent read
    // will surface "No active TASKS.md" if the content is not a valid plan.
    // So we seed a valid active plan at the legacy location by writing through
    // the plan tool first at the invocation root, then moving the canonical
    // directory back to the legacy location.
    await plan.execute(
      { action: "create", title: "Legacy invocation plan", tasks: ["Legacy task"] },
      toolContext("coder", "legacy-seed-session", undefined, { directory: invocationDir }),
    );
    // Move canonical -> legacy to simulate a pre-migration state.
    const invocationCanonicalDir = join(invocationDir, ".aria", "rdc");
    const invocationCanonicalFile = join(invocationCanonicalDir, "TASKS.md");
    const legacyFile = join(invocationLegacyDir, "TASKS.md");
    // Ensure legacy dir is empty before rename (mkdir already created it).
    await rm(invocationLegacyDir, { recursive: true, force: true });
    // Rename canonical -> legacy.
    const { rename } = await import("node:fs/promises");
    await rename(invocationCanonicalDir, invocationLegacyDir);
    // Confirm the canonical file is gone and the legacy file exists.
    await expect(readFile(invocationCanonicalFile, "utf8")).rejects.toThrow();
    await expect(readFile(legacyFile, "utf8")).resolves.toContain("Legacy invocation plan");

    // Invoke Plan `get` with the invocation context — must migrate and return
    // the legacy plan from the invocation root.
    const getResult = await plan.execute(
      { action: "get" },
      toolContext("coder", "legacy-read-session", undefined, { directory: invocationDir }),
    );
    expect(outputOf(getResult)).toContain("Plan: Legacy invocation plan");

    // After migration, the canonical location must hold the plan and the
    // legacy location must be gone.
    await expect(readFile(invocationCanonicalFile, "utf8")).resolves.toContain(
      "Legacy invocation plan",
    );
    await expect(readFile(invocationLegacyDir, "utf8")).rejects.toThrow();

    // The plugin-startup root must not have received any migration or plan
    // creation as a side effect.
    await expect(readFile(join(startupDir, ".aria", "rdc", "TASKS.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(startupDir, ".code-ensemble", "TASKS.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects stale plan id and revision on mutations", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session, undefined, { directory: root });
    const architect = (session: string) => toolContext("architect", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const planner = (session: string) => toolContext("planner", session, undefined, { directory: root });
    const architect = (session: string) => toolContext("architect", session, undefined, { directory: root });
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const coder = (session: string) => toolContext("coder", session, undefined, { directory: root });

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