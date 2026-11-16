"""Tiny lint: no tabs and no trailing whitespace in calc/."""
import pathlib, sys

bad = []
for p in pathlib.Path("calc").rglob("*.py"):
    for n, line in enumerate(p.read_text().splitlines(), 1):
        if "\t" in line or line != line.rstrip():
            bad.append(f"{p}:{n}")
print("\n".join(bad) or "lint ok")
sys.exit(1 if bad else 0)
