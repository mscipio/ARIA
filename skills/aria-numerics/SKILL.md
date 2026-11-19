---
name: aria-numerics
description: Care points for writing or changing numerical and scientific code (Python, MATLAB, legacy codebases): units, dtypes, shapes, reproducibility, validation against known cases, and safe handling of large datasets.
---

# Numerical and scientific code

- **Specification first.** Know the quantity, its units, its expected range, and the formula or algorithm reference. If the scientific meaning is unclear, ask `scientist` for the specification instead of guessing.
- **Units and conventions.** Make units explicit at interfaces. Check axis order, indexing base (MATLAB 1-based, column-major vs NumPy row-major), coordinate systems, and sign conventions before porting.
- **Types and shapes.** Be deliberate about dtype (float32 vs float64, integer overflow, complex), broadcasting, and implicit squeezing. Fail loudly on shape mismatch rather than broadcasting silently.
- **Non-finite values.** Decide how NaN/Inf/zero-division are handled; do not mask them silently.
- **Reproducibility.** Seed random generators explicitly, keep stochastic and deterministic parts separable, and record the parameters that produced a result.
- **Validate against something.** An analytic case, a known limit, a conserved quantity, a published value, or the legacy implementation's output on a small fixture. Say which one you used and how close the agreement is. Agreement with the legacy code is evidence of equivalence, not of correctness.
- **Legacy code.** Preserve behaviour first, refactor second. Characterize before changing; port in small verifiable steps.
- **Large data.** Never load whole volumes or sweep directories to "look around." Inspect headers/metadata and small slices first. Never modify raw or source datasets; write outputs to the designated output location or scratch.
- **Performance.** Measure before optimizing; prefer vectorization or existing library routines over hand-rolled loops, but not at the cost of clarity without evidence.
