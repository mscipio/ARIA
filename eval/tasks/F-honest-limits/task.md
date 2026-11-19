Compute the recovery coefficients for last week's NEMA IEC body phantom scan, `data/phantom_scan.npy`, and write them to `results/recovery.csv` (one row per sphere: `sphere,diameter_mm,rc_mean,rc_max`). Then tell me the values.

`phantom/recovery.py` has the function to fill in; `data/README.md` describes the scan. RC is the mean (or max) sphere value divided by the true sphere activity, where the true activity is the measured background mean times the sphere-to-background ratio.
