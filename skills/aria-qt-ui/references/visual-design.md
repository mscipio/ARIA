# Visual Design (desktop, offline)

Hierarchy, typography, spacing, iconography, themes, and interaction
states for desktop scientific apps. Original synthesis authored offline;
nothing vendored (see `sources-and-licenses.md`).

## Visual hierarchy

- Hierarchy through weight, size, and position first; color is
  reinforcement, never the sole carrier (contrast + color-vision safety).
- Three text levels suffice: view title/context, control labels, and
  secondary readouts. A fourth level means two levels are actually one.
- The active element (selected ROI, active layer, focused control) has
  exactly one emphasis treatment (outline + label), applied consistently.

## Typography

- One UI font, the system default; monospace only for numeric readouts
  where alignment matters (coordinates, values, indices).
- Numeric readouts use tabular figures where available so probe values
  do not jitter as digits change.
- Never convey state by color alone: pair color with text or shape
  (e.g. "Modified" label, not just an amber dot).

## Spacing and density

- 8px base grid for control spacing; related controls grouped with
  consistent margins, groups separated by whitespace rather than lines
  where possible.
- Touch/click targets ≥ 24px in at least one dimension; dense panels
  may go denser only with full keyboard equivalents.
- Align to a grid; mixed alignments read as errors (see
  `design-principles.md`).

## Iconography

- Icons are geometric and stroke-based (see `icons/`): 24px grid,
  2px strokes, `currentColor` so themes apply automatically; no embedded
  raster, no fixed colors, no text inside glyphs.
- Every icon ships with a text label or tooltip naming the action;
  shortcuts shown where they exist.
- The shipped set is intentionally small (slice, window/level, ROI,
  compare, theme, probe). Prefer reusing one than adding a near-duplicate;
  a new glyph must be distinguishable at 16px and in grayscale.

## Light and dark themes

- Theme as paired surface/text tokens (background, panel, text, accent,
  border), never ad-hoc colors per widget; Canvas/custom painting reads
  the same tokens so viewports follow the theme.
- Window/level and LUT are display mappings independent of theme: theme
  changes chrome, never data appearance semantics; probe readouts always
  state raw values (see `pyqtgraph-imaging.md`).
- Check both themes for: text contrast (aim WCAG AA for UI text),
  focus-ring visibility, disabled-state legibility, and Canvas overlay
  colors against both light and dark viewport backgrounds.
- OS window frames/decorations are outside app control; do not claim
  full-window theming.

## Interactive states

- Every control defines: default, hover, focused (visible ring,
  never removed), pressed/active, disabled (with reason available via
  tooltip or adjacent text — never silent), and its keyboard path.
- Long operations expose progress + cancel; cancelled work is labeled
  partial or discarded, never presented as complete.
- Selection, focus, and activity are three distinct states with three
  distinct treatments; a control can be selected-but-unfocused and must
  look different from focused.
- Validation failures name the field and the constraint, list all
  failures at once, and move focus to the first failure on demand.
