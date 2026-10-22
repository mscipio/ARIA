---
name: rdc-testing-discipline
description: Apply RDC's proportional testing and verification philosophy when planning, implementing, or reviewing changes without expanding scope into exhaustive edge-case or helper-level coverage.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Testing Discipline

Testing exists to establish confidence in approved behavior, not to maximize test count or coverage percentage.

## Core rules

- Prefer the smallest representative verification that demonstrates the approved behavior.
- Favor public interfaces, user-visible workflows, important invariants, and the actual regression being fixed.
- One representative test may cover an entire behavior class.
- Do not require tests merely for every branch, helper, error string, permutation, platform peculiarity, or hypothetical edge case.
- Do not create separate test tasks unless test infrastructure itself is changing.
- Do not design mocks, fixtures, test seams, environment isolation, or permutation matrices during planning unless they are necessary to verify a high-risk requirement or the task specifically concerns testing infrastructure.
- Existing meaningful coverage counts. Do not request a new test when an existing representative test already protects the same behavior class.

## Simplicity

- Reuse known-working patterns before introducing abstractions.
- When a check is small, safe, and reversible, run it early to establish feasibility.
- Implement only the simplest complete functional change that satisfies the immediate objective.

## When more coverage is justified

Require additional verification when an important approved behavior would otherwise be unverified, especially for realistic risks involving:
- security,
- data loss or corruption,
- public compatibility,
- migration/reversibility,
- concurrency/race conditions,
- a demonstrated regression likely to recur unnoticed.

## Role-specific application

- **Planner:** state the behavior that must be demonstrated, not how the test must be implemented.
- **Architect:** remove redundant/combinatorial verification requirements and reject test-driven scope creep.
- **Implementer:** choose the smallest practical test implementation and run the narrowest relevant checks first.
- **Reviewer:** block on material issues—concrete defects, unmet approved criteria, regressions, or violations of explicit protections—not optional preferences, speculative complexity, or hypothetical coverage gaps. Verification duties and the normal review gate are unchanged.

## Acceptance stages

- Before human acceptance, run only minimal essential syntax/build/safety checks and a representative check that demonstrates the real user-facing behavior; retain essential safety checks for consequential risks. No comprehensive suites.
- Distinguish `implemented` (code exists) from `ready for human acceptance` (minimal smoke passes and behavior can be demonstrated), from `accepted` (user confirms the requested behavior), from `regression protected` (focused tests added after acceptance). Awaiting acceptance is never `accepted`; routine internal steps need no separate approvals.
- After explicit human acceptance, add ordinary focused regression tests for the accepted behavior.

## Phase 3: Real-code-first verification

- Prefer safely executing the changed real code through its actual user-facing path. Use synthetic isolated-method checks only when real execution is impractical, unavailable, or unsafe; state the concrete reason and what the check does not establish.
- Never perform dangerous or irreversible operations against production to demonstrate behavior. Use a safe representative environment/data or report that execution was not possible and its limits.

Preserved boundaries: destructive/unauthorized-action, scientific-data, and consequential-security protections, plus plan approval/revision/TASKS.md, setup/lifecycle, and read-only doctor boundaries, stay intact. Do not broaden remediation/review cycles, add plan tasks, commit, release, or stage anything.

Place test fixtures/results the task controls under `./scratch/` via the canonical helper (`src/scratch.ts`); existing meaningful coverage counts — do not add placement-only tests.
