---
name: aria-paper-self-review
description: Audit a scientific manuscript or section for structure, claim-evidence consistency, overclaiming, clarity, reproducibility, citation gaps, limitations, and submission readiness.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Paper Self-Review

Use this skill when asked to audit or self-review academic prose rather than merely rewrite it.

## Review dimensions

### Structure
- Does the section perform its intended scientific function?
- Is the argument ordered logically?
- Are necessary manuscript sections present when reviewing a full paper?

### Claim audit
For every major claim, ask:
- What evidence supports it?
- Is wording stronger than the evidence?
- Is a measured/simulated/inferred/projected distinction lost?
- Is a causal or novelty claim justified?
- Is uncertainty represented appropriately?

Use one of: keep, weaken, revise, remove, evidence needed.

### Methods / reproducibility
Are details sufficient to understand or reproduce the work at the expected venue level? Are parameters, units, populations/samples, and analysis choices clear?

### Results / discussion consistency
Do results support the conclusions? Are observations separated from interpretation? Are limitations concrete and proportional? Does the conclusion stay inside the tested scope?

### Citations
Mark unsupported external claims as `[CITATION NEEDED]` or `[RESEARCH NEEDED]`. Do not verify bibliographic metadata yourself unless researcher evidence is supplied.

### Writing quality
Check terminology, paragraph focus, redundancy, filler, and formulaic prose. Load `aria-writing-anti-ai` when naturalness is part of the audit.

## Output

Prioritize blocking scientific/claim problems first, then clarity/style improvements. Do not manufacture problems merely to make the review look comprehensive.
