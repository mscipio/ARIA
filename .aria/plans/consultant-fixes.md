---
status: active
objective: Fix the confirmed safety and state defects and make the existing sidebar clearer without redesigning it.
session: ses_e0a69c266ffeCW3nnkMdVM91I0
updated: 2026-11-19
---
# Focused consultant fixes

## Scope and constraints
Keep the existing architecture and preserve pre-existing working-tree edits. No installs, release builds, commits, broad refactors, or new automated test files. Use existing checks and isolated disposable verification. Sidebar changes stay compact and reuse existing commands.

## Acceptance criteria
Private config permissions survive writes; dependency adoption cannot silently leave an untracked partial commit; rollback includes owned generated adapters. Outstanding review failures remain visible, read-only shell calls are not presented as edits, and notification limiting preserves urgent updates. Sidebar status remains discoverable with truncation and keyboard-only use.

## Tasks
- [x] T1 Correct manager writes, dependency adoption, and adapter rollback
    - depends: none
    - done when: isolated permission, adoption-failure, and rollback checks demonstrate recovery and ownership preservation
    - verified: Disposable Node checks demonstrated mode preservation/private defaults, handled adoption rollback, crash recovery before/after commit, adapter restoration, modified-adapter blocking and keep-tools preservation; additional conflict checks preserved user changes and referenced tool copies. Logs are in this session's scratch.
    - review: pass (reviewer session ses_e0a3c47caffe2oY61NIEVsig4w, 2026-11-19; 0 blocking; live OpenCode not exercised)
- [x] T2 Correct review-state and notification handling
    - depends: none
    - done when: FAIL survives pending/insufficient re-reviews, shell activity is labelled honestly, and important plan notifications survive batching
    - verified: Inline checks exercised pending and insufficient re-reviews, history trimming and JSON reload, later PASS, shell wording, truncation-safe critical labels and bounded alert bursts with attention retained.
    - review: pass (reviewer session ses_e0a3c47caffe2oY61NIEVsig4w, 2026-11-19; 0 blocking)
- [x] T3 Refine the existing sidebar without redesign
    - depends: T2
    - done when: critical status precedes titles, off-window blockers are visible, selection/fallback states are explained, and collapse has a command alternative
    - verified: Inspected the delegated src/tui.tsx diff and existing command registration pattern; project typecheck and lint pass. No live OpenCode TUI rendering or keyboard trial was available.
    - review: pass by reading only (reviewer session ses_e0a3c47caffe2oY61NIEVsig4w, 2026-11-19; live rendering not verified)
- [x] T4 Verify and independently review the focused changes
    - depends: T1, T2, T3
    - done when: typecheck, lint, isolated behavior checks and diff inspection finish and blocking review findings are resolved
    - verified: npm run typecheck, npm run lint and git diff --check pass on the current tree.
    - review: pass (reviewer session ses_e0a3c47caffe2oY61NIEVsig4w, 2026-11-19; 0 blocking findings)
