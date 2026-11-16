# ARIA vs vanilla OpenCode: autonomy benchmark

This directory is a reproducible procedure for comparing **OpenCode with ARIA** against **vanilla OpenCode** on the same tasks, with the same model and reasoning effort. It is not part of the release (it is outside `package.json` `files`), so an installed ARIA release never contains the hidden checks.

**Status: no real-model results exist yet.** The harness was exercised end to end against real OpenCode 2.3.0 with a scripted local model, which proves only that the plumbing works (events, session export, child sessions, hidden check, follow-ups, table). Model providers were not reachable from the environment where it was built.

## Tasks

| ID | Category | What it measures | Hidden check (selection) |
| --- | --- | --- | --- |
| A | Simple fix | Investigates, fixes locally, verifies, no plan or delegation needed | 12 word-count cases, other behaviour unchanged, change confined to one file |
| B | Multi-file refactor | Plan quality, goal retention across 5 files, verification | Decimal everywhere, per-line half-up tax, exact totals (69.78 / 4.97 / 74.75), float rejected, no `float` left |
| C | Failure recovery | Fixes a CRLF, non-executable `check.sh` without asking, then the real bug it reveals | `./scripts/check.sh` exits 0 as CI runs it, LF + exec bit, `mean([])` raises, test not weakened |
| D | Independent review | Recognises a deletion routine as review-worthy, review → fix → re-review | symlinks never followed or deleted, nothing outside root, root-is-symlink → ValueError, exact return list |
| E | Scientific | Units, decay correction, `[z][y][x]` vs `(sx, sy, sz)`, anisotropic voxels | SUV within 1e-9 of an independent formula; sphere stats on an axis-identifying image |
| F | Honest limitations | Data is missing: does everything else, invents nothing | RC function correct on a synthetic phantom; no RC values written; report says the scan is missing |

Each task has `task.md` (the prompt, identical for both conditions), `repo/` (initial state), `meta.json` (what good behaviour looks like) and `check.py` (hidden acceptance check).

**Check validation.** Every `check.py` was run against the untouched repository (must fail), a reference solution (must pass) and 2–3 naive solutions each (must fail): 26/26 as expected. The naive solutions encode realistic mistakes: splitting on spaces (A); rounding only at the end, Decimal without per-line rounding (B); fixing only the code or only the script, or weakening the test (C); `os.walk` deleting links, `followlinks=True` (D); no decay correction, swapped axes, kg not converted (E); fabricated CSV values, no implementation (F). The reference and naive solutions are deliberately not shipped.

## Running

Requirements: OpenCode 2.3.x, Node 22.18+, Python 3 with numpy (tasks E, F), git, and provider access for the model under test.

```sh
MODEL=provider/model#variant                # same model and variant for both conditions
ARIA_PKG=$ARIA_HOME/releases/2.0.0-alpha.5   # an installed release, not the checkout (keeps eval/ out of reach)

eval/run.sh --model "$MODEL" --condition vanilla --task all --repeat 3 --out runs/2026-11-16
eval/run.sh --model "$MODEL" --condition aria --aria "$ARIA_PKG" --task all --repeat 3 --out runs/2026-11-16
node eval/collect.mjs runs/2026-11-16
node eval/summarize.mjs runs/2026-11-16 --md runs/2026-11-16/summary.md
```

Options: `--timeout` (seconds per run, default 1800), `--opencode <bin>`, `--config-extra file.json` (merged into both conditions' config, e.g. a custom provider), `--auth auth.json` (copied into each run's isolated data directory; otherwise credentials come from environment variables).

**Interventions.** Runs are non-interactive. If you judge that a run needs a corrective prompt, give it with
`eval/run.sh --followup <run-dir> "message"`; it continues the same session, is counted as an intervention, and the hidden check is re-run. Decide the follow-up policy before looking at results (e.g. at most one, only to unblock), and apply it identically to both conditions.

## Conditions and what differs

| | Vanilla | ARIA |
| --- | --- | --- |
| Model, variant | `--model` | same |
| Default agent | `build` | `aria` (six specialists available) |
| Prompts | OpenCode's | ARIA's role prompts and skills |
| Tools | OpenCode built-ins | built-ins + `aria_git`, `aria_status`, review verdict tool (reviewer only) |
| Permissions | OpenCode defaults | ARIA's scoped rules and tool gate |
| Approval | `opencode run --auto` | same: asks are auto-approved, denies still apply |
| Repository, task text, checks | same | same |

ARIA pins no models, so every ARIA role runs on the model under test. A difference caused by `--auto` approving something ARIA would have asked about is a property of the benchmark, not of interactive use; note it when interpreting results.

## Isolation

Each run gets a fresh git repository with one commit, its own `HOME` and XDG directories (the user's OpenCode config, sessions and credentials are never read), and `opencode run --standalone`. The hidden check is copied into the run directory only after the agent has finished. Residual risk: with `--auto`, an agent can read outside its project; keep the `eval/` checkout away from the run (use an installed release for `--aria`) and do not run this where sensitive data is readable.

## Metrics (collect.mjs → runs.json, summarize.mjs → table)

| Metric | Source |
| --- | --- |
| Completion | `opencode run` exited 0 within the timeout |
| Correctness | hidden check passed |
| User interventions | follow-ups recorded with `--followup` |
| Correct per prompt | correct runs / (runs + follow-ups) |
| Delegation | `subagent` tool calls and their agents; for A, C, E anything other than the reviewer counts as unnecessary |
| Failure recovery | C passed with no follow-up |
| Review compliance | the reviewer was actually launched (D requires it); ARIA's `aria_review` session record is kept for inspection |
| Correction loop | a FAIL verdict later followed by PASS |
| Verification quality | the agent ran tests or the check script itself (shell calls); read the transcript before trusting it |
| Time and cost | wall time; tokens and cost from the root and every child session |

A recorded PASS is evidence that a review happened, not that the work is correct: the hidden check is the correctness signal. Repeat each task (≥3) before drawing conclusions, and look for repeated failure patterns before changing prompts or architecture (see the brief's §12).

## Files per run

`runs/<out>/<task>/<condition>/r<k>/`: `work/` (the repository after the run), `events.jsonl` (OpenCode's JSON event stream), `session.json` and `children/` (session exports), `final.txt` (last assistant message), `check.json`, `diff.txt`, `meta.json`, `interventions.json`, `stderr.log`.
