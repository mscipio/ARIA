# Generic `aria release` Interface

The CLI targets the current Git project from its invocation directory (including a project subdirectory or verified linked worktree), never the ARIA installation. It does not infer a version or edit project files.

Use an ARIA installation that includes this CLI (`aria release` is unavailable in older installed versions); the target project needs Git and an authenticated GitHub CLI (`gh`) session for destination/state verification. The target does not need Node/npm unless its own configured validation gate requires them. ARIA itself requires Node.js `>=20.19.0`; the generic release command does not install dependencies or alter global configuration.

```sh
aria release 2.4.0 --check [--tag release-2.4.0]
aria release 2.4.0 --full-check [--tag release-2.4.0]
aria release 2.4.0 --publish [--tag release-2.4.0]
```

Exactly one mode is required. `--check` is read-only and reports generic branch/HEAD cleanliness, version metadata when recognized, tag conflicts, configured effective push URL/current push branch, verified `github.com` repository, and existing release state. It may run a project fast-check if configured; a passing preflight without one says so and is not a full readiness claim. Enterprise GitHub hosts are deliberately unsupported. `--full-check` requires a project full gate. `--publish` requires the same full gate and a separate explicit user request; it rechecks the clean HEAD/version/tag, pushes only the exact current branch ref and annotated immutable tag object without force, runs the existing destination-aware ARIA post-tag verifier when the target is verified ARIA, then creates and verifies one GitHub Release. It never publishes npm, PyPI, binaries, or deploys.

For non-ARIA projects, configure trusted repository-owned checks using local Git config (one value per command):

```sh
git config --local --add aria.release.checkCommand 'python -m pytest -q'
git config --local --add aria.release.fullCheckCommand 'python -m build'
```

The project must intentionally configure these commands; the CLI does not guess from package scripts, CI files, or language metadata. Configured commands run as trusted project code with the repository root as cwd. A missing full gate blocks `--full-check` and `--publish`. Recognized version metadata currently includes `package.json`, `[project].version` in `pyproject.toml`, and `[package].version` in `Cargo.toml`; conflicting metadata blocks release. Other project version systems need an explicit compatible version source before they can be cross-checked.

Tag convention resolution is explicit `--tag`, local `aria.releaseTagTemplate` (exactly one `{version}`), or a single unambiguous existing `v`/unprefixed semantic tag convention. If none is established or conventions conflict, pass `--tag`. Release operations require one effective configured Git push URL that resolves to a GitHub owner/repository, an attached current branch with a push ref, and `gh` access to verify that exact GitHub repository. Credentials are never accepted as tool input or printed.

Untracked files under a real canonical `<worktree>/scratch/` directory do not block release checks; tracked changes (including tracked scratch files) and all other untracked files still block. If publication fails after a tag or branch push, inspect the local tag object, configured remote branch/tag SHA, and GitHub release state before retrying. Existing mismatched tags/releases are conflicts; tags are never moved/deleted, refs are never force-pushed, and repeated publication is allowed only when exact identity is verified. Repository validation commands, hooks, clean filters, and the ARIA post-tag verifier's isolated exact-tag install are trusted code/network operations and may execute. Native `aria_release` is Coder-only and offers no shell, arbitrary arguments, environment, executable, cwd, remote, or ref parameters.

## ARIA Project Release Guide

Minimal guide for cutting a release. The immutable Git tag is the hard
boundary: everything before it is preparation, everything after it is
verification of that exact tag.

For this repository, use `aria release VERSION --check` for stages 1–4 of the fast gate, `--full-check` for the existing six-stage `npm run release:check` gate, and `--publish` only when explicitly authorized after the full gate. The target is recognized as ARIA only when its `package.json` name and release-check script match the existing ARIA release workflow; those recipes are not imposed on other projects. After branch/tag refs verify, publication runs the existing `scripts/verify-release-tag.mjs` before GitHub Release creation with the frozen `--expect-sha`, exact configured `--remote-url`, and `--spec github:OWNER/REPO#TAG`; its isolated package install is the established network step. The verifier retains compatible defaults (`origin`, `github:mscipio/ARIA#TAG`) for manual legacy invocation. If that step fails, the immutable tag remains and no GitHub Release is created: inspect the exact destination tag and verifier output, fix only an authorized project issue, and recover without changing/repointing the tag.

## Preparation (relaxed)

- Multiple release-preparation commits are allowed. There is **no
  exactly-one-preparation-commit rule**.
- If a harmless pre-tag correction is still needed (e.g. a fixture or
  comment fix), just fix it, rerun `npm run release:check`, and tag the
  final reviewed HEAD. Only the tag is immutable, not the path to it.
- Never move, delete, or re-point a pushed tag to "fix" a release. Cut a
  new version instead.

## Flow

1. `npm run release:check` — canonical pre-tag gate (version/package
   sanity → compile + dist sync → typecheck → targeted ESLint →
   `git diff --check` → focused lifecycle/hotfix Vitest subset →
   `npm pack` + isolated install + bare `aria` smoke). Must pass on the
   commit you intend to tag.
2. `git commit` — land any remaining reviewed preparation work.
3. `git tag vX.Y.Z` — tag the final reviewed HEAD (semver, e.g. `v1.1.1`).
4. `git push` — push the commits, then the tag (`git push origin vX.Y.Z`).
5. `npm run verify:release-tag -- vX.Y.Z` — short post-tag smoke
   (`scripts/verify-release-tag.mjs`): verifies tag→commit identity,
   installs the exact remote tag in isolation, checks bare
   `aria --version`, proves the installed package is not checkout-backed,
   and runs only short `doctor` / `upgrade --check` / `models` smokes.
   It does not rerun behavioral qualification or the full suite.
6. GitHub Release — publish the release notes for the tag.

## Out of scope

This process changes no product behavior: no lifecycle behavior, TUI,
dependency semantics, model routing, OpenCode compatibility work, or
live migration.
