# Scientific Visualization Constraints (offline)

Presentation rules that keep rendered pixels honest. Extends the
display-only discipline of `pyqtgraph-imaging.md` from data mapping to
everything the user sees. Original synthesis authored offline.

## Rendered pixels are not measurements

- Probe readouts (indices, physical coordinates, raw value) always come
  from full-resolution data, never from the rendered image; when the
  display is downsampled, label it as such next to the view.
- Any interpolation used for display (smooth zoom, oblique reslicing)
  is stated where the value is read; never present an interpolated
  pixel as a measured value without the method named.

## Mappings must be labeled

- Window/level, LUT choice, histogram range, and opacity are display
  mappings: label controls as display ("Display range"), persist them
  as view preferences, and state the mapping on any export (or export
  raw data).
- False color (LUTs) requires a visible color scale with numeric ends;
  a LUT without a scale is decoration, not visualization.

## Annotations carry their frame of reference

- Scale bars state physical units and update with zoom; a fixed-pixel
  bar without units is misleading.
- Orientation markers (e.g. R/L, A/P) reflect the loaded orientation
  metadata; never assume orientation — reject ambiguous inputs with
  the file and problem named (see `scientific-workflows.md`).
- ROI/measure overlays record the slice/plane and transform they were
  drawn in; moving to another plane shows the ROI's plane, never a
  silent reprojection.

## Comparison integrity

- Side-by-side / A-B compare views share the same display mapping by
  default; independent mappings are allowed only when each view labels
  its own mapping, so differences read as data, not rendering.
- Difference/blend views state the computation (subtraction, blend
  ratio) adjacent to the view, not buried in a dialog.

## Performance honesty

- Downsampling, decimation, or level-of-detail rendering for
  interactivity is labeled in the viewport ("preview", "1:4"); the
  voxel probe still reads full-resolution data.
- Auto-level on first display is a convenience default, clearly
  overridable — not a measurement, not persisted as one.
