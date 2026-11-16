import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "./permissions.ts";
import {
  AUTHORITY_PATHS,
  allow,
  codingRules,
  deny,
  docsRules,
  readOnlyRules,
  skillRules,
  subagentRules,
  zoteroRules,
} from "./permissions.ts";

export type RoleID = "aria" | "scout" | "reviewer" | "planner" | "scientist" | "writer" | "researcher";

export interface RoleSpec {
  readonly id: RoleID;
  readonly mode: "primary" | "subagent" | "all";
  readonly description: string;
  readonly rules: readonly Rule[];
}

export interface RoleOptions {
  /** MCP server name under which zotero-mcp is configured. Default `zotero`. */
  readonly zoteroServer: string;
}

/**
 * Models: ARIA pins none. Every role uses the model the user selected (or the launching
 * session's model for subagents) unless the user sets `agents.<id>.model` in opencode.jsonc.
 * ARIA cannot know which providers the user is entitled to, and an unavailable pinned default
 * fails at run time. `aria_status` reports the effective model of every role.
 */

const CODING_SKILLS = ["aria-plan", "aria-review", "aria-investigate", "aria-numerics", "aria-document-design"];
const SCIENCE_SKILLS = ["aria-plan", "aria-investigate", "aria-numerics", "aria-research-planning", "aria-results-analysis", "aria-review"];
const DOC_EXTENSIONS = ["md", "tex", "bib", "txt", "rst", "typ", "qmd", "org", "adoc"];

/**
 * Writers may edit prose and bibliography files in the project, nothing else. The denies come
 * after the allows (last match wins) and cover each protected directory at any depth. OpenCode's
 * star matches across slashes, so `<dir>/STAR` covers the top level and `STAR/<dir>/STAR` every nested copy.
 */
const WRITER_PROTECTED_DIRS = [".aria", ".opencode", ".claude", ".agents", ".git", ".github", ".vscode", "node_modules"];
const writerEditRules = (): Rule[] => [
  ...DOC_EXTENSIONS.map((ext) => allow("edit", `*.${ext}`)),
  deny("edit", "/*"),
  deny("edit", "?:/*"),
  ...WRITER_PROTECTED_DIRS.flatMap((dir) => [deny("edit", `${dir}/*`), deny("edit", `*/${dir}/*`)]),
  ...AUTHORITY_PATHS.map((p) => deny("edit", p)),
];

/** The planner writes top-level plan files only. Nested paths and everything else are denied. */
const plannerEditRules = (): Rule[] => [allow("edit", ".aria/plans/*.md"), deny("edit", ".aria/plans/*/*")];

export function buildRoles(options: RoleOptions): RoleSpec[] {
  return [
    {
      id: "aria",
      mode: "all",
      description:
        "Default coding agent. Understands the goal, investigates, plans only when warranted, edits, verifies and reports. Handles most work alone.",
      rules: [
        ...codingRules(),
        ...skillRules(...CODING_SKILLS),
        ...subagentRules("scout", "reviewer", "planner", "researcher", "scientist", "writer"),
      ],
    },
    {
      id: "scout",
      mode: "subagent",
      description:
        "Read-only codebase and documentation explorer. Maps files, call paths, tests and conventions; reads images and public docs. Cannot write or run anything.",
      rules: [...readOnlyRules(), ...docsRules(), ...skillRules("aria-investigate")],
    },
    {
      id: "reviewer",
      mode: "subagent",
      description:
        "Independent, read-only reviewer. Challenges correctness and assumptions of a change or plan; reports PASS / FAIL / INSUFFICIENT EVIDENCE with evidence.",
      rules: [...readOnlyRules(), allow("aria_review_verdict"), ...skillRules("aria-review", "aria-investigate", "aria-numerics")],
    },
    {
      id: "planner",
      mode: "all",
      description:
        "Turns a large objective into a durable plan in .aria/plans/. Its only write access is top-level plan files; it can investigate through scout.",
      rules: [
        ...readOnlyRules(),
        allow("question"),
        ...plannerEditRules(),
        ...skillRules("aria-plan", "aria-investigate"),
        ...subagentRules("scout"),
      ],
    },
    {
      id: "scientist",
      mode: "all",
      description:
        "Scientific work end to end: specification, method, numerical and imaging code (Python/MATLAB), analysis, figures and interpretation, under the same safeguards as aria.",
      rules: [
        ...codingRules(),
        ...skillRules(...SCIENCE_SKILLS),
        ...subagentRules("scout", "reviewer", "researcher", "writer"),
      ],
    },
    {
      id: "writer",
      mode: "all",
      description:
        "Scientific and professional writing: manuscripts, reports, rebuttals, documents. May edit prose files (md, tex, bib, txt, rst, typ) in the project, never code or agent configuration.",
      rules: [
        ...readOnlyRules(),
        allow("question"),
        ...writerEditRules(),
        ...skillRules("aria-academic-writing", "aria-writing-anti-ai", "aria-review-response", "aria-paper-self-review", "aria-document-design"),
        ...subagentRules("researcher"),
      ],
    },
    {
      id: "researcher",
      mode: "all",
      description:
        "Literature and evidence research through Zotero and the web. Read-only on files; any change to the Zotero library asks first.",
      rules: [
        ...readOnlyRules(),
        allow("question"),
        ...docsRules(),
        ...zoteroRules(options.zoteroServer),
        ...skillRules("aria-research-evidence", "aria-zotero-tutor"),
      ],
    },
  ];
}

export const ROLE_IDS: readonly RoleID[] = ["aria", "scout", "reviewer", "planner", "scientist", "writer", "researcher"];

/** Read a role prompt shipped in `prompts/<id>.md`. A missing prompt is a packaging error: fail loudly. */
export function loadPrompt(packageRoot: string, id: RoleID): string {
  return readFileSync(join(packageRoot, "prompts", `${id}.md`), "utf8").trim();
}
