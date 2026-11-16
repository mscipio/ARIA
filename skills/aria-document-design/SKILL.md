---
name: aria-document-design
description: Design and restructure documents for reader and task fit: information architecture, navigation, sectioning, progressive disclosure, and representation choices, deferring prose, claim, audit, and rebuttal work to their owning skills.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Document Design

Use this skill when a document needs structural design — information architecture, hierarchy or navigation, grouping, progressive disclosure, or representation and layout choices — rather than prose rewriting, claim work, or an audit.

## Principles

- **Reader and task first.** Shape the document around what each reader needs to do and when; lead with the point the reader came for.
- **Intentional scope.** Make explicit what the document covers and what it deliberately leaves out.
- **Progressive disclosure.** Essential content first; push detail, evidence, and edge cases deeper so each reader can stop at the right depth.
- **Group and chunk.** Make each section one coherent unit with an informative heading, label, or summary so readers can navigate without reading everything.
- **Recognition over recall.** Keep prerequisites, definitions, and referents visible where they are used instead of requiring memory of earlier passages.
- **Decision- and work-focused sections.** When the task calls for it, organize sections around decisions, actions, and outcomes rather than narrative chronology, and state acceptance and verification criteria visibly.
- **Reviewer empathy.** Provide an explicit review path — a route from each claim to its evidence and verification — so a reviewer can check the document without reconstructing the author's reasoning.
- **Reduce cognitive load without oversimplifying.** Remove structural friction without omitting necessary detail, forcing brevity, or repeating content to fill space.

## Visibility

Make what the reader needs to judge a document visible:

- **Claims** — what is asserted, and whether each statement is evidence, interpretation, or recommendation.
- **Evidence and method** — what supports each claim and how it was produced.
- **Assumptions, limitations, implications, actions** — what is assumed, what a claim does not cover, what follows if accepted, and what the reader should do.

Layer selectively: summaries for skimmers, full detail for the invested reader, appendices for supporting material. Place prerequisites before the content that uses them.

## Representation

Choose the form per content, not by blanket preference: prose for narrative reasoning, bullets for parallel items, procedures for sequences, tables for comparisons, figures for relationships, equations for precise relations, callouts for emphasis, appendices for supporting detail. No form is right everywhere.

## Process

1. Identify the readers, their tasks, and the prerequisites each needs.
2. Design the hierarchy and navigation, then section the content into coherent units with informative headings and an explicit review path.
3. Layer detail and place prerequisites before use.
4. Choose a representation per section, not once for the whole document.
5. Restructure; then hand prose, content, and verification work to the owning skills below.

## Boundaries

- Scientific prose, section-aware drafting, evidence-bounded claims, and manuscript conventions belong to `aria-academic-writing`. After you restructure, drafting and claim wording return to it.
- `aria-writing-anti-ai` is auxiliary: load it for formulaic or artificial prose only after structure and content are sound.
- Reviewer-comment strategy and rebuttal belong to `aria-review-response`. You may organize the response package's structure, not its argumentation.
- Paper-audit methodology belongs to `aria-paper-self-review`; it may hand navigation restructuring to you. Do not duplicate its claim/evidence audit.
- Do not invent document metadata (names, authors, versions, licenses), impose template scaffolding, or add infrastructure concerns — this skill restructures content, nothing else.
