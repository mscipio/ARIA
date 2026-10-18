---
name: aria-qt-ui
description: Offline Qt Widgets/PySide6 desktop UI guidance for scientific imaging apps: layouts, signals/slots, accessibility, pyqtgraph display, multidim workflows, and honest visual validation.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Qt UI

Use this skill when building or reviewing a desktop Qt Widgets (PySide6)
interface for a scientific imaging application. All guidance is offline and
self-contained: never fetch from the network, download data or packages, or
depend on a CLI/service at runtime. Adapt ideas from the references; nothing
upstream is vendored.

## Workflow

1. **Layout first** — see `references/design-principles.md`: hierarchy,
   spacing, density, resizing, splitters, high-DPI.
2. **Build with widgets** — see `references/qt-widgets.md`: layouts,
   signals/slots, dialogs, keyboard access, accessibility.
3. **Show images honestly** — see `references/pyqtgraph-imaging.md`:
   `ImageView`, histograms/LUT, window/level as display-only mapping, never
   presented as data.
4. **Support the science workflow** — see
   `references/scientific-workflows.md`: multidim navigation,
   slice/orientation, zoom/pan/voxel probe, linked views, layers,
   DICOM/NIfTI input, parameter validation, background
   processing with progress/cancel.
5. **Validate without fabrication** — see `references/visual-validation.md`:
   `QWidget.grab` under Xvfb/Xvnc, QTest, tiered fallback. Never claim an
   inspection that did not happen; no automatic screenshots.
6. **Attribute** — upstream sources, licenses, and the offline basis are
   recorded in `references/sources-and-licenses.md`.

## Boundaries

- Offline only: no runtime downloads, CLIs, or services.
- Window/level, LUT, and histogram adjustments change display only, never data.
- Visual validation follows the tiered fallback in
  `references/visual-validation.md` with human + deterministic checks
  primary; route-specific model vision is UNVERIFIED (T001) and never
  substitutes for an inspection.
- This skill owns desktop UI guidance only; it does not add agents, MCPs,
  dependencies, or config subsystems.
