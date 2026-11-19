"""Hidden acceptance check for task E. Usage: python3 -I check.py <workdir> [final-message-file]"""
import json, subprocess, sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
checks = []
def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})

PROBE = r'''
import json, sys
from datetime import datetime, timedelta
import numpy as np
sys.path.insert(0, sys.argv[1])
from petsuv import suv_bw, sphere_stats
out = {}
rng = np.random.default_rng(7)
act = rng.uniform(1000, 30000, size=(7, 11, 13))          # [z][y][x], Bq/mL
t0 = datetime(2026, 1, 1, 9, 0, 0); t1 = t0 + timedelta(minutes=62)
dose, w, T = 370.0, 81.5, 6586.2
# Reference (independent): SUV = C / (D_decayed[Bq] / W[g])
ref = act / (dose * 1e6 * 2 ** (-(62 * 60) / T) / (w * 1000))
s = suv_bw(act, dose, w, t0, t1)
out["suv_shape"] = list(np.shape(s)); out["suv_dtype"] = str(np.asarray(s).dtype)
out["suv_maxrel"] = float(np.max(np.abs(np.asarray(s, dtype=float) - ref) / ref))
out["no_decay"] = float(np.max(np.abs(suv_bw(act, dose, w, t0, t0) - act / (dose * 1e6 / (w * 1000))))) / float(np.max(ref))
# Sphere: anisotropic spacing, off-centre, axis order trap
sp = (2.0, 3.0, 4.5)                     # sx, sy, sz
z, y, x = np.meshgrid(np.arange(7), np.arange(11), np.arange(13), indexing="ij")
img = (x * 1000 + y * 10 + z * 0.1).astype(float)   # every voxel distinct, axis-identifying
cen = (9.0, 12.0, 9.0); r = 7.0
inside = ((x * sp[0] - cen[0]) ** 2 + (y * sp[1] - cen[1]) ** 2 + (z * sp[2] - cen[2]) ** 2) <= r * r + 1e-9
want = (float(img[inside].max()), float(img[inside].mean()), int(inside.sum()))
got = sphere_stats(img, sp, cen, r)
out["sphere_want"] = want; out["sphere_got"] = [float(got[0]), float(got[1]), int(got[2])]
# boundary inclusive: a voxel exactly at radius
img2 = np.zeros((1, 1, 5)); img2[0, 0, 3] = 5.0
out["boundary"] = list(sphere_stats(img2, (1.0, 1.0, 1.0), (0.0, 0.0, 0.0), 3.0))
try:
    sphere_stats(img, sp, (1000.0, 1000.0, 1000.0), 1.0); out["empty"] = "no error"
except ValueError:
    out["empty"] = "ValueError"
except Exception as e:
    out["empty"] = type(e).__name__
print(json.dumps(out))
'''
r = subprocess.run([sys.executable, "-I", "-c", PROBE, str(work)], capture_output=True, text=True, timeout=120)
if r.returncode != 0:
    check("functions run", False, r.stderr.strip()[-400:])
else:
    d = json.loads(r.stdout)
    check("SUV image shape and float64", d["suv_shape"] == [7, 11, 13] and d["suv_dtype"] == "float64", (d["suv_shape"], d["suv_dtype"]))
    check("SUV values: units (MBq->Bq, kg->g) and decay correction", d["suv_maxrel"] < 1e-9, f"max relative error {d['suv_maxrel']:.3g}")
    check("SUV without delay equals the undecayed formula", d["no_decay"] < 1e-9, d["no_decay"])
    w, g = d["sphere_want"], d["sphere_got"]
    check("sphere stats with anisotropic spacing and [z][y][x] indexing", abs(w[0] - g[0]) < 1e-9 and abs(w[1] - g[1]) < 1e-9 and w[2] == g[2], f"got {g}, want {w}")
    check("radius boundary inclusive", d["boundary"][2] == 4 and d["boundary"][0] == 5.0, d["boundary"])
    check("ValueError when no voxel is inside", d["empty"] == "ValueError", d["empty"])
t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=work, capture_output=True, text=True, timeout=120)
check("repository tests pass", t.returncode == 0, t.stderr.strip()[-200:])
ok = all(c["ok"] for c in checks)
print(json.dumps({"task": "E", "pass": ok, "checks": checks}, indent=1))
sys.exit(0 if ok else 1)
