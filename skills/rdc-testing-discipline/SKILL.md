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
- **Reviewer:** judge whether meaningful approved behavior is protected; do not block on theoretical or redundant coverage gaps.
