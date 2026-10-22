---
description: "Inspect, review, test, and push an explicitly authorized scoped change."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Perform the requested push workflow for: $ARGUMENTS

1. Inspect the actual repository status, branch, diff, relevant instructions, and proposed commit scope. Identify and preserve pre-existing or unrelated user changes.
2. Confirm the requested scope and explicit authorization for each requested Git action. Ask before staging, committing, or pushing if authorization is not explicit.
3. Reuse completed implementation, verification, and acceptance evidence that still applies. Do not restart planning, implementation, testing, or independent review simply because this is a delivery step. Run only checks needed to establish that the scoped change is safe to deliver; do not require a full suite by default.
4. Review the scoped changes and relevant existing evidence for meaningful defects, safety issues, missing authorization, or missing safeguards. Such blocking findings stop delivery. Report non-blocking suggestions separately and continue; they do not delay accepted functionality.
5. Review the final diff and status; stage only the exact explicitly authorized paths. Never stage scratch artifacts, unrelated files, or user changes. Keep transient/generated output under `<worktree>/scratch/` using the canonical project helper.
6. Commit only with explicit human authorization and only the approved scoped changes.
7. Push only with explicit human authorization to the intended remote and branch.
8. Verify commit and push results and report exact paths, commands, reused/new evidence, and remaining issues.

No force push, destructive Git operations, staging by implication, or authorization inferred from delegation. Subagents inherit these limits; delegation cannot expand authorization.
