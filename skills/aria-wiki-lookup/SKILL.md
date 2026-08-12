---
name: aria-wiki-lookup
description: Perform a strictly read-only lookup in the configured ARIA curated Wiki, using index-first retrieval plus one bounded coverage expansion and explicit source-page reporting.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Wiki Lookup

Use this skill only for read-only Wiki retrieval.

The resolved Wiki path is provided in the `archivist` agent prompt as `WIKI_DIR`.

## Workflow

1. Read `<WIKI_DIR>/wiki/index.json` directly.
2. Match the user's query against page filenames, titles, summaries, keywords, and links.
3. Read only the strongest matching curated Markdown pages.
4. If the index is missing or unusable, inspect available curated page names and read only plausible candidates.
5. Perform one bounded coverage pass: expand the query using directly related terms surfaced by the strongest matches, such as subsystem names, component names, or close synonyms.
6. Read any additional clearly relevant pages from that single expansion.
7. Return concise findings and identify the source Wiki pages used.

The context primer at `<WIKI_DIR>/.state/context-primer.md` may be read when it materially helps retrieval. It is never required.

## Hard read-only boundary

Never:
- archive OpenCode sessions,
- archive Engram,
- run lint,
- regenerate the primer,
- compile/update pages,
- modify indexes/logs,
- initialize or mutate Wiki state.

If retrieval fails, report the access/configuration failure. Partial diagnostics or filenames alone are not evidence that information is absent, and unsupported domain knowledge must not substitute for failed retrieval.
