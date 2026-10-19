# QML Notes (feasibility + transfer gap, offline)

Status of Qt Quick/QML as an *optional, disposable* design-prototyping
aid. Production UI remains Qt Widgets/PySide6. Evidence for the verdict
below lives in `./scratch/task-p5/qml-smoke/` (`EVIDENCE.md`, QML source,
runner, three inspected captures, runner log).

## Feasibility verdict (verified 2026-10-19, this runtime)

- PRESENT and functional: PySide6 6.9.3 / Qt 6.9.3; `QtQuick`,
  `QQuickView`, `QQmlApplicationEngine`, `QQuickWidget` all import;
  `QtQuick.Controls` styles present (Basic, Fusion, Material, Imagine,
  Universal, FluentWinUI3); Xvnc `:1` renders; `QScreen.grabWindow`
  captures real pixels; Light + Dark + simulated-interaction states all
  rendered and genuinely inspected at 800x600.
- Non-fatal note: `libGL ... dri3/nouveau` warnings on Xvnc; rendering
  completed regardless (software fallback). No installs, no new
  dependencies, no network at any point.
- Scope limit: proven on THIS Linux/Xvnc runtime. QML imports or GPU
  paths may differ elsewhere; a missing module is documented as a
  limitation with import/module evidence, never worked around with new
  dependencies.

## What QML prototypes are for

- Disposable layout/IA/theme experiments ahead of any Widgets work
  (e.g. the P6 workbench concepts): proportions, navigation placement,
  light/dark tokens, interaction feel with simulated data.
- Simulated data only; window/level, slice, and probe equivalents are
  display-only properties, mirroring the Widgets display-only
  discipline (`pyqtgraph-imaging.md`).

## Transfer gap: QML → Widgets (explicitly deferred choices)

Nothing transfers automatically; there is no QML→Widgets conversion
step. Each item below is a deliberate re-implementation decision owned
by a future plan, not by the prototype:

- Declarative bindings (`property` + automatic re-evaluation) become
  explicit signals/slots with documented authoritative sources and
  loop guards (`qt-widgets.md`).
- `QtQuick.Controls` styling (including Material/Fusion themes) does
  not carry over: Widgets use `QStyle`/QSS and explicit light/dark
  token pairs (`visual-design.md`); Canvas painting becomes
  `pyqtgraph` `ImageView`/histogram/LUT display mapping.
- Anchor/layout-engine behavior differs: prototype layout lessons
  (e.g. nested-layout `contentItem` care, minimum sizes, splitter
  persistence) transfer as *requirements*, not as code.
- Accessibility mappings differ (`Accessible` attached properties vs
  Qt Widgets accessibility + keyboard/focus contracts); both sides
  keep text+shape redundancy, never color-alone state.
- Validation evidence differs: QML captures are design-orientation
  only; Widgets claims require `QWidget.grab` + `QTest` + human review
  per `visual-validation.md` (T001 tiers).

## Rules

- Design-only: no PIANO migration/embedding, no production adoption
  from a prototype, no automatic conversion tooling.
- Prototypes, captures, logs, and caches live under `./scratch/`
  (task-scoped), offline only, preserving v1.2.0 behavior.
