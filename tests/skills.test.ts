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

    expect(names).toHaveLength(18);
    expect(names.filter((name) => name.startsWith("rdc-"))).toHaveLength(8);
    expect(names.filter((name) => name.startsWith("aria-"))).toHaveLength(10);
    for (const name of names) {
      expect(name).toMatch(/^(rdc|aria)-/);
      expect(skill(name)).toContain(`name: ${name}`);
      expect(skill(name)).toContain("owner: aria");
    }
  });

  it("keeps the scientist method skills bounded to generic planning and analysis", () => {
    const planning = skill("aria-research-planning");
    // Accepted generic planning concepts.
    expect(planning).toContain("tractable");
    expect(planning).toContain("5W1H");
    expect(planning).toContain("falsification");
    expect(planning).toContain("competing hypotheses");
    expect(planning).toContain("evidence needs from assumptions");
    expect(planning).toContain("minimal next decision");
    expect(planning).toContain("information value");
    // Rejected scope is stated, not supported: retrieval and bulk/template work.
    expect(planning).toContain("Literature search, Zotero/PDF/BibTeX retrieval, and external evidence acquisition → task `researcher`");
    expect(planning).toContain("Persistence: no SDD documents, Engram observations, global registries");
    expect(planning).toContain("Fixed workflow chains, bulk reference-file catalogs");

    const analysis = skill("aria-results-analysis");
    // Accepted generic analysis concepts.
    expect(analysis).toContain("unit of analysis");
    expect(analysis).toContain("practical from statistical significance");
    expect(analysis).toContain("explicit comparisons");
    expect(analysis).toContain("uncertainty");
    expect(analysis).toContain("calibrated claims");
    expect(analysis).toContain("blockers");
    expect(analysis).toContain("underdetermined");
    // Rejected scope: computation, mandated outputs, prose.
    expect(analysis).toContain("Running code, generating figures, or producing files");
    expect(analysis).toContain("computation belongs to `coder`");
    expect(analysis).toContain("Results-section prose, and publication tooling → `writer`");
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

  it("keeps the research evidence skill bounded to ARIA's evidence workflow", () => {
    const research = skill("aria-research-evidence");
    // Evidence ladder and provenance/labeling rules.
    expect(research).toContain("Evidence ladder");
    expect(research).toContain("Inspected full text");
    expect(research).toContain("Passage with expanded context");
    expect(research).toContain("Abstract / snippet");
    expect(research).toContain("primary/authoritative sources");
    expect(research).toContain("library-vs-external provenance");
    // Passage-context expansion before passage-specific claims.
    expect(research).toContain("get_passage_context");
    // Disagreement, uncertainty, and gap reporting with structured handoff.
    expect(research).toContain("Report disagreement, uncertainty, and gaps");
    expect(research).toContain("structured evidence handoff");
    // ZotPilot-aware without nested user-level workflows or new backends.
    expect(research).toContain("ZotPilot MCP research tools directly");
    expect(research).not.toContain("load `ztp-research`");
    expect(research).not.toContain("load `ztp-review`");
    expect(research).toContain("do not spawn nested researcher subagents");
    expect(research).toContain("do not install a second Zotero backend or MCP");
    // No automatic Engram persistence.
    expect(research).toContain("Do not persist anything to Engram automatically");
  });
});
