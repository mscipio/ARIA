---
name: aria-academic-writing
description: Draft or revise peer-reviewed scientific and technical prose with evidence-bounded claims, journal-appropriate section structure, precise terminology, and restrained academic style.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Academic Writing

Use this skill for manuscript sections, scientific reports, technical papers, captions, abstracts, and other peer-reviewed academic prose.

## Priorities

Apply in this order:

1. Scientific fidelity.
2. Claim discipline.
3. Journal-quality clarity.
4. Authorial and terminology continuity.
5. Concision.

User instructions, venue requirements, and established manuscript conventions override generic style defaults.

## Evidence discipline

- Preserve quantitative values, units, symbols, terminology, and scope.
- Never make a claim stronger, broader, more causal, more novel, or more certain than the evidence supports.
- Preserve distinctions such as measured vs. simulated, observed vs. inferred, detector/module-level vs. system-level, retrospective vs. prospective, demonstrated vs. projected, hypothesis vs. result, and association vs. causation.
- Do not convert a design intention, plan, expected result, or related-work motivation into evidence that the present work demonstrated something.
- Preserve supplied citations and citation markers.
- Never invent references, DOIs, results, statistics, experiments, manuscript changes, or source support.
- When evidence is missing, weaken the statement or mark `[EVIDENCE NEEDED]`, `[CITATION NEEDED]`, or `[RESEARCH NEEDED]`.

## General journal style

- Lead with the scientific point.
- Prefer concrete nouns and verbs over promotional abstractions.
- Use technical terminology consistently; avoid unnecessary synonym rotation.
- State what was done, found, compared, or inferred directly.
- Qualify only where scientifically necessary.
- Reserve causal wording for designs/analyses that establish causality.
- Prefer specific quantities/comparisons over vague adjectives.
- Use “significant” for statistical significance only when supported.
- Avoid unsupported novelty claims such as “first”, “novel”, “unique”, “unprecedented”, or “state-of-the-art”.
- Do not inflate routine engineering/method choices into “key innovations”.

## Section-aware guidance

### Abstract
Problem/context → method/system → strongest supported results → proportional implication. Prefer quantitative results when available. Do not end with a promotional slogan.

### Introduction
Move efficiently from context → specific gap → present work → concrete contributions. Use prior work to define the gap, not to create a generic literature tour.

### Methods / Materials
Optimize for reproducibility and technical clarity. Preserve details that affect interpretation. Use consistent nomenclature, units, parameters, and tense.

### Results
Report observations before interpretation. Use exact comparisons and uncertainty/statistics when supplied. Do not convert trends into effects or simulations into experimental validation. Narrate what the reader should notice rather than repeating every table value.

### Discussion
Interpret results in relation to the stated question. Distinguish interpretation from direct observation. State limitations concretely and keep implications proportional to the tested scope.

### Conclusion
Synthesize the supported contribution. Introduce no new evidence and avoid grand predictions.

### Figure/table captions
Make captions sufficiently self-contained. Define non-obvious abbreviations, symbols, conditions, and error bars. Describe what is shown without turning captions into unsupported discussion.

## Editing existing text

- Preserve the author's scientific intent and established terminology.
- Fix ambiguity before stylistic polish.
- Remove redundancy and filler.
- Improve paragraph progression and information order.
- Ensure comparison terms and pronouns have explicit referents.
- Match surrounding tense/voice unless consistency is clearly broken.
- Do not restructure the science unnecessarily when only polishing was requested.

Before returning manuscript prose, verify that every paragraph's main claim is supportable and that measured, simulated, inferred, and projected quantities remain correctly distinguished.
