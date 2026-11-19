---
status: done
objective: Fix duplicated or obstructive agent activity in the ARIA TUI sidebar, make the visualizer directly usable with Playwright, and release the changes as a new package.
session: ses_e0aab001fffeKdQXDxjheFEt1V
updated: 2026-11-19
---
# Sidebar and visualizer access

## Scope and constraints
Implement in the `source/` checkout and create the requested release package in the sibling `releases/` directory. Do not install dependencies or add/modify automated tests. Preserve the existing authority-file, secret, and shell restrictions; Playwright access is granted only to the visualizer role. OpenCode user config and deny-only policies remain authoritative.

## Acceptance criteria
- ARIA's plan sidebar no longer repeats the native session/agent list or overlays it with in-app agent lifecycle toasts; plan-change notifications remain.
- `visualizer` is available in either primary or subagent mode and its `playwright_*` calls are allowed by ARIA without per-call prompts.
- User-facing role and dependency descriptions agree with the implementation.
- Relevant existing checks pass; runtime/UI limits are stated honestly.
- The alpha.8 tarball and sidecar checksum are created in `releases/`, and `aria inspect` confirms the package identity matches the source checkout.

## Tasks
- [x] T1 Remove duplicated and obstructive agent activity from the TUI sidebar
    - depends: none
    - done when: ARIA Plan contains plan/review content only, agent lifecycle events do not produce in-app overlays, and plan notifications remain.
    - verified: `npm run typecheck` and `npm run lint` passed; source inspection confirms session-family rows are removed, session changes only trigger attention-gated OS notifications, and plan diffs still toast. Live TUI rendering was not exercised.
- [x] T2 Promote visualizer and allow its Playwright tools
    - depends: none
    - done when: role mode and scoped rules match the request and README, prompt, manager, and dependency descriptions are consistent.
    - verified: `node --experimental-strip-types` role checks passed for `mode: all`, ordinary Playwright allow, unknown MCP ask, default/custom Zotero namespace denies; isolated `opencode debug agents --standalone` on OpenCode 2.3.2 resolved `visualizer` as `mode: all`, with `playwright_*` allowed and `zotero_*` denied.
- [x] T3 Verify and independently review the source changes
    - depends: T1, T2
    - done when: relevant typecheck/lint and available permission/UI checks are run, final diff is inspected, and the required independent review of the final diff is recorded.
    - verified: `npm run typecheck`, `npm run lint`, and `git diff --check` passed; role checks passed for visualizer mode/Playwright allow, unknown MCP ask, and default/custom Zotero namespace denies; isolated `opencode debug agents --standalone` on OpenCode 2.3.2 resolved the expected visualizer permissions. Live TUI rendering was not exercised.
    - review: pass (ses_e0a941ac2ffeeZagxXVwKq4jag, 2026-11-19)
- [x] T4 Version and package the release
    - depends: T3
    - done when: after T3 passes review, `aria pack --out ../releases` creates the final `2.0.0-alpha.8` artifact, and `aria inspect` confirms source/tarball identity and sidecar checksum.
    - verified: After T3 passed review, `npm version 2.0.0-alpha.8 --no-git-tag-version` had package/lock/root versions aligned; `aria pack --out ../releases` created `../releases/aria-2.0.0-alpha.8.tgz`; source and archive identities match (`8df2a253f96a0ba9e1b07f174af13c3433d2e87dcacb55f523ee6f20e4bc7097`, 90 files); `aria inspect` confirmed the sidecar SHA-256 (`984704472e99b0709a24d0adb53f3c107581ae3509b2edad34ebf458a0d94988`).
