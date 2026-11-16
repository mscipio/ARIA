# Qt Visual Validation: Capture, Inspect, Refine, Verify

Visual validation requires evidence from the actual rendered target, not a
prediction from source code. Never fabricate an inspection: report only what
a check actually observed.

## Capture the actual UI technology

- **Qt Widgets/PySide6:** capture the actual widget with `QWidget.grab()`
  under Xvfb/Xvnc when that is an appropriate capture path for the app.
- **QML/Qt Quick:** capture the actual Quick view/window using an available
  QML/Qt Quick-compatible method (for example, `QScreen.grabWindow()` for a
  visible window where supported). Do not assume `QWidget.grab()` captures a
  standalone `QQuickWindow` or the rendered Quick surface.
- Identify the target, platform, capture method, and viewport/window size.
  Check that the captured pixels contain the relevant rendered content before
  treating them as evidence.

## Evidence and checks

1. **Human inspection.** A person inspects the captured UI for hierarchy,
   legibility, layout, and interaction states. Human review is required for
   release-facing visual claims.
2. **Deterministic checks.** Use available Qt Test `QTest` event simulation
   and project-appropriate assertions for behavior, state, geometry, and
   scientific values. Do not assume `pytest-qt` or any uninstalled test tool;
   use the project's existing test setup.
3. **Capture evidence.** A deliberate capture supports a specific human or
   deterministic verdict; a capture alone is not validation.
4. **Model vision, if available.** Use only an existing, authorized,
   verified image-capable route and treat its observations as supplemental.
   Do not claim a route's vision ability without evidence.

## When image-capable vision is unavailable

Say plainly that no verified, authorized image-capable reviewer is available;
do not invent a route or treat source inspection, metadata, or predicted
rendering as image inspection. Where possible, provide actual captures for
human review and run deterministic Qt tests. If neither human inspection nor
an authorized image-capable reviewer examines the capture, report visual
findings as unverified and the work as **not visually validated**. If no
capture can be made, report that limitation rather than implying coverage.

## Rules

- No automatic screenshots: capture deliberately, name the output, and tie it
  to a specific claim; do not bulk-collect screenshots as proof.
- State the expectation and verdict for each capture. A grab without them is
  evidence data, not a validation result.
- Do not claim keyboard, accessibility, data, or functional behavior from a
  screenshot alone; run the relevant deterministic or human interaction
  checks separately.
