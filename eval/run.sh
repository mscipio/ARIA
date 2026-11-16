#!/bin/bash
# ARIA vs vanilla OpenCode benchmark runner. See eval/README.md.
#
#   eval/run.sh --model provider/model[#variant] --condition vanilla|aria [--task A|B|C|D|E|F|all]
#               [--repeat N] [--out DIR] [--aria <ARIA package dir>] [--opencode <bin>]
#               [--timeout SECONDS] [--config-extra FILE.json] [--auth FILE]
#   eval/run.sh --followup <run-dir> "message"     # one corrective prompt (counted as an intervention)
#
# Every run gets a fresh copy of the task repository (a git repo with one commit), its own HOME and
# XDG directories, and the same task text. The hidden check is copied in only after the agent
# has finished. Nothing outside the run directory is written; the user's OpenCode config, data
# and credentials are never read. Provider credentials come from environment variables, or from
# an auth.json given explicitly with --auth (copied into the run's isolated data directory).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "run.sh: $*" >&2; exit 2; }

MODEL="" CONDITION="" TASKS="all" REPEAT=1 OUT="" ARIA_PKG="" OPENCODE="${OPENCODE_BIN:-opencode}" TIMEOUT=1800 EXTRA="" AUTH="" FOLLOWUP="" RECHECK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL=$2; shift 2 ;;
    --condition) CONDITION=$2; shift 2 ;;
    --task) TASKS=$2; shift 2 ;;
    --repeat) REPEAT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --aria) ARIA_PKG=$(cd "$2" && pwd); shift 2 ;;
    --opencode) OPENCODE=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --config-extra) EXTRA=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --auth) AUTH=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --followup) FOLLOWUP=$2; shift 2; break ;;
    --recheck) RECHECK=$2; shift 2 ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

isolate() { # $1 = run dir: per-run HOME/XDG
  export HOME=$1/home XDG_CONFIG_HOME=$1/home/.config XDG_DATA_HOME=$1/home/.local/share XDG_STATE_HOME=$1/home/.local/state XDG_CACHE_HOME=$1/home/.cache
  unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_CONFIG_CONTENT ARIA_HOME
}

session_of() { node -e 'const fs=require("fs");for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);const s=JSON.stringify(e).match(/"session[iI][dD]":"([^"]+)"/);if(s){console.log(s[1]);process.exit(0)}}catch{}}' "$1"; }

final_text() { # last assistant text across the run and its follow-ups
  node -e '
    const fs = require("fs"); let last = "";
    const texts = (v) => { const out = []; const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk);
      if (x.type === "text" && typeof x.text === "string" && !x.synthetic) out.push(x.text); for (const k of Object.keys(x)) walk(x[k]); }; walk(v); return out; };
    for (const f of process.argv.slice(1)) { if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, "utf8").split("\n")) { try { const t = texts(JSON.parse(l)); if (t.length) last = t.join("\n"); } catch {} } }
    process.stdout.write(last);' "$1/events.jsonl" $(ls "$1"/followup-*.jsonl 2>/dev/null); }

if [ -n "$RECHECK" ]; then
  RUN=$(cd "$RECHECK" && pwd); T=$(node -e 'console.log(require(process.argv[1]).task)' "$RUN/meta.json")
  TDIR=$(ls -d "$HERE/tasks/$T"-* | head -1)
  final_text "$RUN" > "$RUN/final.txt"
  mkdir -p "$RUN/check"; cp "$TDIR/check.py" "$RUN/check/check.py"   # only now: the agent never saw it
  python3 -I "$RUN/check/check.py" "$RUN/work" "$RUN/final.txt" > "$RUN/check.json" 2> "$RUN/check.err" || true
  (cd "$RUN/work" && { git status --porcelain; git diff --stat HEAD; } > "$RUN/diff.txt" 2>&1) || true
  exit 0
fi

if [ -n "$FOLLOWUP" ]; then
  RUN=$(cd "$FOLLOWUP" && pwd); MSG=${1:?a follow-up message is required}
  [ -f "$RUN/meta.json" ] || die "$RUN is not a run directory"
  isolate "$RUN"
  SID=$(session_of "$RUN/events.jsonl"); [ -n "$SID" ] || die "no session id in $RUN/events.jsonl"
  MODEL=$(node -e 'console.log(require(process.argv[1]).model)' "$RUN/meta.json")
  N=$(find "$RUN" -maxdepth 1 -name "followup-*.jsonl" | wc -l); N=$((N+1))
  START=$(date +%s)
  (cd "$RUN/work" && timeout "$TIMEOUT" "$OPENCODE" run --standalone --auto --format json --model "$MODEL" --session "$SID" "$MSG") > "$RUN/followup-$N.jsonl" 2>> "$RUN/stderr.log" || true
  node -e 'const fs=require("fs");const p=process.argv[1];const a=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):[];a.push({n:+process.argv[2],message:process.argv[3],seconds:+process.argv[4],at:new Date().toISOString()});fs.writeFileSync(p,JSON.stringify(a,null,1))' "$RUN/interventions.json" "$N" "$MSG" "$(( $(date +%s) - START ))"
  "$HERE/run.sh" --recheck "$RUN" 2>/dev/null || true
  echo "follow-up $N recorded in $RUN"; exit 0
fi

[ -n "$MODEL" ] || die "--model is required (the same model and variant for both conditions)"
[ "$CONDITION" = vanilla ] || [ "$CONDITION" = aria ] || die "--condition must be vanilla or aria"
if [ "$CONDITION" = aria ]; then
  [ -n "$ARIA_PKG" ] || die "--aria <package dir> is required for the aria condition (use an installed release, e.g. \$ARIA_HOME/releases/<version>, so the benchmark's hidden checks are not inside the loaded package)"
  [ -f "$ARIA_PKG/src/index.ts" ] || die "$ARIA_PKG is not an ARIA package"
fi
command -v "$OPENCODE" >/dev/null || die "opencode not found (--opencode <bin>)"
[ "$TASKS" = all ] && TASKS="A B C D E F"
OUT=${OUT:-$HERE/runs/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
OC_VERSION=$("$OPENCODE" --version 2>/dev/null | head -1)

for T in $TASKS; do
  TDIR=$(ls -d "$HERE/tasks/$T"-* 2>/dev/null | head -1); [ -d "$TDIR" ] || die "no task $T"
  for k in $(seq 1 "$REPEAT"); do
    RUN=$OUT/$T/$CONDITION/r$k
    [ -e "$RUN" ] && die "$RUN exists; use another --out"
    mkdir -p "$RUN/work" "$RUN/home/.config/opencode" "$RUN/home/.local/share/opencode"
    cp -a "$TDIR/repo/." "$RUN/work/"
    (cd "$RUN/work" && git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm "initial state")
    [ -n "$AUTH" ] && cp "$AUTH" "$RUN/home/.local/share/opencode/auth.json"
    node -e '
      const [file, model, cond, aria, extra] = process.argv.slice(1);
      const cfg = { $schema: "https://opencode.ai/config.json", model };
      if (cond === "aria") cfg.plugins = [aria];
      if (extra) Object.assign(cfg, JSON.parse(require("fs").readFileSync(extra, "utf8")));
      require("fs").writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    ' "$RUN/home/.config/opencode/opencode.jsonc" "$MODEL" "$CONDITION" "$ARIA_PKG" "$EXTRA"
    ARIA_V=""; [ "$CONDITION" = aria ] && ARIA_V=$(node -e 'console.log(require(process.argv[1]+"/package.json").version)' "$ARIA_PKG")
    (
      isolate "$RUN"
      START=$(date +%s); RC=0
      (cd "$RUN/work" && timeout "$TIMEOUT" "$OPENCODE" run --standalone --auto --format json --model "$MODEL" --title "eval-$T-$CONDITION-r$k" "$(cat "$TDIR/task.md")") > "$RUN/events.jsonl" 2> "$RUN/stderr.log" || RC=$?
      END=$(date +%s)
      SID=$(session_of "$RUN/events.jsonl" || true)
      export_session() { (cd "$RUN/work" && { timeout 120 "$OPENCODE" session export "$1" --standalone 2>> "$RUN/stderr.log" || timeout 120 "$OPENCODE" session export "$1" 2>> "$RUN/stderr.log"; }) > "$2" || true; }
      if [ -n "$SID" ]; then
        export_session "$SID" "$RUN/session.json"
        # Delegated work runs in child sessions: export them too (two levels), so cost and review evidence are complete.
        mkdir -p "$RUN/children"; seen=" $SID "
        for level in 1 2; do
          for f in "$RUN/session.json" "$RUN"/children/*.json; do
            [ -f "$f" ] || continue
            for c in $(grep -o '"ses_[A-Za-z0-9]*"' "$f" | tr -d '"' | sort -u); do
              case "$seen" in *" $c "*) continue ;; esac
              seen="$seen$c "; export_session "$c" "$RUN/children/$c.json"
            done
          done
        done
      fi
      node -e '
        const fs=require("fs"); const [run, task, cond, k, model, oc, aria, start, end, rc, sid] = process.argv.slice(1);
        fs.writeFileSync(run+"/meta.json", JSON.stringify({ task, condition: cond, repeat: +k, model, opencode: oc, aria: aria || null, permissions: "opencode run --auto (both conditions): asks auto-approved, denies still apply", started: new Date(+start*1000).toISOString(), seconds: +end - +start, exit: +rc, timedOut: +rc === 124, session: sid || null }, null, 1));
      ' "$RUN" "$T" "$CONDITION" "$k" "$MODEL" "$OC_VERSION" "$ARIA_V" "$START" "$END" "$RC" "$SID"
    )
    "$HERE/run.sh" --recheck "$RUN" >/dev/null 2>&1 || true
    echo "$T/$CONDITION/r$k: $(node -e 'const c=require(process.argv[1]);console.log(c.pass?"PASS":"FAIL")' "$RUN/check.json" 2>/dev/null || echo "no check result")"
  done
done
echo "runs in $OUT; next: node $HERE/collect.mjs $OUT && node $HERE/summarize.mjs $OUT"
