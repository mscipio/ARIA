---
name: rdc-implementation-review
description: Independently verify an RDC implementation against every persisted task and acceptance criterion, identifying concrete blocking/non-blocking findings and evidence gaps without inventing new requirements.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Implementation Review

Use this skill for independent post-implementation verification.

## Requirements assessment

1. Read the approved persisted plan in full.
2. Enumerate every task and every explicit acceptance criterion.
3. Verify each criterion against the actual changed code and relevant runtime/test evidence.
4. Classify each criterion as:
   - `PASS`,
   - `FAIL`,
   - `INSUFFICIENT EVIDENCE`.
5. Never return an overall clean verdict while an explicit approved criterion remains unverified or unsatisfied.

## Code review focus

Inspect enough surrounding context to understand callers, invariants, data flow, configuration, tests, and user-visible behavior.

Prioritize concrete:
- correctness bugs,
- regressions,
- security flaws,
- data loss/corruption,
- race conditions,
- broken compatibility,
- invalid assumptions,
- missing verification for meaningful approved behavior.

Every finding must have a credible trigger, impact, repository evidence, and smallest plausible fix. Do not report speculative concerns.

## Severity

- `BLOCKING`: must be fixed before the approved change is safe or functionally complete.
- `NON-BLOCKING`: actionable lower-risk improvement that does not prevent acceptance.

Do not block on style, preference, unrelated pre-existing debt, theoretical edge cases, or redundant test coverage. Load `rdc-testing-discipline` when judging verification adequacy.

Tracked generated artifacts produced deterministically by an approved build/code-generation step are part of the change; inspect them for unrelated output but do not block merely because they changed.
