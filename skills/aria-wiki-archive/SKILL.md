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

## Boundaries

- Archival writes raw provenance under `<WIKI_DIR>/raw/`.
- Raw files are immutable provenance. Never edit, delete, reformat, or overwrite them.
- Archival does not compile raw material into curated pages.
- Do not run another mode automatically after archival.
- Report what was archived and stop.
