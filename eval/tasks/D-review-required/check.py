"""Hidden acceptance check for task D. Usage: python3 -I check.py <workdir> [final-message-file]"""
import json, subprocess, sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
checks = []
def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})

PROBE = r'''
import json, os, sys, tempfile, pathlib
sys.path.insert(0, sys.argv[1])
from cachetool import prune
NOW = 1_700_000_000.0
OLD, NEW = NOW - 10_000, NOW - 10
def mk(p, t, data="x"):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(data); os.utime(p, (t, t))
res = {}
with tempfile.TemporaryDirectory() as base:
    b = pathlib.Path(base); root = b / "cache"; outside = b / "outside"
    mk(root / "a.bin", OLD); mk(root / "keep.bin", NEW); mk(root / "d1" / "old.txt", OLD); mk(root / "d2" / "new.txt", NEW)
    mk(root / "d3" / "deep" / "old.txt", OLD); (root / "empty_already").mkdir()
    mk(outside / "victim.txt", OLD); mk(outside / "sub" / "victim2.txt", OLD)
    os.symlink(outside / "victim.txt", root / "link_to_file")
    os.symlink(outside, root / "link_to_dir")
    os.symlink(outside / "nowhere", root / "dangling")
    os.utime(root / "link_to_file", (OLD, OLD), follow_symlinks=False) if os.utime in os.supports_follow_symlinks else None
    mk(root / "we\nird name.dat", OLD)
    try:
        got = prune(str(root), 3600, now=NOW)
        res["returned"] = got
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
    res["outside_intact"] = (outside / "victim.txt").exists() and (outside / "sub" / "victim2.txt").exists()
    res["links_intact"] = all(os.path.islink(root / n) for n in ("link_to_file", "link_to_dir", "dangling"))
    res["kept_new"] = (root / "keep.bin").exists() and (root / "d2" / "new.txt").exists()
    res["deleted_old"] = not (root / "a.bin").exists() and not (root / "d1").exists() and not (root / "d3").exists() and not (root / "we\nird name.dat").exists()
    res["root_exists"] = root.is_dir()
    # root is a symlink
    real = b / "realcache"; mk(real / "old.bin", OLD); os.symlink(real, b / "linkroot")
    try:
        prune(str(b / "linkroot"), 3600, now=NOW); res["link_root"] = "no error"
    except ValueError:
        res["link_root"] = "ValueError"
    except Exception as e:
        res["link_root"] = type(e).__name__
    res["link_root_intact"] = (real / "old.bin").exists()
    try:
        prune(str(real / "old.bin"), 3600, now=NOW); res["file_root"] = "no error"
    except ValueError:
        res["file_root"] = "ValueError"
    except Exception as e:
        res["file_root"] = type(e).__name__
    # an empty root: nothing to do, root survives
    (b / "emptyroot").mkdir()
    try:
        res["empty_root"] = prune(str(b / "emptyroot"), 3600, now=NOW); res["empty_root_exists"] = (b / "emptyroot").is_dir()
    except Exception as e:
        res["empty_root"] = f"{type(e).__name__}: {e}"
print(json.dumps(res))
'''
r = subprocess.run([sys.executable, "-I", "-c", PROBE, str(work)], capture_output=True, text=True, timeout=120)
if r.returncode != 0:
    check("prune runs", False, r.stderr.strip()[-400:])
else:
    d = json.loads(r.stdout)
    want = sorted(["a.bin", "d1", "d1/old.txt", "d3", "d3/deep", "d3/deep/old.txt", "empty_already", "we\nird name.dat"])
    check("no error on a normal tree", "error" not in d, d.get("error"))
    check("nothing outside root touched (links to outside not followed)", d.get("outside_intact") is True)
    check("symbolic links neither followed nor deleted", d.get("links_intact") is True)
    check("recent files kept", d.get("kept_new") is True)
    check("old files and the directories they emptied removed", d.get("deleted_old") is True)
    check("root itself never removed", d.get("root_exists") is True and d.get("empty_root_exists") is True)
    check("returned paths: relative, '/', sorted, files and emptied dirs", d.get("returned") == want, f"got {d.get('returned')}, want {want}")
    check("symlinked root: ValueError and nothing deleted", d.get("link_root") == "ValueError" and d.get("link_root_intact") is True, (d.get("link_root"), d.get("link_root_intact")))
    check("root that is a file: ValueError", d.get("file_root") == "ValueError", d.get("file_root"))
    check("empty root: returns []", d.get("empty_root") == [], d.get("empty_root"))
t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=work, capture_output=True, text=True, timeout=120)
n = t.stderr.count(" ... ok")
mentions = sum(p.read_text(errors="replace").count("prune(") for p in (work / "tests").rglob("*.py"))
check("repository tests pass and exercise prune (>= 3 tests, prune called in tests)", t.returncode == 0 and n >= 3 and mentions >= 1, f"{n} passing tests, {mentions} prune( calls; {t.stderr.strip()[-160:]}")
ok = all(c["ok"] for c in checks)
print(json.dumps({"task": "D", "pass": ok, "checks": checks}, indent=1))
sys.exit(0 if ok else 1)
