# Scientific Workflows

Interaction patterns adapted from napari/3D Slicer usage (ideas only,
nothing vendored; see `sources-and-licenses.md`).

## Multidim navigation

- Slice slider + spin box kept in sync (one authoritative index); plane
  or orientation selector (axial/coronal/sagittal or time/channel) next
  to the slider it affects.
- Out-of-range indices are impossible by construction (bounded controls),
  not corrected after the fact.

## Zoom, pan, voxel probe

- Zoom/pan are view-only; the voxel probe reads the underlying data at
  the cursor (indices + physical coordinates + raw value).
- Probe readout distinguishes raw value from any display mapping in
  effect.

## Linked views

- When views link (e.g. crosshairs across orientations), one view owns
  the cursor state; others follow. Document the owner; guard signal loops.
- Unlinking is always available; a broken link fails visibly, never
  silently stale.

## Layers

- Layers stack with visibility, opacity, and order controls; the active
  layer is explicit.
- Overlays default off unless the task requires them; label layers by
  content, not color.

## Inputs (DICOM/NIfTI)

- Accept DICOM and NIfTI inputs with orientation/spacing metadata
  preserved and surfaced (axes, voxel size, orientation).
- Reject unreadable or inconsistent inputs with a message naming the
  file and the problem; never guess orientation silently.

## Parameters and background processing

- Validate every parameter before running: range, type, and required
  combinations; report all failures at once with field names.
- Long work runs off the GUI thread with progress reporting and cancel;
  partial results on cancel are labeled partial or discarded, never
  presented as complete.
