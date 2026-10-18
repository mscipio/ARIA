# Design Principles (desktop, offline)

Compact desktop layout rules for scientific imaging apps. General UI/UX
inspiration adapted (not vendored) from upstream sources listed in
`sources-and-licenses.md`.

## Hierarchy

- One primary view per window (usually the image); secondary panels dock
  around it, never compete with it.
- Title/header states context (dataset, slice, orientation); status bar
  states coordinates, value, scale — never the reverse.
- Destructive or data-changing actions sit apart from navigation controls.

## Spacing and density

- Group related controls with consistent margins; separate groups with
  whitespace, not lines, where possible.
- Scientific apps are dense by necessity: keep density in control panels,
  keep the image view uncluttered (overlays toggleable, off by default
  unless the task requires them).
- Align controls to a grid; mixed alignments read as errors.

## Resizing and splitters

- The image view expands; control panels keep a fixed or bounded width.
- Use `QSplitter` between view and panels so users recover their layout;
  persist splitter state, not hardcoded sizes.
- Set minimum sizes so controls never collapse to unusable; test at small
  window sizes and at 125%/150%/200% scaling.

## Typography

- One UI font, system default; monospace only for numeric readouts where
  alignment matters.
- Information hierarchy through weight/size, not color alone (contrast and
  color-vision safety).

## High-DPI

- Enable high-DPI pixmap and scaling support at application start; never
  assume 96 DPI.
- Verify icon, text, and overlay legibility at 200% scale; fix clipping
  before polish.
