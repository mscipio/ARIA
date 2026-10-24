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

When an approved persisted plan governs the implementation, preserve the full plan-based RDC review:

1. Read the approved persisted plan in full.
2. Enumerate every task and every explicit acceptance criterion.
3. Verify each criterion against the actual changed code and relevant runtime/test evidence.
4. Classify each criterion as:
   - `PASS`,
   - `FAIL`,
   - `INSUFFICIENT EVIDENCE`.
5. Never return an overall clean verdict while an explicit approved criterion remains unverified or unsatisfied.

When no approved persisted plan governs a fast-path implementation, assess it against the original user request instead: identify the requested behavior and affected behavior, inspect the implementation for that behavior, and assess relevant verification evidence. Classify the requested behavior as `PASS`, `FAIL`, or `INSUFFICIENT EVIDENCE`; do not invent plan tasks or acceptance criteria, and do not require a persisted plan merely to review the fast path.

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

Separate material blockers from non-blocking suggestions. Report useful non-blocking improvements, but do not delay acceptance or turn them into blockers; preserve independent review where the full RDC workflow or meaningful risk requires it, without repeating a valid completed review in later delivery steps.

## Provenance baseline

Establish or reference the pre-implementation worktree state before attributing findings. Distinguish pre-existing files/findings from implementation-introduced changes, but review the full approved implementation diff to the same standard. Do not misattribute pre-existing untracked state to the implementation, and do not excuse an introduced defect because its file also contains pre-existing issues. This changes no clean-tree or update gate.

## Severity

- `BLOCKING`: must be fixed before the approved change is safe or functionally complete.
- `NON-BLOCKING`: actionable lower-risk improvement that does not prevent acceptance.

Do not block on style, preference, unrelated pre-existing debt, theoretical edge cases, or redundant test coverage. Load `rdc-testing-discipline` when judging verification adequacy.

Tracked generated artifacts produced deterministically by an approved build/code-generation step are part of the change; inspect them for unrelated output but do not block merely because they changed.

Before creating transient/generated verification artifacts (for example, logs or test results), invoke the native `scratch_task` tool with the approved task ID and a concise, descriptive task name, then use the returned paths under the UTC-date directory. Fail closed if task identity, project location, or allocation is unavailable; never invent paths or fall back to `process.cwd()`. Verify ARIA-controlled outputs use those paths; do not invent placement requirements for outputs the approved plan does not require.
