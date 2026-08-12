---
name: rdc-plan-review
description: Independently review an RDC implementation plan before approval, checking scope, root cause, task actionability, dependencies, constraints, architecture risk, and proportional verification.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Pre-Implementation Plan Review

Use this skill for the architect's pre-implementation QA mode.

## Review the plan against these criteria

- Every task is independently actionable.
- Concrete files, symbols, or components are named when knowable.
- Dependencies are ordered correctly.
- Acceptance criteria describe the approved behavior.
- Verification is proportional; load `rdc-testing-discipline` when test scope matters.
- The plan targets the root cause rather than a symptom.
- The plan is the smallest complete implementation of the user's request.
- Explicit user constraints are preserved, including no-commit/no-push requirements, compatibility constraints, protected files/areas, and scope boundaries.
- Unspecified behavior has not been converted into new product requirements.
- Optional requirements have not expanded into unnecessary metadata, abstractions, plumbing, or broad tests.
- High-risk concerns are covered proportionally: architecture, security, data integrity, compatibility, reversibility/migration, and unsafe failure modes.

## Correction policy

Be decisive. Correct only what is necessary.

Remove:
- scope creep,
- unjustified abstractions or compatibility layers,
- redundant/combinatorial testing,
- detailed mock/fixture/test-seam design that belongs to implementation,
- theoretical edge-case requirements without realistic impact.

Do not re-plan from scratch when a small correction is sufficient.
