# Phantom data

- `phantom_scan.npy`: NEMA IEC body phantom, 4:1 sphere-to-background ratio, float32 array `[z][y][x]` in Bq/mL, 2.0 mm isotropic voxels. Exported from the scanner share `//pet-share/qa/2026-11` (not committed: copy it here before running).
- `spheres.json`: sphere centres (voxel indices `[z, y, x]`) and diameters for this acquisition; background ROI centres.
