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

## Citation verification mode

For a citation-verification or claim-support question, apply this mode alongside the procedure above and return its result fields in the handoff.

1. **Decompose the exact claim** into discrete factual components and verify each against evidence separately; note which component each citation is offered for.
2. **Check source identity/existence separately from claim support**:
   - **Identity/existence** — resolve the canonical identity (title, authors, venue, year, and DOI/PMID or other stable identifier where available). Confirm the source exists and matches the citation. Distinguish preprint from published and report which version you verified.
   - **Content/claim support** — ground substantive support only in the strongest content actually inspectable:
     - **Full text available**: inspect the relevant passage, result, table, figure, or section — not topical similarity to the paper.
     - **Abstract only**: assess only what the abstract supports, and state the abstract-only limitation.
     - **Metadata only**: metadata confirms identity, but never supports a substantive claim.
     - **Content needed but not inspectable**: classify `cannot verify from available evidence` — never infer support. Universal full-text retrieval is not mandatory; use the strongest content available.
3. **Classify support** with exactly one of: `directly supports`, `partially supports`, `indirectly supports/inference required`, `does not support`, `contradicts`, or `cannot verify from available evidence`.
   Never upgrade: topical relevance into support, an abstract into substantive support, association into causation, model results into measured results, or a review's repeated claim into support by the underlying source.
4. **Compare scope**: population/sample, intervention/exposure, comparator, endpoint/outcome, method/conditions, direction, magnitude, temporal scope, and limitations. Record mismatches as limitations.
5. **Primary vs secondary**: when a specific reported result is at issue and the cited source is a review, trace the claim to the primary source it cites before classifying.
6. **Multi-citation clusters**: handle each citation source-by-source; then note which components the cluster supports collectively.
7. **Record evidence location when available** (passage, section, table, figure). Never fabricate a quotation or location.
8. **Retry before cannot-verify**: retry identifiers, queries, or sources (alternate identifier lookup, corrected query, alternate source) before returning `cannot verify from available evidence`. If source identity or required content still cannot be resolved, keep the support classification exactly `cannot verify from available evidence`, explain what identity or content could not be resolved, and provide the next evidence action. The identity field may report unresolved identity, but `unresolved` is never a seventh support classification.

**Result fields** (per claim): return a concise per-claim verification result with these fields — claim; source identity (canonical metadata and preprint/published); classification; rationale; evidence location when available; mismatch/limitation; next evidence action when unresolved. Use a compact table only for batches.

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
