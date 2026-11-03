import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node:path";
import { describe, expect, it } from "vitest";

import { isFilesystemRoot } from "../src/paths.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

describe("amendment reopening and precedence contract (Markdown plans)", () => {
  it("Planner reopens a complete plan to approved before execution and requires a new PLAN_PASS", () => {
    const planner = read("defaults/prompts/planner.md");
    expect(planner).toContain("Reopening: when an approved amendment adds pending tasks to a `complete` plan, set state back to `approved` before any execution.");
    expect(planner).toContain("Keep all prior `PLAN_PASS` evidence and task records.");
    expect(planner).toContain("naming the amendment ID, the reason, and the new pending task IDs");
    expect(planner).toContain("Return to `complete` only after a new whole-plan `PLAN_PASS`");
    const coder = read("defaults/prompts/coder.md");
    expect(coder).toContain("If Planner reopened the plan for an approved amendment, run the final whole-plan review again before completing it.");
    const skill = read("skills/rdc-implementation-planning/SKILL.md");
    expect(skill).toContain("reopens it to `approved` with a recorded reason and amendment ID");
  });

  it("an approved amendment overrides a frozen exclusion or constraint only through an exact named exception", () => {
    const planner = read("defaults/prompts/planner.md");
    expect(planner).toContain("only when its approval entry names that exact exclusion or constraint and states the exact exception");
    expect(planner).toContain("Record each such override in the amendment as `Overrides:`");
    expect(planner).toContain("do not record the amendment as approved");
    const skill = read("skills/rdc-implementation-planning/SKILL.md");
    expect(skill).toContain("ambiguous authorization blocks the conflicting work");
    const coder = read("defaults/prompts/coder.md");
    expect(coder).toContain("authorizes that conflict only when the approval names the exact exception");
  });

  it("Reviewer identifies conflicts before approval and blocks unapproved conflicting changes after it", () => {
    const reviewer = read("defaults/prompts/reviewer.md");
    expect(reviewer).toContain("Conflict check before approval");
    expect(reviewer).toContain("list every frozen exclusion or constraint it would touch as a `CONFLICT` item");
    expect(reviewer).toContain("Without one, mark the conflicting work as blocked.");
    expect(reviewer).toContain("Post-approval validation");
    expect(reviewer).toContain("lacks an approved exception as a blocker, not as work to continue");
    expect(reviewer).toContain("Planner records an approved material-scope amendment only after renewed human approval");
  });
});

describe("shared isFilesystemRoot utility", () => {
  it("lives in src/paths.ts", () => {
    expect(isFilesystemRoot(parse(resolve("/tmp/aria-amendment-root")).root)).toBe(true);
    expect(isFilesystemRoot(resolve("/tmp/aria-amendment-root"))).toBe(false);
  });
});
