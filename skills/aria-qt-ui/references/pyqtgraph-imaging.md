# pyqtgraph Imaging (display-only discipline)

Patterns adapted from the pyqtgraph documentation (see
`sources-and-licenses.md`). Display mapping is never data.

## ImageView

- Use `ImageView` for 2D/3D array viewing: image item, histogram, and
  region-of-interest wiring come together.
- Keep the data array as the single source of truth; all view state
  (zoom, pan, levels) lives outside it.

## Histograms and LUT

- Histogram + LUT map data values to screen brightness/color for viewing.
- Changing the LUT or histogram range never modifies the array; label
  such controls as display (e.g. "Display range"), not as data edits.

## Window/level

- Window/level (brightness/contrast) is a display-only transform applied
  at render time for inspection comfort.
- Persist window/level as view preferences, never by rewriting pixel
  values; any export states the mapping applied or exports raw data.
- Auto-level on first display is a convenience default the user can
  override, not a measurement.

## Performance honesty

- Downsampling/decimation for display must be labeled as such; voxel
  probe readouts always come from the full-resolution data.
- Never present a rendered pixel as a measured value without stating the
  interpolation.
