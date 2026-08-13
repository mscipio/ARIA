---
name: aria-research-evidence
description: Produce structured, evidence-bounded research output for a delegated question: discovery, provenance, evidence-level labeling, passage-context expansion, and explicit uncertainty/gap reporting, using the ZotPilot MCP library tools and authoritative external sources.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Research Evidence

Use this skill whenever the researcher must answer a literature, Zotero-library, citation-verification, or claim-support question and return a structured evidence handoff. ARIA owns the research workflow; this skill defines its repeatable procedure.

## Evidence ladder

Prefer evidence from top to bottom. Report the level actually used; never present a lower level as a higher one.

1. **Inspected full text** — the passage was read directly from the full document (or extracted payload).
2. **Passage with expanded context** — a retrieved passage was checked with surrounding context before use.
3. **Abstract / snippet** — only the abstract, a short snippet, or search-result text was seen.
4. **Secondary mention** — another work's description of the source; weakest and must be labeled as such.

Within the same level, prefer **primary/authoritative sources**: the original study, official documentation, standards, or registry records over reviews, blogs, or summaries. Prefer source-type-appropriate authorities (e.g., peer-reviewed primary studies for scientific claims, vendor or library documentation for software behavior).

## Procedure

1. **Restate the question** internally and stay within it. Identify which evidence is library evidence (the user's Zotero library) and which must come from external literature or authoritative web sources.
2. **Discover**:
   - Library evidence: use the ZotPilot MCP research tools directly — `search_papers`, `search_topic`, `search_boolean`, `advanced_search`, `search_academic_databases`, and `browse_library`/`get_paper_details` for metadata.
   - Avoid repeated equivalent searches. Refine or change the query only when the previous result exposed a concrete coverage gap; do not rerun the same broad metadata search merely to inspect more output.
   - Prefer a narrower follow-up MCP query over grepping raw tool-output files when the research backend can answer the question directly.
   - Do not repeat an equivalent library search solely to expose more results. After a broad search, either use its returned identifiers/details, issue a narrower query targeting a specific coverage gap, or stop. Re-running the same search with only a different result limit is not a new research step.
   - External/library-API documentation evidence: use Context7 where it materially improves accuracy.
   - External literature and authoritative web evidence: use `websearch` to locate sources, then `webfetch` to read them; prefer primary/authoritative sources.
   - Keep library-vs-external provenance explicit in every finding: a library item is cited with its Zotero item identity; an external source is cited with its canonical identifier (DOI, URL, standard number).
3. **Verify** before using a passage: for library items, call `get_passage_context` to expand the retrieved passage and confirm what it actually says. For external sources, read the relevant section, not just the snippet. Cross-check a surprising claim against a second source.
4. **label every substantive finding or evidence unit** with the evidence level actually used: `[full text]`, `[expanded context]`, `[abstract/snippet]`, or `[secondary]`. Never promote a level you did not inspect.
5. **Report disagreement, uncertainty, and gaps** explicitly: conflicting findings across sources, weak or single-source support, and evidence gaps. Do not smooth over disagreement; state it with the sources on each side.
6. **Deliver a structured evidence handoff**: findings with source, provenance, evidence level, and a short `Support`/`Disagreement`/`Gap` summary; then an itemized list of disagreements, uncertainties, and gaps; then a list of sources cited (library items by Zotero identity, external sources by identifier).

## Zotero mutation and ingest

- Library search, metadata retrieval, and evidence inspection are read-only and may proceed directly.
- **Never mutate the Zotero library without explicit, separate user approval for each operation.** Mutation tools (`ingest_by_identifiers`, `create_note`, `manage_tags`, `manage_collections`, `annotate_pdf`, indexing) and the `zotpilot` CLI are approval-gated; ask the user, state exactly which records/items and which change, and proceed only after approval.
- Optional ingest of selected DOI records into the library happens only when the user requested it and approved the specific records.

## Boundaries

- This skill defines the researcher's own procedure. Do not invoke or chain user-level `ztp-research`/`ztp-review` skills as a nested workflow, do not install a second Zotero backend or MCP, and do not spawn nested researcher subagents.
- Do not persist anything to Engram automatically, and do not edit project files, maintain the Wiki, draft manuscript/rebuttal prose, or perform software implementation.
- Return the evidence handoff; the requesting agent (coder or writer) decides how evidence is used.

## Handoff format

Return:

**Findings**
- Each finding: the claim, its evidence level, and its source with provenance (library or external).

**Disagreements / Uncertainties / Gaps**
- Itemized, with sources on each side where relevant.

**Sources**
- Library items by Zotero item identity; external sources by DOI/URL/identifier.
