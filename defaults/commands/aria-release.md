---
description: "Prepare and verify an authorized ARIA release; never deploy automatically."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Prepare a release for: $ARGUMENTS

1. Reuse valid accepted implementation, verification, review, and push evidence; do not restart planning, implementation, or review, or unconditionally rerun the full test suite. Apply `aria-push`'s status/scope inspection, exact staging, authorization, and scratch safeguards to any requested Git actions.
2. Inspect the actual status, current version, tags, changelog, release conventions, and intended release contents. Require an exact version (ask if absent or ambiguous); do not infer a version silently.
3. Confirm scope and explicit human authorization before staging, committing, tagging, or publishing. Preserve unrelated and pre-existing user changes. Report non-blocking suggestions without delaying acceptance; stop for meaningful defects, safety issues, missing authorization, or safeguards.
4. Update version and release notes only when authorized and in scope; do not stage scratch output. Run only necessary checks beyond reusable evidence, but require and verify: exact version consistency; build/package success; source-to-artifact identity; clean intended release contents; compatibility; and publication result.
5. Stage only explicitly authorized paths. Commit, create an annotated version tag, or publish a GitHub Release only with explicit authorization; never force, overwrite, or perform destructive Git operations.
6. If runtime acceptance is still pending, proceed with a release candidate only when explicitly authorized, disclose the pending acceptance prominently, and never call it fully validated or automatically stable. Otherwise require valid acceptance evidence.
7. Verify tag and published release contents and report exact version, paths, commands, reused/new evidence, publication result, and remaining issues. Do not deploy automatically.

Transient/generated outputs belong under `<worktree>/scratch/` via the canonical project helper. Subagents inherit authorization; delegation cannot expand it.
