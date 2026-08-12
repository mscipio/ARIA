---
name: rdc-implementation-planning
description: Turn repository evidence and a delegated objective into the smallest complete executable RDC implementation plan, with concrete tasks, dependencies, acceptance criteria, and proportional verification.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Implementation Planning

Use this skill before creating a new persisted implementation plan.

## Planning method

1. Understand existing behavior, constraints, conventions, and likely blast radius.
2. Resolve the root cause rather than planning around the visible symptom.
3. Do not invent requirements. Record only material assumptions that affect implementation.
4. Prefer the smallest correct change.
5. Do not add migrations, compatibility layers, abstractions, dependencies, or broad refactors without demonstrated need.
6. Order tasks by dependency.
7. Make each task independently actionable and name concrete files, symbols, or components when known.
8. Integrate concise acceptance criteria directly into each task.
9. Include only the minimum representative verification needed; load `rdc-testing-discipline` when verification design matters.
10. Treat optional, “ideally,” “nice-to-have,” and secondary requirements as subordinate. Omit them when they require meaningful additional architecture or testing unless the user promoted them to requirements.

## Evidence

Use:
- CodeGraph for affected symbols, dependencies, and impact,
- Context7 for current external API/version behavior,
- Engram for relevant prior constraints and decisions.

For a genuinely new objective, retrieve relevant Engram context before creating the plan when Engram is available. Do not perform ceremonial retrieval for continuation of an existing persisted plan.

## Boundaries

- Select one best plan supported by evidence; do not present competing plans.
- Do not implement.
- Do not redesign tests at fixture/mock level unless testing infrastructure is itself the requested work.
- The Plan tool and `.aria/rdc/TASKS.md` remain authoritative for active scope, approval, task status, and revision.
