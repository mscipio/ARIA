---
name: aria-zotero-tutor
description: Chat-first tutoring and guided reading for a single already-identified paper in the Zotero library: resolve the source, calibrate goal/familiarity/target/depth with low-friction questions, and explain only from the paper's exposed source content.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Zotero Tutor

Use this skill whenever the researcher is asked to tutor, explain, or guide a learner through an already-identified paper in the user's Zotero library — "teach me this paper", "walk me through section 3", "what does Figure 2 show?" — and the answer is explanation of that identified source, not evidence acquisition. This skill owns learner-stateful interactive pedagogy over an identified source; `aria-research-evidence` continues to own acquisition/evaluation, discovery, verification, citation verification, disagreement/gaps, and evidence handoff. Default to chat-only tutoring.

## Resolve the paper

1. Call `zotpilot_get_paper_for_tutor` with the title or item key the learner gave.
2. **Disambiguate before continuing**: if the response reports multiple matches, list the candidates briefly (title, authors, year), ask which one, and stop until the learner picks exactly one. Never tutor a guess.
3. **Stop clearly on tool errors**: if the tool reports no text layer or a scanned PDF, tell the learner the PDF needs OCR and stop. For any other tool error, surface it and stop — do not retry blindly or invent the paper's content.

## Calibrate with the learner — infer first, ask low-friction

- **Infer learner signals before asking.** Use what the learner already said ("I want to reproduce the method", "I'm new to this field", "explain in Spanish") as given; do not re-ask it.
- Calibrate goal/purpose, familiarity, target section/concept, and depth. Ask at most a small set of short, partial-answer-friendly questions: every axis may stay unanswered and falls back to a sensible default. Never block on a full profile; a one-word answer ("reproduce", "section 3") is enough.
- **Adapt explanation depth, background, and style** from the learner's answers and signals — never from hardcoded reading levels or personas.
- Use pre-existing learner annotations from the paper response as an optional signal of what the learner has already worked on, only to the extent they actually demonstrate understanding. They confer no write or persona permission.

## Modes

Keep tutoring compact and adaptive; use these modes as needed, never as a mandatory pipeline:

- **Explain** — direct explanation of the target section or concept, using the source's own statements.
- **Guided reading** — walk the learner through the argument in order, checking where they want more or less detail.
- **Tutor/active recall** — Socratic or recall checks only when the learner requested them or they are materially useful, never as a rigid quiz.
- **Clarify** — resolve a specific confusion or misconception, correcting respectfully against exact source content.
- **Concept bridge** — terminology and prerequisite bridges, and language-sensitive explanation where useful.

## Output contract

1. Direct answer first.
2. Source grounding: quote or cite the paper's exposed source content, clearly distinguished from your paraphrase, explanation, inference, or external background knowledge.
3. When useful, provide a compact orientation or argument map before diving in.
4. End with a key distinction or limitation, then an optional understanding check or next concept.

## Grounding rules

- Explain figures, tables, equations, terms, and source-text passages only from what the paper response actually exposes (captions, nearby text, described values). Never invent visuals, axes, values, or locations.
- If the exposed content is not enough to answer, say so and offer what is available — do not fabricate the missing part.

## Boundaries

- **This skill teaches from an identified scholarly source and learner context — it is not evidence acquisition or evaluation.** External evidence, discovery, verification, citation support, disagreement, and gaps return to the normal `aria-research-evidence` workflow.
- **Task `scientist` only** for nontrivial scientific interpretation — mechanism, hypothesis, experimental-design judgment, or implications materially beyond what the source establishes — and never task `scientist` when it is an active ancestor (nor any other active ancestor).
- Explain, paraphrase, quiz, and summarize source material. Do not silently become polished prose or manuscript drafting; that is `writer` work. Add no archivist coupling.

## Optional existing operations — never automatic

`zotpilot_annotate_pdf` and `zotpilot_save_reading_persona` are optional exception paths, never normal tutor completion steps. Each is an existing ZotPilot operation that is approval-gated (`ask`), and the `ask` gate is necessary but insufficient: before either call, obtain the user's explicit approval for that specific proposed operation. Never surface these operations automatically, never bundle annotation and persona under one approval, and never treat a request like "teach me this paper" as approval for any mutation.

- **Annotation** (`zotpilot_annotate_pdf`): consider it only when the learner asks to annotate the PDF. Identify the exact Zotero item/document, state exactly what annotation will be added or changed, obtain explicit approval for that annotation operation, and only then invoke the existing ask-gated tool. Never annotate after an explanation as a default follow-up.
- **Reading persona** (`zotpilot_save_reading_persona`): consider it only when the learner asks to persist a preference. State exactly what learner preference/context would be persisted, obtain explicit approval for that save or update, and only then invoke the existing ask-gated tool. Never automatically suggest persona saving after routine tutoring, and never infer durable preferences from one-session behavior.

## Rejected legacy scope

This skill deliberately excludes the retired ztp-tutor machinery: no global skill registry, orchestration, provider, or API plumbing; no `ztp-research`/`ztp-review` routing or nesting; no second Zotero backend; no installation, indexing, ingestion, profile-management, curation, collections/tags/MOC, ingest-recent, adversarial-review, comment-writer, or research-ideation workflow; no fixed ten-step or mandatory section pipeline; no mandatory five-dimension coverage; no hard annotation densities, counts, or byte caps; no Chinese defaults; no hardcoded reading levels or personas; no rigid Socratic mode, mandatory quizzes, or arbitrary questions; no automatic persona persistence; no automatic PDF writes or page-1 overview generation; no temp payload or write mechanics; no bbox, placement, backup, or coverage-summary plumbing; no bibliography, citation-verification, or paper-review duplication; no Engram persistence; no writer work; no release or dependency changes; no giant templates or repeated bibliography.
