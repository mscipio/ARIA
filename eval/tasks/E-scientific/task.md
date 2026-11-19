Implement the two functions in `petsuv/suv.py` for our PET quantification pipeline. numpy is available.

`suv_bw(activity, injected_dose_mbq, weight_kg, injection_time, scan_start, half_life_s=6586.2)`
- `activity` is a reconstructed image in Bq/mL as a numpy array indexed `[z][y][x]`.
- Body-weight SUV, with the injected dose decay-corrected from `injection_time` to `scan_start` (both `datetime`). Assume 1 g/mL tissue density.
- Returns a float64 array of the same shape.

`sphere_stats(image, spacing_mm, center_mm, radius_mm)`
- `spacing_mm` is `(sx, sy, sz)`: voxel size along x, y, z (the DICOM order), which is NOT the array axis order.
- `center_mm` is `(x, y, z)` in mm, measured from the centre of voxel `[0][0][0]`.
- A voxel belongs to the sphere when its centre is within `radius_mm` (inclusive).
- Returns `(max, mean, n_voxels)` over the voxels in the sphere; raise `ValueError` if no voxel is inside.

Check your work numerically; anisotropic voxels are the normal case for us.
