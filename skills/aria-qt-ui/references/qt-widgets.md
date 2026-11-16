# Qt Widgets / PySide6 (offline essentials)

Patterns adapted from the Qt/PySide6 documentation (see
`sources-and-licenses.md`). No network fetch; consult the installed
PySide6/Qt in the environment when behavior is in doubt.

## Layouts

- Compose with `QVBoxLayout`/`QHBoxLayout`/`QGridLayout`/`QFormLayout`;
  prefer layout managers over fixed geometry everywhere.
- `QFormLayout` for labeled parameters; `QGridLayout` for aligned control
  clusters; stretch factors to give the image view priority.
- `QSplitter`, dock widgets, and scroll areas for resizable, persistent
  arrangements; `QScrollArea` when content can exceed small screens.

## Signals and slots

- One signal, one responsibility; name signals after what happened
  (`sliceChanged`), not what should happen.
- Prefer new-style `signal.connect(slot)`; keep slots short and move work
  off the GUI thread (see `scientific-workflows.md`).
- Avoid signal loops between linked controls: guard with blockers or an
  explicit "updating" flag, and document which control is authoritative.

## Dialogs and main window

- `QMainWindow` with menus, toolbars, dock areas, and a status bar for
  the primary window; `QDialog` with accepted/rejected semantics for
  modal parameter entry.
- Validate dialog input before accept; report which field failed and why.

## Accessibility and keyboard

- Every action reachable by keyboard: tab order set deliberately,
  shortcuts on primary actions, visible focus indicators preserved.
- Set accessible names/descriptions on custom widgets and canvas views;
  do not rely on color alone for state (pair with text or shape).
- Respect platform conventions for standard shortcuts and dialog buttons.
