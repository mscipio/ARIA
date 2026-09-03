---
name: aria-wiki-archive
description: Archive OpenCode sessions and/or Engram observations into the ARIA Wiki raw provenance store without compiling or modifying curated Wiki pages.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Wiki Archival

Use this skill only after an explicit archival request.

The `archivist` prompt provides resolved `PACKAGE_ROOT` and `WIKI_DIR` paths.

## Commands

Use exactly the appropriate allowed command:
- OpenCode sessions: `python <PACKAGE_ROOT>/wiki-pipeline/run.py archive-opencode`
- Engram observations: `python <PACKAGE_ROOT>/wiki-pipeline/run.py archive-engram`
- Both: `python <PACKAGE_ROOT>/wiki-pipeline/run.py archive-all`

## Refresh (Archive + Compile)

Refresh runs the existing `archive-all` operation above, then hands off to `aria-wiki-compile` only the exact filenames positively reported as newly written by that successful current invocation.

- On archive failure or an ambiguous partial result, stop with no compile.
- When the successful invocation reports zero new files, Refresh is a successful no-op: there is nothing to compile.
- Standalone Archival still reports what was archived and stops; it never hands off to compile.

## Boundaries

- Archival writes raw provenance under `<WIKI_DIR>/raw/`.
- Raw files are immutable provenance. Never edit, delete, reformat, or overwrite them.
- Archival does not compile raw material into curated pages.
- Do not run another mode automatically after archival, except the Refresh handoff above.
- Report what was archived and stop.
