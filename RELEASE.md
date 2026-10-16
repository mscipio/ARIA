# ARIA Release Process

Minimal guide for cutting a release. The immutable Git tag is the hard
boundary: everything before it is preparation, everything after it is
verification of that exact tag.

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
