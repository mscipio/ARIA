---
name: aria-results-analysis
description: Interpret provided experimental or observational results with calibrated claims — artifact and comparability validation, explicit comparisons and metrics, descriptive counts, uncertainty, effect sizes, inference assumptions, practical significance, figure/table reading, and explicit blockers — without code execution or mandated outputs.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Results Analysis

Use this skill whenever the scientist must interpret provided artifacts (files, tables, figures, reported numbers) or experimental results. This skill defines interpretation reasoning over what is supplied; it does not run computations, generate figures, or draft prose.

## Interpretation steps

1. **Validate artifacts and comparability.** Confirm each artifact is what it claims to be; note metric direction (higher/lower better), units, and whether compared results share the same conditions, protocol, and population. Do not compare non-comparable results.
2. **Validate the unit of analysis and dependence.** Identify the independent unit (subject, run, fold, seed, group) and whether rows are independent or repeated/dependent measures. Treat dependent rows as one unit unless the design justifies otherwise; state this before any significance or winner claim.
3. **Lock explicit comparisons and metrics.** State exactly what is compared to what, on which metric, before interpreting differences. Do not mix unrelated comparisons into one undifferentiated table.
4. **Report descriptive counts first.** Sample sizes, run/seed counts, means, and spreads, before any inferential claim. Report complete statistics, not only best scores or p-values.
5. **State uncertainty and inference assumptions.** Report confidence intervals or another justified uncertainty measure, effect sizes, test assumptions, and any multiple-comparison or missingness handling. Choose methods to fit the data and the question; do not apply a universal statistical recipe, and never fabricate statistics from missing inputs.
6. **Distinguish practical from statistical significance.** A statistically detectable difference may be too small to matter; a large difference may be underpowered. State both.
7. **Read figures and tables as evidence.** For each figure or table: why it exists, what exactly the reader should notice, and what that changes in belief or the next decision. A figure that changes nothing is decorative.
8. **Separate observation from mechanism.** Say what was observed versus what would explain it; a mechanism claim needs its own evidence.
9. **State calibrated claims and blockers.** For each conclusion: what supports it, its uncertainty, allowed wording, and forbidden stronger wording. When inputs are incomplete, conflicting, or underdetermined, say so explicitly — never replace missing evidence with confident prose.

## Out of scope

- Running code, generating figures, or producing files — this skill interprets what is supplied; computation belongs to `coder`.
- Mandated output bundles (analysis reports, statistics appendices, figure catalogs).
- Universal/rigid statistical defaults and automatic test fallbacks.
- ML-only framing, paper-writing, Results-section prose, and publication tooling → `writer`.
- Literature search and external evidence acquisition → `researcher`.
- Persistence: no Engram observations, SDD documents, registries, or other durable state.

## Output

Return the validated comparison questions, the descriptive and inferential findings with uncertainty, practical significance, the strongest calibrated claims, and explicit blockers or underdetermination. Route prose to writer and any needed computation to coder.
