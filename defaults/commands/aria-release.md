---
description: "Prepare and verify an authorized ARIA release; never deploy automatically."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Prepare a release for: $ARGUMENTS

1. Reuse the inspect → review → docs → tests → final review → authorized scoped stage/commit/push workflow in `aria-push`; follow all of its authorization and scratch rules.
2. Inspect repository status, current version, tags, changelog, and release conventions. Determine the next version from explicit input when supplied, otherwise project conventions; ask if ambiguous.
3. Confirm scope and explicit human authorization before any staging, commit, tag, or publication. Preserve unrelated and pre-existing user changes.
4. Update version and release notes only when authorized and in scope; do not stage scratch output.
5. Run the existing release gates (typecheck, compile, full tests, lint, package smoke, and release checks) and resolve/report failures.
6. Review the complete diff and exact staged paths; stage only authorized source/release files.
7. Create an annotated version tag and GitHub Release only with explicit authorization; never force, overwrite, or perform destructive Git operations.
8. Verify tag and GitHub Release contents and report evidence. Do not deploy automatically.

Transient/generated outputs belong under `<worktree>/scratch/` via the canonical project helper. Subagents inherit authorization; delegation cannot expand it.
