---
name: rdc-implementation-planning
description: Turn repository evidence and a delegated objective into the smallest complete executable RDC implementation plan, with concrete tasks, dependencies, acceptance criteria, and proportional verification.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Implementation Planning

Use this skill before creating a new persisted implementation plan.

## Markdown plan identity and selection

- New plans live at `.aria/plans/<descriptive-slug>-<uuid>.md`. Mint a fresh lowercase UUIDv4 as the immutable `id`, include it in the descriptive filename, and record the exact canonical, worktree-relative path in frontmatter. Check the exact proposed path directly when possible and regenerate if it exists; ordinary glob/list output may omit hidden `.aria/` content and is not proof that the ID is unused. Do not rename or move a plan after creation.
- Several plans may coexist. Never choose a plan by modification time, recency, title similarity, glob order, or a project-wide “active plan” assumption. Continue a Markdown plan only when the user or current coordinator handoff provides its exact `id` **and** path. If a continuation request lacks either, ask for it. A new objective may receive a new plan without searching for older plans.
- Keep legacy work on `.aria/rdc/TASKS.md` and its existing Plan tool only when the user or current handoff explicitly identifies that legacy path. Do not migrate it or make the legacy and Markdown plans authoritative for the same task.
- Use the native OpenCode `edit` permission only. Planner is the only agent granted `edit` on `.aria/plans` and `.aria/plans/**`; other agents retain read access and are denied those edit resources. Never use shell, an auxiliary tool, or another agent as a write workaround. This is tool authorization, not a filesystem sandbox: shell commands and auxiliary tools with side effects may not be confined by native `edit` rules.

## Minimal Markdown schema

Create each file with this structure (omit no section; write `None` when genuinely empty). `state` is `draft`, `approved`, `complete`, or `cancelled`; task status is `pending`, `in_progress`, `completed`, or `blocked`.

```markdown
---
id: "<lowercase UUIDv4>"
path: ".aria/plans/<descriptive-slug>-<same-uuid>.md"
title: "<short title>"
state: draft
created: YYYY-MM-DD
---

# <title>

## Approved contract (proposed while `draft`; frozen at approval)
- Objective: ...
- In scope: ...
- Exclusions: ...
- Constraints: ...
- Acceptance criteria:
  - ...

## Strategy (Adaptable)
- Approach: ...
- Dependencies: ...

## Tasks
### T001 — <task title>
- Status: pending
- Depends on: None | T...
- Relevant paths: ...
- Authorized scope: ...
- Success criteria: ...
- Verification: ...
- Known findings: None recorded | ...

#### Cold-start execution prompt
<A complete task prompt that repeats plan ID/path and task ID, approved objective,
task scope and exclusions/constraints, dependencies, relevant paths, success
criteria, verification, and known findings. It must make sense without this chat.>

## Amendments
- None. Entries are `### A-NNN` with status `proposed`, `approved`, or `rejected`, each citing its own approval entry.

## Progress and Evidence
- ...

## Decisions and Approvals
- ...

## Recovery Handoffs
- ...
```

`id` and `path` form the canonical identity and never change. The approved contract is proposed while state is `draft`; explicit user approval freezes it and sets state `approved`. Before approval, Planner may correct the draft in place after read-only Reviewer feedback. Once approved, the contract is never rewritten. A material change is recorded as an amendment (`### A-NNN`, status `proposed`); its added work stops until the user explicitly approves that amendment, and approval is recorded as a separate entry in `Decisions and Approvals`. Effective scope is the frozen contract plus approved amendments. Proposed or rejected amendments grant no authorization. In-scope strategy and future-task instructions may be adapted without another approval ceremony. Completion requires human acceptance only when the approved contract states it.

Task IDs are stable and never recycled. Record completion status and verification evidence in `Progress and Evidence`; preserve that evidence when revising future tasks. Adapt only future task instructions affected by verified findings, retaining their IDs and dependencies unless evidence requires a dependency correction. Record consequential choices and all recovery handoffs with the exact plan ID/path and task ID, the finding/blocker, and the next actor/action. Do not add session-metadata binding.

Every task's cold-start prompt must be executable without the originating conversation. Do not use references such as “as discussed,” “continue from chat,” or “see prior message” in place of the approved objective, scope, paths, dependencies, acceptance criteria, verification, and known findings. Reviewer corrections are reported to Planner; Reviewer never edits plan files.

## Planning method

1. Understand existing behavior, constraints, conventions, and likely blast radius.
2. Resolve the root cause rather than planning around the visible symptom.
3. Do not invent requirements. Record only material assumptions that affect implementation.
4. Prefer the smallest correct change.
5. Do not add migrations, compatibility layers, abstractions, dependencies, or broad refactors without demonstrated need.
6. Order tasks by dependency.
7. Make each task independently actionable and name concrete files, symbols, or components when known.
8. Integrate concise acceptance criteria directly into each task and its cold-start prompt.
9. Include only the minimum representative verification needed; load `rdc-testing-discipline` when verification design matters.
10. Treat optional, “ideally,” “nice-to-have,” and secondary requirements as subordinate. Omit them when they require meaningful additional architecture or testing unless the user promoted them to requirements.
11. State per-task `.aria/scratch/` placement for ARIA-controlled outputs (canonical `src/scratch.ts`); keep doctor read-only.

## Evidence

Use:
- CodeGraph for affected symbols, dependencies, and impact,
- Context7 for current external API/version behavior,
- Engram for relevant prior constraints and decisions.

For a genuinely new objective, retrieve relevant Engram context before creating the plan when Engram is available. Do not perform ceremonial retrieval for continuation of an existing persisted plan.

## Boundaries

- Select one best plan supported by evidence; do not present competing plans.
- Do not implement.
- Do not redesign tests at fixture/mock level unless testing infrastructure is itself the requested work.
- A new Markdown task uses only the exact `.aria/plans/` identity supplied to you. An expressly identified legacy task continues to use `.aria/rdc/TASKS.md` and the Plan tool; never select either system by recency or use both for one task.
