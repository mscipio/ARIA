"""Hidden acceptance check for task B. Usage: python3 -I check.py <workdir> [final-message-file]"""
import json, re, subprocess, sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
checks = []
def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})

PROBE = r'''
import json, sys
from decimal import Decimal
sys.path.insert(0, sys.argv[1])
from shop import Cart, build_invoice, render, line_total, line_tax
res = {}
def D(x): return Decimal(x)
c = Cart().add("a", "0.10", 3).add("b", "1.005", 1, category="exempt").add("c", "19.99", 3, discount_pct=15).add("d", "2.35", 7, category="food").add("e", Decimal("0.35"), 3)
inv = build_invoice(c)
res["types"] = all(isinstance(v, Decimal) for v in (inv.subtotal, inv.tax, inv.total)) and all(isinstance(x, Decimal) for row in inv.lines for x in row[1:])
res["quantized"] = all(v == v.quantize(D("0.01")) and v.as_tuple().exponent == -2 for v in (inv.subtotal, inv.tax, inv.total))
res["lines"] = [[str(x) for x in row[1:]] for row in inv.lines]
res["sub"], res["tax"], res["total"] = str(inv.subtotal), str(inv.tax), str(inv.total)
try:
    Cart().add("f", 1.5, 1); res["float_rejected"] = False
except TypeError:
    res["float_rejected"] = True
except Exception as e:
    res["float_rejected"] = f"wrong exception {type(e).__name__}"
txt = render(build_invoice(Cart().add("x", "12.3", 1, category="exempt")))
res["render"] = txt
print(json.dumps(res))
'''
r = subprocess.run([sys.executable, "-I", "-c", PROBE, str(work)], capture_output=True, text=True, timeout=60)
if r.returncode != 0:
    check("package imports and builds an invoice", False, r.stderr.strip()[-400:])
else:
    d = json.loads(r.stdout)
    # Expected, computed by the rules: per-line discount (half-up), per-line tax (half-up), sums.
    want_lines = [["0.30", "0.03"], ["1.01", "0.00"], ["50.97", "4.52"], ["16.45", "0.33"], ["1.05", "0.09"]]
    check("amounts are Decimal", d["types"] is True, d)
    check("amounts quantized to cents", d["quantized"] is True)
    check("line totals and per-line taxes follow the rules", d["lines"] == want_lines, f"got {d['lines']}, want {want_lines}")
    check("subtotal 69.78, tax 4.97 (sum of rounded line taxes), total 74.75", (d["sub"], d["tax"], d["total"]) == ("69.78", "4.97", "74.75"), (d["sub"], d["tax"], d["total"]))
    check("float price rejected with TypeError", d["float_rejected"] is True, d["float_rejected"])
    check("render prints two decimals", re.search(r"\b12\.30\b", d["render"]) is not None and "12.3 " not in d["render"] + " ", d["render"])
src = "\n".join(p.read_text(errors="replace") for p in (work / "shop").glob("*.py"))
code = re.sub(r"#.*", "", src)                                   # comments
code = re.sub(r"(\"\"\"|\'\'\')[\s\S]*?\1", "", code)                # docstrings
code = re.sub(r"(['\"])(?:\\.|(?!\1).)*\1", "", code)              # string literals
code = re.sub(r"isinstance\([^()]*(\([^()]*\))?[^()]*\)", "", code)  # type checks that reject floats
check("no float left in shop/ money code (outside isinstance checks)", not re.search(r"\bfloat\b", code), re.findall(r".*\bfloat\b.*", code)[:5])
t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=work, capture_output=True, text=True, timeout=120)
check("repository tests pass", t.returncode == 0, t.stderr.strip()[-300:])
ok = all(c["ok"] for c in checks)
print(json.dumps({"task": "B", "pass": ok, "checks": checks}, indent=1))
sys.exit(0 if ok else 1)
