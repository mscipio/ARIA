import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { resolveAriaConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ARIA defaults", () => {
  it("contains exactly the eleven supported agents in stable order", () => {
    const defaults = loadDefaultConfig();
    expect(Object.keys(defaults.roles)).toEqual([
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
    expect(defaults.roles.planner).not.toHaveProperty("fallbacks");
    expect(defaults.roles.architect).not.toHaveProperty("fallbacks");
    expect(defaults.roles.researcher).toEqual({
      model: "openai/gpt-5.6-sol",
      variant: "medium",
      mode: "all",
      promptFile: "prompts/researcher.md",
    });
    expect(defaults.roles.scientist).toEqual({
      model: "openai/gpt-5.6-sol",
      variant: "medium",
      mode: "all",
      promptFile: "prompts/scientist.md",
    });
  });

  it("keeps exactly five durable `all` modes and six specialist `subagent` modes", () => {
    const defaults = loadDefaultConfig();
    const byMode = Object.fromEntries(
      Object.entries(defaults.roles).map(([role, entry]) => [role, entry.mode]),
    );
    expect(byMode).toEqual({
      coder: "all",
      explorer: "subagent",
      visualizer: "subagent",
      planner: "subagent",
      architect: "subagent",
      implementer: "subagent",
      reviewer: "subagent",
      researcher: "all",
      archivist: "all",
      writer: "all",
      scientist: "all",
    });
  });

  it("keeps every pre-existing model and variant pair unchanged", () => {
    const defaults = loadDefaultConfig();
    expect(defaults.roles).toMatchObject({
      coder: { model: "opencode-go/deepseek-v4-pro" },
      explorer: { model: "opencode-go/deepseek-v4-flash", variant: "high" },
      visualizer: { model: "opencode-go/kimi-k2.7-code" },
      planner: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
      architect: { model: "openai/gpt-5.6-sol", variant: "xhigh" },
      implementer: { model: "opencode-go/glm-5.2" },
      reviewer: { model: "opencode-go/deepseek-v4-pro" },
      researcher: { model: "openai/gpt-5.6-sol", variant: "medium" },
      archivist: { model: "opencode-go/deepseek-v4-pro" },
      writer: { model: "openai/gpt-5.6-sol", variant: "medium" },
    });
  });

  it("merges model and variant overrides", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aria-defaults-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "aria.json"), JSON.stringify({
      roles: { planner: { model: "openai/gpt-5.4-mini", variant: "high" } },
    }));

    const config = resolveAriaConfig(root);
    expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
    expect(config.roles.planner.variant).toBe("high");
    expect(config.roles.coder.promptText).toContain("explorer: `explorer` →");
    expect(config).not.toHaveProperty("fallbacks");
  });

  it("exports only the root and server package entries", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(Object.keys(packageJson.exports)).toEqual([".", "./server"]);
  });

  it("ships defaults and package-owned skills", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.name).toBe("aria");
    expect(packageJson.version).toBe("0.5.0");
    expect(packageJson.files).toContain("defaults");
    expect(packageJson.files).toContain("skills");
  });

  it("loads default config from defaults/aria.defaults.json", () => {
    const configPath = resolve(process.cwd(), "defaults", "aria.defaults.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.roles).toBeDefined();
    expect(config.roles.coder).toBeDefined();
    expect(config.roles.writer).toBeDefined();
    expect(config.roles.scientist).toBeDefined();
    expect(config.roles.coder.mode).toBe("all");
    expect(config.roles.writer.mode).toBe("all");
    expect(config.roles["archivist"].mode).toBe("all");
    expect(config.roles.researcher.mode).toBe("all");
    expect(config.roles.scientist.mode).toBe("all");
  });

  it("coder preserves the human approval gate", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.coder.promptText;
    expect(prompt).toContain("STOP and wait for the user to approve");
    expect(prompt).toContain("Only after the user explicitly approves");
    expect(prompt).not.toMatch(/continue immediately without asking for approval/i);
  });

  it("coder owns coding workflow and keeps Wiki delegation explicit", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.coder.promptText;
    expect(prompt).toContain("For questions");
    expect(prompt).toContain("Do NOT create a plan");
    expect(prompt).toContain("For clear plan or implementation requests");
    expect(prompt).toContain("native `task` for coding specialists");
    expect(prompt).toContain("task `archivist`");
    expect(prompt).not.toContain("Writing routing:");
    expect(prompt).not.toContain("delegate directly to `writer`");
  });

  it("explorer prompt keeps role boundaries and loads exploration skill", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.explorer.promptText;
    expect(prompt).toContain("load `rdc-code-exploration`");
    expect(prompt).toContain("Do not edit files, run shell commands, or delegate work");
    expect(prompt).toContain("Relevant Locations");
  });

  it("visualizer prompt keeps role boundaries and loads visual skill", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.visualizer.promptText;
    expect(prompt).toContain("load `rdc-visual-analysis`");
    expect(prompt).toContain("Separate direct observations from interpretations");
    expect(prompt).toContain("Actionable Requirements");
  });

  it("planner prompt keeps Plan authority boundaries and loads planning skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.planner.promptText;
    expect(prompt).toContain("load `rdc-implementation-planning`");
    expect(prompt).toContain("Load `rdc-testing-discipline`");
    expect(prompt).toContain("Allowed Plan actions: `get`, `create`");
    expect(prompt).toContain("approval: pending");
    expect(prompt).toContain("retrieve relevant Engram context before `create`");
  });

  it("architect prompt keeps both authority modes and loads mode-specific skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.architect.promptText;
    expect(prompt).toContain("Load `rdc-plan-review`");
    expect(prompt).toContain("Load `rdc-scope-assessment`");
    expect(prompt).toContain("Allowed Plan actions: `get`, `replace`");
    expect(prompt).toContain("READY");
    expect(prompt).toContain("REVISED");
    expect(prompt).toContain("SCOPE_CHANGE");
    expect(prompt).toContain("WITHIN_SCOPE");
  });

  it("implementer prompt keeps mutation boundaries and loads implementation skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.implementer.promptText;
    expect(prompt).toContain("load `rdc-code-implementation`");
    expect(prompt).toContain("Load `rdc-testing-discipline`");
    expect(prompt).toContain("Do not commit, push, publish");
    expect(prompt).toContain("approved Plan remains authoritative");
  });

  it("reviewer prompt keeps independent read-only review contract and loads review skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.reviewer.promptText;
    expect(prompt).toContain("load `rdc-implementation-review`");
    expect(prompt).toContain("Load `rdc-testing-discipline`");
    expect(prompt).toContain("Allowed Plan action: `get` only");
    expect(prompt).toContain("Engram use is read-only during review");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("FAIL");
    expect(prompt).toContain("INSUFFICIENT EVIDENCE");
    expect(prompt).toContain("Every persisted task and every explicit acceptance criterion");
    expect(prompt).toContain("Requirements Assessment");
    expect(prompt).toContain("Verdict");
  });

  it("adds shared MCP guidance only to roles that have shared MCP access", () => {
    const config = resolveAriaConfig(tmpdir());
    for (const role of ["coder", "explorer", "visualizer", "planner", "architect", "implementer", "reviewer"] as const) {
      const prompt = config.roles[role].promptText;
      expect(prompt).toContain("## MCP Guidance");
      expect(prompt).toContain("CodeGraph provides codebase intelligence");
      expect(prompt).toContain("Context7 provides current, version-specific");
      expect(prompt).toContain("Engram provides durable semantic/project memory");
      expect(prompt).toContain("selected role's explicit permissions and boundaries");
      expect(prompt).toContain("Engram is not authoritative transactional workflow state");
    }

    // researcher has its own ZotPilot/Context7-specific guidance, not the
    // shared CodeGraph/Engram guidance.
    expect(config.roles.researcher.promptText).not.toContain("## MCP Guidance");
    expect(config.roles.researcher.promptText).not.toContain("CodeGraph provides codebase intelligence");
    expect(config.roles["archivist"].promptText).not.toContain("## MCP Guidance");
    expect(config.roles.writer.promptText).not.toContain("## MCP Guidance");
    // scientist has no shared MCP access and no generic coding MCP guidance.
    expect(config.roles.scientist.promptText).not.toContain("## MCP Guidance");
    expect(config.roles.scientist.promptText).not.toContain("CodeGraph provides codebase intelligence");
    expect(config.roles.scientist.promptText).not.toContain("Context7 provides current, version-specific");
  });

  it("archivist prompt is a small mode router over package skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles["archivist"].promptText;
    expect(prompt).toContain("load `aria-wiki-lookup`");
    expect(prompt).toContain("load `aria-wiki-archive`");
    expect(prompt).toContain("load `aria-wiki-compile`");
    expect(prompt).toContain("WIKI_DIR");
    expect(prompt).toContain("PACKAGE_ROOT");
    expect(prompt).toContain("If it resolves to empty");
    expect(prompt).toContain("Raw files under `<WIKI_DIR>/raw/` are immutable provenance");
    expect(prompt).not.toContain("REPO_DIR");
    expect(prompt).not.toContain("myopencode");
  });

  it("writer prompt is a role/router and delegates detailed writing behavior to skills", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.writer.promptText;
    expect(prompt).toContain("`writer` primary agent");
    expect(prompt).toContain("load `aria-academic-writing`");
    expect(prompt).toContain("load `aria-writing-anti-ai`");
    expect(prompt).toContain("load `aria-review-response`");
    expect(prompt).toContain("load `aria-paper-self-review`");
    expect(prompt).toContain("task `archivist`");
    expect(prompt).toContain("read-only lookup");
    expect(prompt).toContain("task `researcher`");
    expect(prompt).toContain("Ask for evidence, not manuscript prose");
    expect(prompt).toContain("[RESEARCH NEEDED]");
    expect(prompt).toContain("[CITATION NEEDED]");
    expect(prompt).toContain("Do not perform literature research or Zotero work yourself");
    expect(prompt).not.toContain("When a `researcher` role becomes available");
    expect(prompt).not.toContain("## Academic journal style");
    expect(prompt).not.toContain("## Anti-template prose discipline");
    expect(prompt).not.toContain("## MCP Guidance");
  });

  it("researcher prompt defines direct/delegable evidence research with hard boundaries", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.researcher.promptText;
    expect(prompt).toContain("`researcher` role");
    expect(prompt).toContain("Load `aria-research-evidence`");
    expect(prompt).toContain("Distinguish library evidence");
    expect(prompt).toContain("primary/authoritative sources");
    expect(prompt).toContain("[full text]");
    expect(prompt).toContain("[abstract/snippet]");
    expect(prompt).toContain("[EVIDENCE GAP]");
    expect(prompt).toContain("ZotPilot MCP research/read tools directly");
    expect(prompt).toContain("Zotero mutation is approval-gated");
    expect(prompt).toContain("explicit user approval");
    expect(prompt).toContain("Do not persist anything to Engram automatically");
    expect(prompt).toContain("Do not draft manuscript or rebuttal prose");
    expect(prompt).toContain("do not spawn nested researcher subagents");
    expect(prompt).toContain("You cannot edit project files");
    // No automatic mutation or unsupported integration promises; user-level
    // ztp workflows are named only as a boundary, not invoked.
    expect(prompt).not.toMatch(/automatically (ingest|mutate|update|write)/);
    expect(prompt).toContain("Do not delegate every request to user-level `ztp-research`/`ztp-review` workflows");
    expect(prompt).not.toContain("load `ztp-research`");
    expect(prompt).not.toContain("load `ztp-review`");
  });

  it("contains no obsolete retrieval-only Engram wording", () => {
    const config = resolveAriaConfig(tmpdir());
    for (const role of Object.keys(config.roles) as Array<keyof typeof config.roles>) {
      expect(config.roles[role].promptText).not.toContain("retrieval-only");
    }
  });

  it("scientist prompt owns scientific specification/interpretation and delegates narrowly", () => {
    const prompt = resolveAriaConfig(tmpdir()).roles.scientist.promptText;
    expect(prompt).toContain("scientific authority");
    // High-level authority before and after data, without skill checklists.
    expect(prompt).toContain("Own scientific methodology and design before data are collected or computation is run");
    expect(prompt).toContain("own the interpretation of artifacts and reported results after");
    expect(prompt).not.toContain("falsification");
    expect(prompt).not.toContain("confounder");
    expect(prompt).not.toContain("calibrated claims");
    expect(prompt).not.toContain("underdetermination");
    expect(prompt).toContain("load `aria-research-planning`");
    expect(prompt).toContain("load `aria-results-analysis`");
    expect(prompt).toContain("task `researcher`");
    expect(prompt).toContain("task `writer`");
    expect(prompt).toContain("task `coder`");
    expect(prompt).toContain("You retain ownership of the scientific specification");
    expect(prompt).toContain("Never perform literature/search/Zotero retrieval yourself");
    expect(prompt).toContain("no persistence authority");
    expect(prompt).toContain("Never delegate to any role that is already an active ancestor");
    expect(prompt).not.toContain("## MCP Guidance");
  });

  it("adds only narrow scientist handoffs with the active-ancestor rule", () => {
    const config = resolveAriaConfig(tmpdir());

    const coder = config.roles.coder.promptText;
    expect(coder).toContain("task `scientist`");
    expect(coder).toContain("Scientist owns the scientific specification");
    expect(coder).toContain("Never delegate to any role that is already an active ancestor");

    const researcher = config.roles.researcher.promptText;
    expect(researcher).toContain("the `scientist` task you for focused evidence questions");
    expect(researcher).toContain("do not task `scientist` back when `scientist` tasked you");

    const writer = config.roles.writer.promptText;
    expect(writer).toContain("When `scientist` tasks you");
    expect(writer).toContain("do not task `scientist` back when `scientist` tasked you");

    // No archivist coupling to the scientist.
    expect(config.roles["archivist"].promptText).not.toContain("scientist");
  });
});
