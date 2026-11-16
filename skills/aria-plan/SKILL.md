---
name: aria-plan
description: Write or resume a durable plan in .aria/plans/ for large, multi-step or risky work. Covers when to plan, the file format, and how plan, execution and verification state stay separate.
---

# Planning in ARIA

## When
Plan when the work spans many files or phases, is risky or hard to reverse, or will outlive this session. Do not plan a small, clear change.

## Where and how
- One Markdown file per objective: `.aria/plans/<short-slug>.md`. It is tracked in Git and meant to be read and edited by hand.
- Edit it with the normal `write`/`edit` tools. There is no plan tool and no second checklist; native todos, if you use them, only mirror this file.
- Ownership: `session:` names the root session that works on the plan. Your context lists the plan owned by your session (resume it) and other active plans (not yours). Take over another plan only when the user refers to it; then replace its `session:` with yours. Do not create a duplicate of an existing plan.
- Plans live at the top level of `.aria/plans/` only; links, nested folders and non-`.md` files are ignored.

## Format
```markdown
---
status: active        # active | done | abandoned
objective: One sentence: the outcome, not the activity.
session: ses_...      # plan owner id from your context (the root session working on it)
updated: YYYY-MM-DD
---
# Short title

## Scope and constraints
What is in, what is out, authority limits (no installs, no push, no new tests unless approved...).

## Acceptance criteria
Observable statements that can be checked. Prefer existing tests, type-checks, commands and file contents.

## Tasks
- [ ] T1 Imperative task title
    - depends: none
    - done when: the specific check that shows it works
- [ ] T2 Next task
    - depends: T1
    - done when: ...
```

## Three kinds of state, kept apart
- **Plan state** is the checkbox: `[ ]` pending, `[~]` in progress, `[x]` executed, `[!]` blocked (add `- blocked: why`).
- **Verification state** is a `- verified:` line under the task, written only after you actually checked: what you ran or read, and what it showed. It is a record of evidence, not proof: tools display it as "evidence recorded". `[x]` without `verified:` is reported as executed, not verified. A subagent finishing is not evidence.
- **Review state** is a `- review:` line under the task: `required` (decided, not done), `not-required` (Level 0), `skipped: <reason>` (Level 1 omitted), or `pass` / `fail` / `insufficient` plus the reviewer session and date. Write pass/fail/insufficient only when the recorded review state in your context says so. A review covers the changes it examined: after substantial new edits, set it back to `required`. A PASS on one task says nothing about other tasks or the whole plan.
- **Execution state** (which agent is doing what right now) lives in OpenCode sessions. Do not record it here.

## Keeping it useful
- Keep the objective fixed; change tasks, not the goal, unless the user changes the goal. If scope grows beyond the objective, add tasks and say so in the report.
- Few meaningful tasks beat many trivial ones. Each task should be completable and checkable in one sitting.
- When all tasks are `[x]` and verified, set `status: done`. If work is abandoned, set `abandoned` with a one-line reason.
- Do not record transient observations or logs here; those belong in scratch.
