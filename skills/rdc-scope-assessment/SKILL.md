---
name: rdc-scope-assessment
description: Determine whether a post-review RDC finding is remediation within the approved plan or a material scope change requiring renewed human approval.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Post-Review Scope Assessment

Use this skill only when the architect is asked to classify a reviewer finding after implementation.

## Method

1. Read the current approved plan and the reviewer finding.
2. Identify the specific approved task, acceptance criterion, invariant, or stated scope boundary relevant to the finding.
3. Classify the work as:
   - **WITHIN_SCOPE** when it is necessary to satisfy the already-approved behavior or correct an implementation defect inside that scope.
   - **SCOPE_CHANGE** when it adds materially new behavior, architecture, compatibility obligations, dependencies, migration work, or another requirement the user did not approve.
4. Prefer the smallest defensible classification.
5. Do not turn a possible enhancement or theoretical edge case into a scope change unless it is genuinely required for correctness, security, data integrity, or supported compatibility.

If it is a scope change, identify only the smallest concrete additional task(s) required.
