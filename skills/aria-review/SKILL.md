---
name: aria-review
description: Review a change or plan critically and independently. Checks claims against the real diff and files, hunts for wrong assumptions and edge cases, and reports PASS, FAIL or INSUFFICIENT EVIDENCE with evidence.
---

# Independent review

Your value is finding what the author did not. Assume the author's summary may be wrong or incomplete; trust only what you can read.

## Procedure
1. Restate the goal and acceptance criteria in your own words. If they are missing, derive them from the request and say so.
2. Get the real change: `aria_git` status and diff (or the files named in the plan). List what actually changed and compare it to what was claimed. Flag unintended or missing edits.
3. For each requirement, find the code or content that implements it. Read it fully, including callers and callees that matter. Mark PASS only with evidence you saw, FAIL with the specific defect, otherwise INSUFFICIENT EVIDENCE.
4. Attack it. Ask what input, ordering, state, platform, or failure would break it:
   - boundaries and empty/huge/malformed inputs; units, dtypes, shapes, NaN/Inf, off-by-one;
   - error paths and partial failure; resource cleanup; concurrency and ordering;
   - security: path handling, injection, secrets, permission widening;
   - hidden assumptions, API or data-format compatibility, behaviour on Windows/macOS/Linux;
   - the opposite of what the author tested.
5. Check verification claims: was the thing they say they ran relevant to the change? Would it have failed if the change were wrong?

6. Scientific and numerical code: check dimensional consistency and units, coordinate and orientation conventions (affines, RAS/LPS, voxel order), array shapes and indexing, boundary conditions, NaN/Inf handling, precision and dtype, calibration and scaling factors, statistical assumptions and reproducibility. Say plainly when correctness of the conclusions cannot be judged without data or method.

## Report
Overall outcome PASS / FAIL / INSUFFICIENT_EVIDENCE for the scope you examined, then per requirement with `path:line` or hunk. Findings are BLOCKING (wrong, unsafe, unmet requirement, material regression, missing critical evidence) or NON-BLOCKING. If settling a point needs code to be run, name the exact command and the result that would decide it; you cannot run it. Skip style opinions. Do not ask for new automated tests unless the goal does.

If you are the `reviewer` agent, record the outcome with `aria_review_verdict` before your final message. If you are an implementing agent reviewing your own work, this is self-verification, not an independent review: do not call it one.
