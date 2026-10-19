# Sources and Licenses

Ideas adapted (not vendored — no upstream files copied into this skill).
Authored offline from prior knowledge on 2026-10-17; no network retrieval
was performed during authoring, so no retrieval date applies. Versions below
are documentation series as known, not pinned to a fetched commit; no verbatim
upstream text is reproduced. The Basis column traces each row: derived rows
name the reference file that adapts the source; synthesis rows state that no
upstream revision applies.

| Upstream source | URL | Version / revision | Access / basis | License | Attribution | Basis |
| --- | --- | --- | --- | --- | --- | --- |
| Qt 6 documentation (Widgets, layouts, signals/slots, accessibility, high-DPI) | https://doc.qt.io/ | Qt 6 documentation series as known; no fetched revision (offline) | Authored offline from prior knowledge on 2026-10-17; no network retrieval; series consulted conceptually | LGPL-3.0 / GPL-2.0/3.0 / commercial (Qt licensing) | The Qt Company; ideas adapted, no code copied | Derived — adapted in `qt-widgets.md` and `design-principles.md`; no verbatim text vendored |
| PySide6 documentation (Qt for Python, Widgets API) | https://doc.qt.io/qtforpython-6/ | PySide6 / Qt 6 documentation series as known; no fetched revision (offline) | Authored offline from prior knowledge on 2026-10-17; no network retrieval; series consulted conceptually | LGPL-3.0 | The Qt Company; ideas adapted, no code copied | Derived — adapted in `qt-widgets.md`; no verbatim text vendored |
| pyqtgraph documentation (ImageView, histograms, LUT) | https://pyqtgraph.readthedocs.io/ | pyqtgraph documentation series as known (0.13 series); no fetched revision (offline) | Authored offline from prior knowledge on 2026-10-17; no network retrieval; series consulted conceptually | MIT | pyqtgraph authors; ideas adapted, no code copied | Derived — adapted in `pyqtgraph-imaging.md`; no verbatim text vendored |
| napari (multidim viewing, layers patterns) | https://napari.org/ | Upstream series consulted conceptually; no fetched revision, no commit hash (offline) | Authored offline from prior knowledge on 2026-10-17; no network retrieval; interaction patterns consulted conceptually | BSD-3-Clause | napari contributors; interaction ideas adapted, no code copied | Derived — adapted in `scientific-workflows.md`; no verbatim text vendored |
| 3D Slicer (medical slice/orientation workflows) | https://www.slicer.org/ | Upstream series consulted conceptually; no fetched revision, no commit hash (offline) | Authored offline from prior knowledge on 2026-10-17; no network retrieval; workflow patterns consulted conceptually | BSD-style (Slicer license) | Slicer community; workflow ideas adapted, no code copied | Derived — adapted in `scientific-workflows.md`; no verbatim text vendored |
| General desktop UI/UX guidance (selective inspiration) | n/a (principles only) | n/a — no upstream revision applicable | Original synthesis authored offline on 2026-10-17; no upstream fetch | n/a | No single source; original synthesis | Synthesis — original synthesis in `design-principles.md`; no verbatim upstream text vendored, no upstream revision applicable |
| Workspace IA/navigation and visual-design guidance (original) | n/a (principles only) | n/a — no upstream revision applicable | Original synthesis authored offline on 2026-10-19; no upstream fetch, no network | n/a | No single source; original synthesis | Synthesis — original synthesis in `workspace-layout.md`, `visual-design.md`, `scientific-constraints.md`; no verbatim upstream text, no upstream revision applicable |
| QML feasibility verdict and transfer gap (verified runtime) | Qt 6 / PySide6 6.9.3 as installed in the Linux/VNC runtime | Verified 2026-10-19 on this runtime (imports, QML modules, Xvnc render, captures); versions are environment facts, not fetched revisions | Evidence in `./scratch/task-p5/qml-smoke/` (`EVIDENCE.md` + inspected captures); design-only, no migration | Runtime subject to Qt/PySide6 licenses (LGPL-3.0); no code vendored | The Qt Company; ideas adapted, no code copied | Derived — adapted in `qml-notes.md`; prototype sources live under `./scratch/`, not in this skill |
| Workspace icon set (original) | n/a — original geometric synthesis | n/a — no upstream revision applicable | Authored offline on 2026-10-19; no upstream source consulted | CC0 1.0 (public-domain dedication; see `references/icons/LICENSE.md`) | Original ARIA synthesis; no attribution required (see `references/icons/ATTRIBUTION.md`) | Synthesis — six SVGs in `references/icons/`; no third-party set vendored (omission documented in `ATTRIBUTION.md`) |

## Offline and dependency statement

- This skill ships only Markdown guidance plus six original SVGs; it adds no runtime
  dependencies, downloads, CLIs, or services.
- No network was used at any point: no icon pack was fetched (hence no
  third-party set is curated — see `references/icons/ATTRIBUTION.md`),
  and the QML verdict was verified against the already-installed
  PySide6/Qt without installing anything.
- License obligations: nothing is vendored, so no upstream license text
  is reproduced here; downstream users of Qt/PySide6/pyqtgraph/napari/3D
  Slicer remain subject to those projects' own licenses.
