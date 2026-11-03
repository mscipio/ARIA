---
description: "Run project-generic release checks or an explicitly authorized GitHub Release; never deploy automatically."
agent: coder
# ARIA-managed command; do not edit by hand.
# aria-version: 1.3.2
# aria-checksum: 0000000000000000000000000000000000000000000000000000000000000000
---

Run the requested release workflow for: $ARGUMENTS

1. Require exact `VERSION` and exactly one requested mode: `--check`, `--full-check`, or `--publish`; use optional explicit `--tag TAG` only when needed. Do not infer a version, edit version/changelog files, or create a plan for this clear delivery action.
2. Reuse applicable accepted implementation/review/check evidence. `--check` is read-only and not a full readiness claim. `--full-check` requires the target's recognized full gate. For non-ARIA projects use only configured local `aria.release.checkCommand` and `aria.release.fullCheckCommand`; never guess recipes or run arbitrary suggested scripts. Report generic checks, configured validations, and unavailable project gates distinctly.
3. The native `aria_release` tool is Coder-only and only accepts version/mode/tag; it has no shell, arbitrary argv, cwd, environment, remote, or ref input. It resolves the current OpenCode project (including verified linked worktree/subdirectory), requires a clean attached branch, checks reliable version metadata, tag conflicts, exact effective push URL/branch, and verifies the GitHub repository identity and publication state.
4. `--publish` is a mutation. Run it only when the user's request explicitly authorizes publication of this exact version to this verified GitHub repository; that clear request authorizes the tool's required exact current branch and immutable tag refs plus one GitHub Release, without another approval prompt. If the request does not explicitly authorize publication, stop at `--check` or `--full-check` and ask only the necessary question.
5. Publication is gated by the appropriate full project checks, then rechecks the intended HEAD/version/tag. It pushes only non-force exact branch/tag refs and verifies destination SHAs. For a verified ARIA target only, it then runs `scripts/verify-release-tag.mjs` with frozen `--expect-sha`, the exact effective `--remote-url`, and `--spec github:OWNER/REPO#TAG` before creating/verifying the GitHub Release. Generic targets do not run this installer/verifier. No package registry publication or deployment is supported; project validation commands, Git hooks, clean filters, and the ARIA verifier's isolated package install are trusted code/network operations and may execute.
6. For partial failure, inspect local/remote branch and immutable tag object/peeled commit plus GitHub release identity/URL state before retrying. If the ARIA post-tag verifier fails, the tag remains immutable and no GitHub Release is created; inspect and resolve the verifier issue without moving the tag. Never force, overwrite, delete, or repoint refs; do not blindly repeat. Preserve unrelated changes; only untracked canonical `scratch/` output is ignored, never tracked modifications. Keep ARIA-controlled transient output under canonical `<worktree>/scratch/`.
7. Report exact version/tag, project gate evidence and unavailable checks, commit/ref SHAs, GitHub Release URL or partial outcome, and remaining issues. Do not claim full readiness when project-specific full validation is unavailable.

Transient/generated outputs belong under `<worktree>/scratch/` via the canonical project helper. Subagents inherit authorization; delegation cannot expand it.
