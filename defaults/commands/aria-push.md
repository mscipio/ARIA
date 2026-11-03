---
description: "Inspect, review, test, and push an explicitly authorized scoped change."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Perform the requested push workflow for: $ARGUMENTS

1. Inspect status, branch, diff, relevant instructions, and proposed commit scope from the current OpenCode project (a subdirectory resolves to its verified normal/linked repository root). Preserve pre-existing or unrelated user changes.
2. Use `aria_ship` only when the user's request explicitly authorizes a commit; select exact project-relative files and provide the commit message. Set `push: true` only when the same request explicitly authorizes a push. Do not ask for repeated approval when that request is clear; ask if scope, target, or action is materially ambiguous.
3. `aria_ship` rejects unrelated staged changes and unsafe Git operation state, stages only explicit files (including tracked deletions), verifies the resulting commit delta, and on push resolves one configured push URL and branch ref then verifies the exact remote ref SHA. It does not accept a caller-selected cwd, executable, environment, Git argv, URL, or ref.
4. Reuse applicable implementation, verification, and acceptance evidence; do not restart planning, implementation, tests, or independent review merely because this is delivery. Run only the needed safety checks; no full suite by default.
5. Never infer commit/push permission from edits or a general delivery request. Preserve unrelated changes; never stage scratch output. Transient/generated outputs stay under `<worktree>/scratch/` using the canonical project helper.
6. If commit/push reports partial failure, inspect status, the new local commit, and the exact configured destination ref before retrying. A failed push may leave a local commit; retry the exact same `aria_ship` request only after verifying it matches the intended message/scope. Never reset, amend, force, delete, or repoint as recovery.
7. Report exact files, commit/ref SHAs, destination, checks, and remaining issues. Repository hooks and clean filters are trusted project code and may execute.

No force push, destructive Git operations, staging by implication, or authorization inferred from delegation. Subagents inherit these limits; delegation cannot expand authorization.
