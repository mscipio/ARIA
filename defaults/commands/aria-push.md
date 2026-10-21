---
description: "Inspect, review, test, and push an explicitly authorized scoped change."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Perform the requested push workflow for: $ARGUMENTS

1. Inspect repository status, branch, diff, and relevant project instructions before changing anything.
2. Confirm the requested scope and authorization; ask before staging, committing, or pushing if not explicit.
3. Review the complete change and identify unrelated/pre-existing user changes; preserve them.
4. Update relevant documentation when in scope; do not edit excluded documentation.
5. Add or update focused tests for the behavior.
6. Run appropriate tests, type checks, and lint; report failures accurately.
7. Review the final diff and status again; stage only explicitly authorized source paths.
8. Never stage scratch artifacts, unrelated files, or user changes. Keep transient/generated output under `<worktree>/scratch/` using the canonical project helper.
9. Commit only with explicit human authorization and only the approved scoped changes.
10. Push only with explicit human authorization to the intended remote and branch.
11. Verify commit and push results and report exact paths, commands, and remaining issues.

No force push, destructive Git operations, staging by implication, or authorization inferred from delegation. Subagents inherit these limits; delegation cannot expand authorization.
