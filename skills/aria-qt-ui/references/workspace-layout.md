# Workspace Layout (desktop, offline)

Information architecture and navigation for image-centric scientific apps.
Original synthesis authored offline; nothing vendored (see
`sources-and-licenses.md`).

## Information architecture

- One primary image view per window; every other surface supports it.
  If two views look equally important, the IA is undecided — pick one.
- Header answers *where am I*: dataset name, slice/orientation, view
  preset. Status bar answers *what is here*: cursor indices, physical
  coordinates, raw value, scale. Never swap the two.
- Destructive or data-changing actions live apart from navigation
  (separate group, confirmation where warranted); navigation controls
  never mutate data.

## Navigation patterns

- Dataset / slice / channel / time selectors sit adjacent to the view
  they affect, in a stable location across modes; moving navigation
  between modes breaks spatial memory.
- Bounded controls (sliders paired with spin boxes, one authoritative
  index) make out-of-range states impossible; see
  `scientific-workflows.md`.
- Recently used datasets, saved view presets, and ROI lists are
  navigation too: expose them as lists with keyboard access, not hidden
  behind modes.

## Image-centric workspace

- The image view expands with the window; control panels keep fixed or
  bounded widths (`QSplitter` so users recover their layout; persist
  splitter state, never hardcode sizes).
- Overlays (ROIs, crosshairs, annotations) are toggleable layers, off
  by default unless the task requires them; label by content, not color.
- Keep inspection chrome (histogram, probe readout) docked and
  collapsible so the pixels stay maximal; fullscreen/undocked viewing
  is a presentation option, not a separate mode with separate state.

## Toolbars and sidebars

- One toolbar for the current task's primary actions (open, view
  presets, ROI tools, compare); overflow goes to menus, not a second
  competing toolbar.
- Sidebar order follows the workflow: navigate → adjust display →
  annotate/measure → export. Rarely used controls sink to the bottom
  or into a disclosure, never into the image area.
- Toolbar buttons carry text labels or tooltips plus shortcuts; icon
  alone is insufficient (see `visual-design.md` iconography).

## Contextual panels and dockable tools

- Contextual panels show only what applies to the current selection
  (active layer, active ROI); empty selection shows an explicit empty
  state with the next action, never stale values from a prior selection.
- Dockable tools (`QDockWidget` areas) let users arrange histogram,
  layers, and measurement panels; persist layout per task, restore
  gracefully when a panel is unavailable (log, fall back to default).
- Guard linked-panel signal loops with blockers or an explicit
  authoritative source; document which panel owns shared state.

## Density

- Scientific panels are dense by necessity: dense controls, generous
  image area. Density belongs in panels; the viewport stays uncluttered.
- At small window sizes panels scroll (`QScrollArea`) or collapse; the
  image view never squeezes below a usable minimum — set minimum sizes
  and test at 125%/150%/200% scaling (see `design-principles.md`).
