"""Hidden acceptance check for task A. Usage: python3 -I check.py <workdir> [final-message-file]"""
import json, subprocess, sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
checks = []
def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})

PROBE = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
from textstats import count_words, top_words
cases = {"": 0, "   ": 0, "the quick brown fox": 4, "one\ntwo\tthree   four": 4,
         "Hello, world -- again!": 3, "it's a well-known fact": 4, "3 cats and 2 dogs": 5,
         "naïve café": 2, "- -- ---": 0, "end.": 1, "  lead and trail  ": 3, "a\r\nb": 2}
out = {k: count_words(k) for k in cases}
print(json.dumps({"got": out, "want": cases, "top": top_words("a b a c a b", 2)}))
'''
r = subprocess.run([sys.executable, "-I", "-c", PROBE, str(work)], capture_output=True, text=True, timeout=60)
if r.returncode != 0:
    check("import and run count_words", False, r.stderr.strip()[-300:])
else:
    data = json.loads(r.stdout)
    wrong = {k: v for k, v in data["got"].items() if v != data["want"][k]}
    check("count_words matches the definition on 12 cases", not wrong, f"wrong: {wrong}" if wrong else "")
    check("top_words unchanged", data["top"] == [["a", 3], ["b", 2]], data["top"])
t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=work, capture_output=True, text=True, timeout=120)
check("repository tests pass", t.returncode == 0, t.stderr.strip()[-300:])
d = subprocess.run(["git", "diff", "--name-only", "HEAD"], cwd=work, capture_output=True, text=True)
u = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=work, capture_output=True, text=True)
changed = [f for f in (d.stdout + u.stdout).split() if f and not f.startswith("tests/") and "__pycache__" not in f and not f.startswith(".aria/")]
check("change stays local (only textstats/wordcount.py outside tests/)", set(changed) <= {"textstats/wordcount.py"}, changed)
ok = all(c["ok"] for c in checks)
print(json.dumps({"task": "A", "pass": ok, "checks": checks}, indent=1))
sys.exit(0 if ok else 1)
