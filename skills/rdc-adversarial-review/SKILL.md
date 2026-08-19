---
name: rdc-adversarial-review
description: Reviewer-owned adversarial mode that, after a normal implementation review PASS, attacks plausible counterexamples, hidden assumptions, and hostile edge/error/security/ordering paths against the approved plan and existing contracts, returning concrete BLOCKING or NON-BLOCKING findings with surgical-fix intent and bounded remediation.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Adversarial Review

Use this skill only as an optional, reviewer-owned, complementary adversarial pass after the normal `rdc-implementation-review` has apparently passed.

## Why this exact skill name

`rdc-adversarial-review` is a **new complementary reviewer-owned adversarial mode**, not a replacement for normal implementation review and not a new agent. The name signals:

- It is one of the reviewer-owned `rdc-*-review` skills, sharing the reviewer role, permissions, and read-only contract of `rdc-implementation-review`.
- Its posture is adversarial: it attacks an apparently correct implementation rather than checking plan/scope/contract conformance.
- It is complementary: it runs **after** a normal PASS and adds a distinct attack-focused lens; it never duplicates the normal checklist.

## Scope of what is retained

This skill retains only the bounded, useful core of adversarial review:

1. **Target-bounded adversarial focus** — attacks are scoped to the approved plan, the actual changed code, and the contracts/invariants they imply.
2. **Hostile edge/error/security/assumption hunting** — plausible counterexamples, negative paths, permission bypass, state/ordering, semantic-contract violations, untested interactions, and relevant coupling/boundary attacks.
3. **Concrete finding plus surgical-fix intent** — every finding names a specific invariant, a reachable attack scenario, an observed or evidenced failure, and the minimal remediation/verification required.
4. **Realistic-triggerability classification** — findings are classified by whether the attack is plausibly reachable in the actual system, not by theatrical severity.
5. **Bounded remediation and re-review with stop/escalation** — adversarial-origin fixes consume a single adversarial remediation allowance and re-enter the mandatory normal-review gate; exhaustion stops for user direction rather than looping.

## Explicitly rejected legacy concepts

This skill **does not** include, and explicitly rejects, the following retired or unrelated capabilities. None of them may be imported, re-introduced, or bundled here:

- Dual blind judges, new agents/roles, or a second parallel reviewer persona.
- A "Judgment Day" persona, terminal theatrics, or terminal pass/fail states beyond `BLOCKING`/`NON-BLOCKING` findings.
- Arbitrary severity taxonomies such as `CRITICAL` / `WARNING` / `SUGGESTION`, numeric risk scoring, or ranking schemes.
- Mandatory minimum finding counts or line-count thresholds for invocation.
- Old registry, runtime, or delegation adapters; no policy engine, no routing daemon, no persistence surface.
- Universal checklists or generic paranoia applied without regard to the actual change.
- Duplication of the normal implementation review checklist or manufacturing new requirements.
- Unrelated git/PR automation, CI, release, version bump, or tool/MCP/backend changes.
- Any other retired capability not enumerated in the retained list above.

## Boundary with normal implementation review

The two modes have distinct, non-overlapping purposes:

### Normal implementation review (`rdc-implementation-review`)

- Verifies the implementation against the **approved plan**, every persisted task, and every explicit acceptance criterion.
- Checks **scope adherence**, repository contracts and invariants, and proportional verification.
- Classifies each criterion as `PASS`, `FAIL`, or `INSUFFICIENT EVIDENCE`.
- Runs on every implementation as the mandatory first review.

### Adversarial review (this skill)

- Runs **only after** the normal implementation review has apparently passed.
- Assumes apparent correctness and attacks it: plausible counterexamples, hidden assumptions, negative paths, state and ordering hazards, permission and authority bypass, semantic contract violations, untested interactions, coupling, and relevant boundary failures.
- Does **not** duplicate the normal checklist and does **not** manufacture new requirements beyond the approved plan, existing contracts/invariants, reasonably implied backward compatibility, and concrete safety/security properties.
- Desirable but out-of-scope work is reported as `NON-BLOCKING` future work; materially required out-of-scope work stops for architect scope assessment and renewed approval.

## Selective invocation

Adversarial review is **not universal**. The coder chooses whether to invoke it under approved routing policy, based on risk signals such as:

- Permissions, authority, or trust boundaries.
- Mutation of persistent state or external resources.
- Security-sensitive code paths.
- Migrations, schema changes, or data transformations.
- Retries, idempotency, or partial-failure handling.
- Concurrency, synchronization, or caching.
- Public API surface or backward/forward compatibility.
- Complex fallback or failure handling.
- Substantial architectural change.
- Reviewer low confidence in apparent correctness.
- Explicit user request.

There is no policy engine, no automatic trigger, and no line-count or finding-count threshold. The choice is risk-based and coder-driven.

## Methodology

1. **Confirm the normal PASS.** Do not begin adversarial review until the normal implementation review has passed for the current implementation state.
2. **Anchor to the approved plan and contracts.** Read the plan, the changed code, and the contracts/invariants they imply. Do not invent requirements.
3. **Attack, do not re-check.** For each relevant surface, ask what plausible counterexample, hidden assumption, negative path, ordering/state hazard, permission bypass, semantic violation, untested interaction, or coupling failure could defeat the apparently correct implementation.
4. **Require realistic triggerability.** A finding is credible only when the attack scenario is plausibly reachable in the actual system, not in a hypothetical one.
5. **Write concrete findings with surgical-fix intent.** Each finding must name:
   - the invariant under attack,
   - the specific attack scenario or counterexample,
   - the concrete failure that would occur,
   - the evidence (code path, test gap, configuration, caller),
   - the minimal required remediation and verification.
6. **Classify as `BLOCKING` or `NON-BLOCKING`.**
   - `BLOCKING` requires exactly the five fields above **and** a plausible, reachable contract breach. Vague, speculative, or generic test/risk/hardening advice without a reachable breach is **not** `BLOCKING`.
   - `NON-BLOCKING` covers desirable hardening, out-of-scope improvements, speculative risks without reachable evidence, and future work.
7. **Stop at exhaustion.** If the adversarial allowance is consumed and findings remain blocking, stop for user direction rather than looping.

## Mandatory post-finding sequence

After **any** substantive source, behavior, or test change caused by an adversarial finding:

1. Run the **normal implementation review again** on the updated state.
2. Require its `PASS` before any adversarial re-review.
3. Normal review is **never replaced, bypassed, or shortened** by adversarial review.

This gate applies after every adversarial-origin substantive fix, not only the first.

## Final accepted-state invariant

After the **last substantive implementation change**, both of the following must hold:

- The normal implementation review has passed.
- The adversarial review has passed.

Only purely non-behavioral cleanup (formatting, comments, whitespace, naming without semantic effect) may be handled proportionally without re-running both modes.

## Independent cumulative allowances

The two modes keep **independent, non-resetting** cumulative counters. Neither mode refreshes or extends the other's allowance.

### Normal mode (unchanged)

- First pass.
- At most **one** normal-remediation implementation round.
- Second pass; stop for user direction if still blocking.

### Adversarial mode

- At most **one** adversarial-origin remediation implementation round.

### Interaction

- An adversarial-origin substantive fix **consumes the adversarial allowance** and immediately enters the mandatory normal-review gate.
- That normal gate **does not reset or extend** the normal allowance.
- If the normal gate blocks, use only any **still-unused** normal remediation allowance; stop for user direction if that allowance was already consumed or its second normal pass blocks.
- Any further substantive fix must again pass normal review before adversarial re-review, **without refreshing the consumed adversarial allowance**.
- If adversarial re-review remains blocking after the allowed adversarial remediation, stop for user direction.

## Authority limits

This skill's authority is limited to:

- The approved plan.
- Existing repository contracts and invariants.
- Reasonably implied backward compatibility.
- Concrete safety and security properties.

Desirable but out-of-scope work is `NON-BLOCKING` future work. Materially required out-of-scope work requires architect scope assessment and renewed approval before it becomes blocking.

## Finding format

Use exactly two classifications: `BLOCKING` and `NON-BLOCKING`.

A `BLOCKING` finding must include exactly these fields, in this order:

- **Invariant** — the specific contract, property, or guarantee under attack.
- **Attack scenario/counterexample** — the plausible, reachable way the invariant can be violated.
- **Failure** — the concrete failure that would occur.
- **Evidence** — the code path, configuration, caller, or test gap that supports the attack.
- **Required remediation/verification** — the minimal change and the check that proves it.

A `BLOCKING` finding additionally requires a **plausible, reachable contract breach**. Vague, speculative, or generic test, risk, or hardening advice without such a breach is `NON-BLOCKING`.

A `NON-BLOCKING` finding states the concern and, where useful, a suggested future improvement, without blocking acceptance.
