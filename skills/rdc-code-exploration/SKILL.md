---
name: rdc-code-exploration
description: Investigate a codebase for a delegated RDC question, tracing symbols, callers, tests, configuration, and data flow into concise repository evidence.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Code Exploration

Use this skill when the explorer must investigate an unfamiliar or partially understood code path.

## Workflow

1. Restate the delegated question internally and stay within it.
2. Use CodeGraph first when it can identify structure, symbols, references, dependencies, impact, or paths.
3. Search broadly enough to find alternate names, call sites, tests, configuration, generated code, and relevant documentation.
4. Narrow to the smallest relevant set of files and symbols.
5. Trace definitions through callers and data flow instead of stopping at the first keyword match.
6. Use Context7 when correctness depends on an external library, framework, or API.
7. Use Engram only for relevant prior decisions or durable context; repository evidence remains primary.
8. Separate verified facts from interpretations and name missing evidence explicitly.

## Evidence standard

- Cite repository-relative paths and line numbers for important claims.
- Name symbols when available.
- Prefer evidence that changes planning or implementation decisions.
- Do not infer invisible behavior from naming alone.
- Do not expand into unrelated cleanup, design, or implementation work.

## Reporting emphasis

Prioritize:
- direct answer to the delegated question,
- relevant locations,
- call/data/dependency flow,
- unresolved unknowns.
