---
name: rdc-plan-review
description: Independently review an RDC implementation plan before approval, checking scope, root cause, task actionability, dependencies, constraints, architecture risk, and proportional verification.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Pre-Implementation Plan Review

Use this skill for the reviewer's read-only pre-implementation Plan QA mode.

## Review the plan against these criteria

- Read only the exact plan `id` and canonical path supplied in the task. Never choose among plans by recency, filename order, or presumed project-wide active status. For explicitly identified legacy work, inspect only `.aria/rdc/TASKS.md` through the existing Plan tool.
- Check that a new Markdown plan is under `.aria/plans/`, its UUID ID and frontmatter path match its filename and actual path, and its ID/path are treated as immutable.
- Revised-task QA (after a substantive future-task revision during execution): check only the revised task's instructions against the frozen approved contract plus approved amendments (proposed or rejected amendments grant no authorization), and return `READY` or `REVISION_REQUIRED` with minimal corrections. Routine status or evidence updates are not reviewed.
- Check the contract for a clear objective, scope, exclusions, constraints, and acceptance criteria. Ensure a draft is identified as unapproved, the contract is distinct from adaptable strategy, and material changes to an approved contract require explicit renewed human approval.
- Check that each task has a stable ID, dependencies, relevant paths, authorized scope, success criteria, verification, known findings, and a cold-start execution prompt that repeats enough context to execute without the original conversation.
- Check that progress/evidence, decisions/approvals, and recovery handoffs are recorded without erasing prior verification evidence when future tasks change.
- Every task is independently actionable.
- Concrete files, symbols, or components are named when knowable.
- Dependencies are ordered correctly.
- Acceptance criteria describe the approved behavior.
- Verification is proportional; load `rdc-testing-discipline` when test scope matters.
- The plan targets the root cause rather than a symptom.
- The plan is the smallest complete implementation of the user's request.
- Explicit user constraints are preserved, including no-commit/no-push requirements, compatibility constraints, protected files/areas, and scope boundaries.
- Unspecified behavior has not been converted into new product requirements.
- Optional requirements have not expanded into unnecessary metadata, abstractions, plumbing, or broad tests.
- Tasks place ARIA-controlled outputs under `.aria/scratch/` proportionally (canonical `src/scratch.ts`); flag missing placement only when the approved behavior requires output.
- High-risk concerns are covered proportionally: architecture, security, data integrity, compatibility, reversibility/migration, and unsafe failure modes.

## Correction policy

Be decisive. Recommend only corrections that are necessary. The Reviewer is read-only; report the smallest changes for the Planner to apply rather than editing or replacing the plan. Native edit denial is not a filesystem sandbox: do not use shell or a side-effecting auxiliary tool to alter a plan.

Remove:
- scope creep,
- unjustified abstractions or compatibility layers,
- redundant/combinatorial testing,
- detailed mock/fixture/test-seam design that belongs to implementation,
- theoretical edge-case requirements without realistic impact.

Do not re-plan from scratch when a small correction is sufficient.
