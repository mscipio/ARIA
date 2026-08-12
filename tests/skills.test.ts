import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const skillsRoot = resolve(process.cwd(), "skills");

function skill(name: string): string {
  return readFileSync(resolve(skillsRoot, name, "SKILL.md"), "utf8");
}

describe("package-owned ARIA skills", () => {
  it("ships only namespaced skills with matching frontmatter names", () => {
    const names = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toHaveLength(15);
    expect(names.filter((name) => name.startsWith("rdc-"))).toHaveLength(8);
    expect(names.filter((name) => name.startsWith("aria-"))).toHaveLength(7);
    for (const name of names) {
      expect(name).toMatch(/^(rdc|aria)-/);
      expect(skill(name)).toContain(`name: ${name}`);
      expect(skill(name)).toContain("owner: aria");
    }
  });

  it("preserves the core coding workflow disciplines in skills", () => {
    expect(skill("rdc-code-exploration")).toContain("Trace definitions through callers and data flow");
    expect(skill("rdc-implementation-planning")).toContain("smallest correct change");
    expect(skill("rdc-plan-review")).toContain("scope creep");
    expect(skill("rdc-code-implementation")).toContain("Preserve existing working-tree changes");
    expect(skill("rdc-implementation-review")).toContain("every explicit acceptance criterion");
    expect(skill("rdc-testing-discipline")).toContain("smallest representative verification");
  });

  it("keeps Wiki lookup, archival, and compilation as distinct capabilities", () => {
    expect(skill("aria-wiki-lookup")).toContain("Hard read-only boundary");
    expect(skill("aria-wiki-archive")).toContain("Archival does not compile");
    expect(skill("aria-wiki-compile")).toContain("Raw files are immutable provenance");
  });

  it("keeps academic writing evidence-bounded and journal-aware", () => {
    const academic = skill("aria-academic-writing");
    expect(academic).toContain("Claim discipline");
    expect(academic).toContain("measured vs. simulated");
    expect(academic).toContain("Section-aware guidance");
    expect(academic).toContain("Avoid unsupported novelty claims");
  });

  it("keeps natural-writing guidance separate from academic content rules", () => {
    const natural = skill("aria-writing-anti-ai");
    expect(natural).toContain("formulaic model-generated text");
    expect(natural).toContain("Avoid inflated importance");
    expect(natural).toContain("Break formulaic structures");
    expect(natural).toContain("not evasion of detection systems");
  });

  it("keeps review-response and manuscript self-review evidence anchored", () => {
    expect(skill("aria-review-response")).toContain("Accept");
    expect(skill("aria-review-response")).toContain("Clarify");
    expect(skill("aria-review-response")).toContain("Defend");
    expect(skill("aria-paper-self-review")).toContain("Claim audit");
    expect(skill("aria-paper-self-review")).toContain("[CITATION NEEDED]");
  });
});
