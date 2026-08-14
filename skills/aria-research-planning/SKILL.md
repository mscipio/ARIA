---
name: aria-research-planning
description: Plan scientific research from a broad interest to a tractable, falsifiable design — question framing, optional 5W1H, competing hypotheses, evidence needs versus assumptions, measurement and method planning, and a minimal next decision — without literature retrieval or evidence acquisition.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Research Planning

Use this skill whenever the scientist must turn a broad research interest or question into a tractable scientific plan: what is being asked, what would count as evidence, how it would be measured, and what to do next. This skill defines planning reasoning; evidence acquisition belongs to the researcher.

## Planning steps

1. **Frame a tractable question.** Narrow the interest to a specific question that can be answered with identifiable evidence. Optionally use 5W1H framing (what, why, who, when, where, how) to expose assumptions and scope; it is a thinking aid, not a required output format.
2. **Reason about gaps, novelty, importance, and feasibility cautiously.** Note where the question fills a gap or is novel, why answering it matters, and whether it is feasible with available evidence and effort. Treat all of these as provisional claims, not established facts; do not assert a gap or novelty without supporting evidence.
3. **List competing hypotheses.** Enumerate plausible answers to the question, including the null or default. Prefer hypotheses that differ observably.
4. **Separate evidence needs from assumptions.** Record what must be shown versus what the plan merely assumes; flag assumptions that would invalidate conclusions if wrong.
5. **Define falsification and discrimination.** State what observation would falsify each hypothesis and what evidence discriminates between competing ones. A plan without a falsification condition is not yet testable.
6. **Plan measurement, method, controls, confounders, and information value.** Specify what is measured, how, and in what units; the comparison or control structure; likely confounders and how they are addressed; and whether each planned observation would actually change a decision (information value). Prefer the smallest design that discriminates the hypotheses.
7. **Choose the minimal next decision.** End with one concrete next step — a question to answer, an experiment to run, or a specification to hand to coder — not a full project plan.

## Out of scope

- Literature search, Zotero/PDF/BibTeX retrieval, and external evidence acquisition → task `researcher`.
- Proposal, timeline, milestone, deliverable, or template-heavy document production.
- Persistence: no SDD documents, Engram observations, global registries, or other durable state.
- Fixed workflow chains, bulk reference-file catalogs, and ML-only framing.
- Mandatory output files/artifacts/figures, code-execution assumptions, and universal or rigid statistical prescriptions (those belong to computation and analysis, not planning).
- Paper-writing and publication tooling.

## Output

Return the plan as conversation: the framed question, hypotheses, evidence needs and assumptions, falsification/discrimination conditions, measurement plan, and the minimal next decision. Note the biggest uncertainty in each part.
