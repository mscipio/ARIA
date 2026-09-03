---
name: aria-wiki-compile
description: Curate explicitly targeted ARIA Wiki raw provenance into atomic Wiki pages, preserving provenance, deduplicating existing knowledge, and maintaining indexes/logs.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Wiki Compile / Update

Use this skill only after an explicit request to curate raw Wiki provenance.

The `archivist` prompt provides resolved `PACKAGE_ROOT` and `WIKI_DIR`.

## Workflow

For each targeted raw file under `<WIKI_DIR>/raw/`:

1. Read the complete raw source.
2. Extract durable concepts.
3. Use `<WIKI_DIR>/wiki/index.json` to locate potentially overlapping curated pages.
4. Read relevant existing pages before deciding.
5. Choose the smallest appropriate action:
   - create a new atomic page,
   - update an existing page,
   - skip because durable information is already represented or has no lasting value.
6. When updating, preserve existing content and provenance unless the source explicitly corrects/supersedes it.
7. Add the raw source filename to the page's YAML `sources`.
8. Follow `<PACKAGE_ROOT>/wiki-pipeline/docs/instructions.md` for page schema, frontmatter, links, and format.

After processing:
- regenerate `wiki/index.md`,
- regenerate `wiki/index.json` with synchronized page metadata and `page_count`,
- append creates/updates/skips and rationale to `wiki/log.md`,
- run the allowed primer command only when structural change makes it useful,
- run the allowed lint command when useful.

Consult `<PACKAGE_ROOT>/wiki-pipeline/docs/compile-workflow.md` when detailed curation policy is needed.

## Refresh (Archive + Compile)

Refresh enters the existing compile workflow above, curating only the handed-off new sources from the successful `archive-all` invocation in this Refresh.

- The handoff set is never inferred: not from directory scans, timestamps, trackers, or previous runs.
- On incomplete or ambiguous invocation output, stop without compiling.
- Standalone Compile never archives.

## Boundaries

- Raw files are immutable provenance.
- Engram observations are raw sources, not automatically curated truth.
- Do not archive automatically before compilation.
- Do not bridge unrelated external material into the Wiki.
- Do not infer missing facts from partial retrieval.
- Compile is agent-driven Wiki read/edit: read each handed-off raw source, then create or update curated pages with the Wiki read/edit grants.
- No `run.py` compile/update command exists (`run.py` supports only `archive-opencode`, `archive-engram`, `archive-all`, `lint`, `search`, `primer`). Do not search for or invent a compile/update command. This rule fixes the observed lint-then-blocked misbehavior: running lint and then stalling while searching for a compile command.
