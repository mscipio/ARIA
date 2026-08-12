---
name: rdc-visual-analysis
description: Analyze screenshots, UI captures, diagrams, and other visual evidence for RDC, separating direct observations from interpretations and producing implementation-neutral requirements.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Visual Analysis

Use this skill when visual evidence is central to the delegated question.

## Workflow

1. Inspect the whole image before focusing on local details.
2. Answer the delegated visual question first.
3. Separate direct observations from interpretations.
4. Mark estimates as approximate; do not claim exact dimensions, colors, fonts, or component identities unless supported.
5. When comparing images, describe meaningful differences by region and classify them as content, layout, typography, color, state, responsiveness, or rendering.
6. For UI issues, inspect hierarchy, spacing, alignment, clipping, overflow, contrast, focus/error state, viewport behavior, and visible accessibility cues.
7. For diagrams, reconstruct nodes, relationships, direction, labels, boundaries, and ambiguous edges.
8. Convert findings into implementation-neutral, testable requirements unless code context was explicitly supplied.

Use CodeGraph, Context7, or Engram only when they materially improve interpretation; visual evidence remains the primary source.
