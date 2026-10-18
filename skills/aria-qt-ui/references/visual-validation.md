# Visual Validation (tiered fallback, T001)

Status of each mechanism below comes from T001 findings (verified unless
marked otherwise). Never fabricate an inspection: report only what a
check actually observed.

## Tiers (highest priority first)

1. **Human inspection (primary).** A person looks at the rendered UI and
   confirms layout, legibility, and behavior. Required for release-facing
   claims.
2. **Deterministic checks (primary).** `QTest` key/mouse event simulation
   and programmatic assertions on widget state, geometry, and probe
   values. `QTest` availability: VERIFIED (T001).
3. **Offscreen/framebuffer grabs (supporting).** `QWidget.grab` under
   Xvfb/Xvnc for pixel evidence attached to a human or deterministic
   verdict. Xvfb + Xvnc grab: VERIFIED (T001).
4. **Model vision (unverified).** Route-specific Muse Spark vision:
   UNVERIFIED (T001). Never the basis of a pass/fail claim; at most a
   triage hint restated as unverified.

## Rules

- `pytest-qt`: ABSENT (T001). Do not assume it; use `QTest` directly.
- No automatic screenshots: captures are taken deliberately, named, and
  attached to a specific claim — never bulk-collected as proof.
- A grab without a stated expectation and verdict is data, not validation.
- If no tier ran, say so explicitly ("not visually validated") rather
  than implying coverage.
