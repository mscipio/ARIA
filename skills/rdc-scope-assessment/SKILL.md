---
name: rdc-scope-assessment
description: Determine whether a post-review RDC finding is remediation within the approved plan or a material scope change requiring renewed human approval.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Post-Review Scope Assessment

Use this skill only when the reviewer is asked to classify an implementation finding after review.

## Method

1. Read the approved plan at the exact ID and canonical path supplied by the coder, plus the reviewer finding. Never discover a Markdown plan by recency or presumed project-wide active status. Use the legacy Plan tool only when the task explicitly identifies `.aria/rdc/TASKS.md`.
2. Identify the specific approved task, acceptance criterion, invariant, or stated scope boundary relevant to the finding.
3. Classify the work as:
   - **WITHIN_SCOPE** when it is necessary to satisfy the already-approved behavior or correct an implementation defect inside that scope (missing `.aria/scratch/` placement alone is WITHIN_SCOPE remediation, not a scope change).
   - **SCOPE_CHANGE** when it adds materially new behavior, architecture, compatibility obligations, dependencies, migration work, or another requirement the user did not approve.
4. Prefer the smallest defensible classification.
5. Do not turn a possible enhancement or theoretical edge case into a scope change unless it is genuinely required for correctness, security, data integrity, or supported compatibility.
6. Authority: the frozen approved contract plus approved amendments only; a proposed or rejected amendment authorizes nothing, so its work stays out of scope until explicitly approved. Remain read-only. The Planner alone records any plan change; material scope additions are recorded as proposed amendments and require renewed explicit human approval before implementation. Native edit denial is not a filesystem sandbox, so do not use shell or side-effecting auxiliary tools to alter a plan.

If it is a scope change, identify only the smallest concrete additional task(s) required.
