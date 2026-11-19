---
status: active
objective: A small, trustworthy OpenCode v2.3.0 plugin with a self-managing CLI/TUI: install, update, rollback, models, dependencies and diagnostics without editing files by hand.
updated: 2026-11-16 (alpha.6)
---
# ARIA 2 implementation map

Single source of truth for what is done, how it was checked, and what remains. **Maintenance rule:** keep this map truthful; update it in the same change as the work it records (this note replaces the former repo-level instruction files, which ARIA no longer uses). `[x]` executed, `[ ]` pending, `[!]` blocked. A task counts as verified only where a `verified:` line records the evidence. Fixture scripts lived in `/tmp/aria-verify/` (disposable, not part of the repo, not automated tests).

Baseline used: OpenCode upstream source at tag v2.3.0 and `@opencode/plugin` 2.3.0 types. **No OpenCode binary was installed**: installing it was outside the authorization given and was denied by the environment, so nothing below has been exercised in a running OpenCode.

## Round 1 (alpha.1) — kept

- [x] T1 Plugin core, roles, prompts, skill registration, `aria_git`, `aria_status`, CLI, TUI, packaging (see git history of this file's first version)
  - verified: typecheck/lint clean (round 1); superseded in parts by round 2 below

## Round 2 (alpha.2) — corrections

- [x] T20 P0 scratch confinement and safe cleanup (`src/safe-fs.ts`, `src/scratch.ts`, `src/index.ts`, CLI)
  - verified: defect reproduced on the alpha.1 code with temp dirs: a symlinked `.aria/scratch` let `ensureScratch` write outside and `cleanScratch` delete an external `DONE`-marked directory
  - verified: 36/36 fixture scenarios on the new code: normal init/list/clean, unfinished kept, symlinked `.aria/scratch` and `.aria` rejected with nothing created or deleted outside, symlinked root/session/DONE entries never followed, inner links unlinked with targets intact, 8 traversal/malformed IDs rejected, non-session dirs kept, one tree's marker removes only that tree, invalid `--stale` rejected, stale handling
- [x] T21 P0 plan confinement (`src/plans.ts`; used by server, CLI, TUI)
  - verified: defect reproduced on alpha.1 (`readPlans` read an external file via symlinked `.aria/plans`)
  - verified: 18 fixture checks: symlinked plan file and directory (external and internal) skipped without leaking content; nested, hidden, oversized and unreadable files handled; files without front matter skipped (changed from alpha.1, which treated any `.md` as an active plan)
- [x] T22 P0 permission model (`src/permissions.ts`, `src/roles.ts`, `src/tool-gate.ts`, `src/guard.ts`)
  - finding: alpha.1 `aria` inherited OpenCode's `* * allow`, so any MCP or plugin tool ran silently; some built-in tools (`opencode_schedule_*`, `opencode_worktree_create`, `opencode_session_move`, artifacts) never assert, so `ask` rules could not stop them
  - change: coding roles start from `ask("*")` with explicit allows; read-only roles from `deny("*")`; tool gate asserts for non-asserting tools (also inside Code Mode); guard denies edits through any in-project symlink and reads of secrets through links; authority files extended (`.claude/`, `.agents/`, `CLAUDE.md`, `.git/config`, `.git/hooks/`, `.gitattributes`); secret list extended; planner nested paths denied; root-session lookup failures no longer cached
  - verified: 156/156 role cases evaluated with a copy of upstream `evaluate` + tool-visibility logic over native defaults + ARIA rules (incl. write/patch using the `edit` permission); 17/17 guard cases on real temp dirs (incl. planner path redirected into `src/` via symlink, link-to-.env read, lookup failure fails closed)
  - not verified: the tool gate and evaluate hook firing inside a real server
- [x] T23 `aria_git` execution safety (`src/git-tool.ts`)
  - finding: executed for the first time against a hostile temp repo; a repo-config clean filter (`filter.*.clean` + `.gitattributes`) ran during `status`/`diff` (4 marker files)
  - change: configured filter drivers are disabled per call; signatures, submodule recursion also off
  - verified: re-run created no markers; no `.env`/key content in any output; `rev:path` and option injection rejected
- [x] T24 P1 Zotero (`src/permissions.ts`, researcher prompt, two skills, example config)
  - verified: tool names from zotero-mcp source (github.com/54yyyu/zotero-mcp @ 71df195); 35 read tools allowed, 22 mutating ask, unknown hidden (fixture cases); ZotPilot references removed (grep)
  - not verified: against a live zotero-mcp server
- [x] T25 P1 roles and models: no pinned models; scientist owns scientific coding (coding policy, own scratch, no `aria` handoff); prompts updated
  - verified: rule cases for scientist; prompts reviewed for contradictions
- [x] T26 P1 plan ownership: `session:` front matter; context lists own plan to resume and other plans as not this task; TUI and `aria_status` partition the same way; "evidence recorded" wording
  - verified: fixture checks for own/other/new-session/done/multiple plans and display transitions (evidence removed, reopened)
  - not verified: model behaviour with the new context text
- [x] T27 P1 loading and packaging, from source: one `plugins` entry yields both server and TUI (`core/src/plugin/module.ts`, `tui/src/plugin/context.tsx` `features.tui`); absolute path required; host provides `@opencode/plugin`, `effect`, Solid/OpenTUI; Bun loads TS/TSX. README and example corrected (alpha.1 wrongly said to add a second TUI entry)
  - not verified: actual load
- [x] T28 CLI doctor matches v2.3.0 config discovery (system, global, project walk-up incl. `.opencode/`, `OPENCODE_CONFIG`); flags duplicate and relative entries; states it is static only
  - verified: run on a temp project (JSONC, duplicate/relative entry, Zotero option)
- [x] T29 TUI: session-owned plan, debounced refresh, explicit "unavailable" state with read time, no stronger claim than "evidence recorded"
  - verified: typecheck/lint only

## Round 3 (alpha.3) — defect fixes, lifecycle manager, management TUI

Verification ran in a disposable environment (`HOME`, `XDG_CONFIG_HOME`, `ARIA_HOME` and the project under `/tmp/aria-sbx`). The user's real configuration was never read or written. Libraries were installed only into disposable directories. A stub `opencode` (prints v2.3.0-format output) was used where noted; it proves parsing, not OpenCode behaviour.

- [x] T40 Writer nested authority paths (2.1)
  - verified: 19 new matrix cases, e.g. `docs/.opencode/agent.md` and `a/b/.agents/skill/SKILL.md` are denied, while `docs/opencode-notes.md` is allowed; 184/184 total
- [x] T41 Exact tool gate without name heuristics (2.2): gate every tool except OpenCode's self-asserting built-ins; one-shot approval carry-over for the identical follow-up check in the same call
  - verified: carry-over 8/8 (single-use; same session, call and action only; deny untouched; expires); look-alike plugin names are gated
  - not verified: inside a running server
- [x] T42 Plan read states absent/empty/ok/partial/unavailable; TUI announces only on complete reads (2.3)
  - verified: 5/5 state fixtures; the OpenCode TUI itself is typecheck-only
- [x] T43 Licensing: `cgize` notice kept; second line and NOTICE attribute the ARIA 2 implementation (2.5). Needs your confirmation of the attribution wording.
- [x] T44 Packaging/config facts corrected from source (2.4): relative `./` `../` and `file://` plugin entries are valid, and `plugins/` folders auto-load
- [x] T45 Lifecycle backend `src/manager/`: manifest, config (JSONC edits with ownership), state with lock, install/update/rollback/repair/prune, deps, models, doctor, OpenCode probes, MCP tool probe
- [x] T46 CLI (`aria setup|update|rollback|repair|doctor|models|deps|plans|scratch|version`) with exit codes 0/1/2/3/4 and `--json`
  - verified, CLI: setup preview leaves the file byte-identical (exit 3); apply keeps comments and the user's entries; second setup changes nothing (byte-identical); duplicate registration across scopes is blocked (exit 4)
  - verified, models: set, bad spec, unknown role, variant change, undo, remove pin (with empty parents pruned); the global file is untouched by project edits
  - verified, deps: missing executable detected; zotero-mcp found inside a conda env without activation; enable writes an absolute path; idempotent; a user entry is never replaced or removed (exit 4); probe against a fake MCP server reported 35 read, 21 mutating, 1 unclassified and 1 expected-but-absent tool
  - verified, releases: release install from `.tgz` (sha256 verified, staged, `npm install --omit=dev`, smoke-tested); update preview, apply and idempotent re-run; rollback and `rollback --to`; checksum mismatch refused; SIGKILL during staging left the old release active and the config untouched, doctor reported it and repair cleaned it; injected failure before activation left the config unchanged; the old release stayed byte-identical; an unknown directory in `releases/` is never removed
- [x] T47 Management TUI (Terminal-kit 3.1.4, keyboard only, ASCII markers): 6 sections, preview then `y` for every mutation, a progress overlay, Esc to cancel, help, and a narrow layout
  - verified in a real PTY (Python pty driver, 120x32 and 60x20), with the brief's scenario numbers:
    - launch without OpenCode (1); with the stub OpenCode (2)
    - healthy and unhealthy states (3); all sections by keyboard (4); diagnostic details (5)
    - install preview without changes (6); disposable install applied (7); repeat gives no changes (8)
    - model discovery via the stub (9); project model change (10), checked in the file (11); restore (12)
    - MCP on/off listing (13); missing executable (14)
    - update preview (15); failed update reported, config unchanged, Health shows the interruption (16); rollback (17)
    - resize to 60x20 (18); `q` exits 0, cursor restored, no leftover process (19)
    - Health problem count matches `aria doctor --json` (20)
  - not verified: Esc cancellation of a running npm/pip install; Windows/macOS terminals; a real OpenCode behind the runtime probes

## Round 4 (alpha.3+) — first live OpenCode runtime, risk-based independent review

Runtime: OpenCode **v2.3.0** (`@opencode/cli` 2.3.0, installed with your authorization into `/tmp/oc-runtime`, with HOME, config and data under `/tmp/oc-home`).

- **No real model.** Model providers are unreachable from this sandbox: OpenCode Zen and others return `403` through the egress proxy. Sessions ran against a scripted OpenAI-compatible model on 127.0.0.1 that returns predetermined tool calls. OpenCode's real tool execution, permissions, plugin hooks, delegation, session metadata and TUI all ran; model judgement did not.
- **No real zotero-mcp.** Installing it was blocked by the sandbox as unauthorized, so its live tool inventory is still unverified.

### Live runtime evidence

- [x] T50 Plugin load and agents: ARIA loads from a bare checkout (the host supplies its dependencies); 7 agents registered with modes; resolved rules include ARIA's
  - verified: `opencode debug agents`; the 184-case permission audit re-run on the rule lists the real server resolved: 184/184
- [x] T51 Permissions and guard, live:
  - read-only roles have no edit/write/shell/execute tools; planner limited to top-level plan files; writer denied `docs/.opencode/` and `AGENTS.md`
  - aria: out-of-project write refused; `sudo` denied; `git push`, `.env` and config edits need approval; symlink escape and another session's scratch denied by the guard; own scratch allowed
  - verified: scripted sessions, filesystem checked afterwards
- [x] T52 Custom tools and tool gate:
  - `aria_git` and `aria_status` work (through Code Mode for aria, directly for read-only roles); `rev:path` rejected
  - the gate stopped an unasserting probe plugin tool inside Code Mode; with `--auto` it ran once
  - MCP via the fake Zotero server: a researcher read reached the server; mutating calls were refused before reaching it, and ran once under `--auto`
- [x] T53 Background delegation: aria → scout ran in a child session and completed; the report came back as `<subagent state="completed">`; `general` denied
- [x] T54 Plan ownership across sessions: a new session sees the plan only as another session's; continuing the owning session tells it to resume
- [x] T55 Model routing: `aria models set reviewer mock/script#high` validated against real `opencode models`; `aria models --runtime` shows the resolved value; the reviewer's request carried the variant's settings (`reasoning_effort: high`)
- [x] T56 OpenCode TUI:
  - the sidebar block renders from the single plugin entry (other active plans, session family with model)
  - **bug found and fixed**: the `/aria-plan` keymap layer needed `mode: "global"`; after the fix it is listed in completion and opens the panel
  - the review state appears in the sidebar

### Risk-based independent review

- [x] T60 Policy in `prompts/aria.md` and `prompts/scientist.md`: three levels, assessed at the start and again on the final diff; brief contents; FAIL → confirm or rebut → fix → focused re-review; bounded loop; honest disposition reporting
- [x] T61 Reviewer: `prompts/reviewer.md` and `skills/aria-review` cover PASS / FAIL / INSUFFICIENT_EVIDENCE, BLOCKING vs NON-BLOCKING, a scientific checklist, and "never claim to have run anything"; the reviewer may also load `aria-numerics`
- [x] T62 Observed review state (`src/review.ts`, hooks in `src/index.ts`): edits, shell runs, reviewer launches (child session id from the subagent tool's structured output) and verdicts from the reviewer-only `aria_review_verdict`; stored in root-session metadata; shown in context, `aria_status`, the TUI sidebar and plan `- review:` lines
  - verified (fixtures): 21/21 state cases (stale after edits; FAIL persists until a later PASS; re-review entries; invalid verdicts rejected; inherited records ignored; plan review lines)
  - verified (live, scripted model):
    - aria flow: change → requested → FAIL with the finding quoted → still FAIL after the fix → re-review requested → PASS → stale after a further edit
    - persistence and isolation: the state survives a server restart (`--session`); unrelated sessions and forks inherit nothing
    - tool access: implementing agents cannot see the verdict tool; a top-level reviewer's verdict is rejected; the reviewer still has no write or shell tools
    - scientist flow records the same states
  - not verified: scenarios A–D, F, G and H as **judgement** (whether a real model classifies risk correctly, writes a good brief, rebuts or accepts findings, and reports truthfully). These need a real model; the scripted model shows only the mechanics.

### Installer hardening (resumed after the review work)

All verified in a disposable `HOME`/`ARIA_HOME` (`/tmp/aria-e2e`) against real OpenCode 2.3.0. The `aria` launcher ran the installed release, not the checkout.

- [x] T70 Versions and archives (`src/manager/archive.ts`, `release.ts`):
  - semver-validated versions
  - confined, non-symlink release paths
  - member validation before extraction
  - mandatory sha256
  - deterministic `aria pack`, with the lockfile included
  - verified: rejected `..`, absolute, symlink, hardlink, device, outside-`package/`, bad-version and incomplete archives (nothing written outside staging); wrong or missing checksum rejected; `rollback --to ../../etc` and a symlinked version directory rejected
- [x] T71 Same-version conflicts: content digest compared before staging (no network); identical content is reused
  - verified: repacked alpha.4 with different content rejected by both `update` and `bootstrap`; identical content gives "unchanged"
- [x] T72 Staging ownership (exclusive create, nonce marker recorded in state.json; repair removes only matching ones)
  - verified: a crash after staging → doctor reports it → repair removes it; a foreign `.staging-*` directory and one with a forged marker are both left in place and reported
- [x] T73 Failure propagation and outcomes:
  - success / partial / failed / blocked / unchanged, with per-step status in the CLI and the management TUI
  - a handled failure clears pending state; a crash leaves it for repair
  - verified:
    - a Context7 readiness failure and a Zotero backend that is down both give `partial`, exit 1, with the failed step named
    - a crash after activation is recovered by repair, which records the release config actually loads
- [x] T74 Reproducible dependencies:
  - release CLI packages come from `package-lock.json` via `npm ci --omit=dev --ignore-scripts`; a release without a lockfile is refused
  - integration tools are pinned (zotero-mcp-server 0.17.2, @playwright/mcp 0.0.85)
  - verified: release node_modules = ink 8.0.0, jsonc-parser 3.3.1, react 19.3.1 (`npm ls --omit=dev`)
- [x] T75 Lock: a second operation stops with "another ARIA operation is running", exit 4, no stack trace
  - verified: rollback during an update
- [x] T76 Launcher and bootstrap:
  - `bin/bootstrap.mjs` uses Node built-ins only
  - the `ARIA_HOME/bin/aria` (+ `.cmd`) launcher follows `ARIA_HOME/current`
  - `--link-bin` never overwrites an existing file
  - verified: first install from an unpacked tarball with no node_modules; preview exits 3; the launcher follows update and rollback; OpenCode 2.3.0 loads ARIA from the installed release (14 agents listed); a foreign `~/.local/bin/aria` is left alone and the result is `partial`
- [x] T77 `setup --with` full lifecycle (`ensureIntegration`): reuse or install → provision → configure → readiness
  - verified with a stand-in zotero-mcp executable on PATH (the real one can't be installed here): reused, configured, and the readiness call reached the server
- [x] T78 Readiness checks: local servers (start, list tools, optional read-only call); remote servers (MCP `initialize`)
  - verified: zotero ready; zotero down → not ready; Context7 → unreachable (no egress here), honestly reported
- [x] T79 Upgrade reconciliation (`aria reconcile`, run by the staged release with its own manifest)
  - verified: OpenCode reporting 2.2.0 blocks the update; nothing activated, staging removed, no pending state
- [x] T80 Engram and CodeGraph as user-managed integrations (detect only; enable refused with an explanation; tools stay unclassified)
- [x] T81 Playwright: pinned install, ARIA-owned Chromium directory, `PLAYWRIGHT_BROWSERS_PATH` in the config entry; an external copy is never reused for provisioning (readiness reworked in T93)
- [x] T82 Rollback of ARIA-managed tool paths: superseded by the journaled rollback (T95)

## Round 5 (alpha.5) — release hardening, recoverable rollback, benchmark harness

Restarted from the alpha.4 tarball after the previous session's sandbox was lost; the restart plan's fixes were re-implemented and re-verified here. All fixtures ran in disposable `HOME`/`XDG_*`/`ARIA_HOME` directories under `/tmp`; the user's configuration was never read. Fixture scripts and their logs are delivered separately (`aria2-alpha5-verification.tgz`); they are manual verification, not automated tests.

Runtime for Level B checks: OpenCode **v2.3.0** (`@opencode/cli` 2.3.0 installed into `/tmp/oc-runtime`, as in round 4). No model provider was reachable, so nothing here is Level C.

- [x] T90 Release identity (`src/manager/inventory.ts`, `archive.ts`, `release.ts`, `pack.ts`, `aria inspect`)
  - one inventory (package.json, package-lock.json, `files` entries; minus node_modules, .git, OS clutter) and one identity (sha256 over path, execute bit, content) for pack, directory and tarball inspection, staging, the same-version check and the rollback integrity check; the tarball is written from the hashed bytes and read back
  - rejects symlinks (also a symlinked ancestor of a `files` entry), special files, archive file/directory entries outside the inventory, missing lockfile, lockfile/package.json disagreement (name, version, `packages[""]`, dependency specs)
  - alpha.4 shipped exactly that disagreement (lockfile said alpha.3); versions are now bumped together (`npm version --no-git-tag-version`)
  - legacy (alpha.4) release records are checked with the legacy digest they were written with
  - verified: 34/34 fixtures (`fx_identity.sh`): directory = tarball = staged = installed identity; location independence; dev-only files, `.DS_Store` and nested node_modules excluded; distributed content and execute-bit changes detected; setup dir→tgz and tgz→dir (fresh home) both `unchanged`; identical reinstall leaves state.json byte-identical; same-version conflicts through directory and tarball; symlink/ancestor-symlink/FIFO/lock mismatch/missing lock rejected; archives with an extra file, an extra directory or node_modules rejected; tampered or extended installed release not reused and fails integrity
- [x] T91 Release dependencies: always `npm ci --omit=dev --ignore-scripts` into a release without node_modules (one is refused); every non-dev locked package checked for presence, name and version, and nothing installed outside the lockfile; a failure never activates the release. Trust boundary documented (a sidecar checks integrity, not the publisher)
  - verified: fresh install matches the lockfile; a tampered package version and an extra package are reported (in `fx_identity.sh`)
- [x] T92 Remote MCP readiness (`mcp-probe.ts` `probeRemote`, `deps.ts` `readiness`)
  - validated initialize (jsonrpc, id, error, protocolVersion from OpenCode 2.3.0's bundled SDK list, serverInfo.name, capabilities); JSON and incremental SSE (CRLF/LF/CR, CR held back at chunk ends, server notifications skipped); redirects not followed; `notifications/initialized` after success; DELETE of the session also after a rejection; URL and headers from the actual config entry with `{env:NAME}` expansion
  - classes: unreachable, timeout, reachable (HTTP but not MCP), auth, incompatible, rejected, initialized; `initialized` is reported as "hosted service not verified"
  - one `readiness()` behind `aria deps check`, `aria doctor --runtime`, `setup --with` and the TUI
  - verified: 27/27 (`fx_mcp.sh`) — the brief's 10 cases plus redirect, content type, HTTP 500, connection refused, header from config; follow-up requests observed on the server (initialized notification, DELETE with session id, protocol header); CLI, doctor and TUI (driven in a PTY) report the same verdicts
  - verified against real OpenCode 2.3.0: its own MCP client connects to the endpoint ARIA calls initialized and rejects the protocol ARIA calls incompatible (`fx_e2e.sh`)
- [x] T93 Zotero and Playwright readiness
  - Zotero: `zotero_get_recent {limit:1}`; a text answer starting with "Error" fails
  - Playwright: revision from the managed copy's `playwright-core/browsers.json`, `chromium-<rev>/INSTALLATION_COMPLETE`, executable resolved by that `playwright-core`, headless launch with channel `chrome-for-testing`, close, then the MCP server; `--browser chromium` added to the config entry; `provisioned()` uses the same marker check, so a complete browser is never downloaded again; host-library launch failures are labelled as environment limitations
  - facts taken from the published packages' source (`@playwright/mcp` 0.0.85, `playwright-core` 1.66.0-alpha-2026-11-09), read with `npm pack`, not installed
  - verified: 19/19 (`fx_deps.sh`) with a stub `playwright-core` and stub stdio servers: no browser, wrong-revision directory, incomplete (no marker), executable missing, host-library launch failure, other launch failure, successful launch, no re-download, deps check ready/not-ready; Zotero error text → not-ready, only the read-only tool called, real answer → ready
  - not verified: a real Chromium download and launch (needs authorization and the browser CDN), a real zotero-mcp
- [x] T94 Ownership
  - Engram and CodeGraph removed from the manifest (nothing in ARIA uses them)
  - ownership labels come from the manifest (`aria-managed`, `reused`, `external`, `hosted`); an ARIA-managed tool never resolves to another copy on `PATH` (found because this sandbox has an unrelated `playwright-mcp` on PATH that alpha.4 reported as the "external" Playwright)
  - after a managed tool install, ARIA-owned MCP entries are repointed to the new copy (`adoptToolCopy`); a user-changed entry is left and reported (`partial`)
  - full tool records are stored with each release when it is left and on every tool change
- [x] T95 Journaled rollback and repair (`journal.ts`, `install.ts`)
  - validate everything first (integrity, config syntax, ownership of every entry, target tool copies); user-modified MCP entry or missing tool copy → blocked (exit 4); `--keep-tools`
  - journal with before/after content and `{written, inflight}`; marker with a nonce; write order MCP configs → plugin config → launcher → state.json
  - handled error: immediate revert of this invocation's own journal; crash: journal + marker stay; while recorded, every other mutating operation refuses with exit 4 (checked at operation entry and at lock time); `repair` reverts only files that still hold ARIA's content; `--keep-changed` rebuilds state from what is loaded and reports `partial` when package and tool paths come from different releases; a journal without a marker is complete only if `state.active` is its target; `doctor` reports journals file by file
  - bug found by the fixtures and fixed: the ownership fingerprint of a repointed MCP entry was not updated (records were matched by object identity against a deep copy), so the next rollback treated ARIA's own entry as user-edited
  - verified: 39/39 (`fx_rollback.sh`) with two releases, plugin entry and MCP entry in different config files, two stub ARIA-managed tool copies adopted through `adoptToolCopy`: rollback and roll-forward restore package, tool path, launcher and state coherently; handled failures at 6 points leave all four files byte-identical; SIGKILL at 7 points → doctor reports, update/deps/models exit 4, repair restores byte-identical files; crash after state.json → journal treated as complete; crash during repair and handled failure during repair → next repair completes; a user edit after ARIA's write is never overwritten, `--keep-changed` reports partial with the release mix named; validation blocks (user-edited entry, missing tool copy, tampered release, config syntax error) write nothing; legacy alpha.4-style records still roll back
  - not verified: tool copies installed by `npm`/`pip` (stubs were adopted through the same code path; installing third-party packages was not authorized)
- [x] T96 Managed-installation workflow with real OpenCode 2.3.0 (`fx_e2e.sh`, 19/19): bootstrap preview and install from an unpacked tarball with no node_modules; launcher; idempotent setup and bootstrap; OpenCode registers all 7 agents from the installed release; `doctor --runtime` healthy; MCP enable + readiness cross-checked with `opencode mcp list`; update to alpha.6 (reconciled by the staged release against the real OpenCode version) and OpenCode loads it; crash mid-rollback → exit 4 → repair restores exact files; rollback (run by the alpha.6 launcher) and OpenCode loads alpha.5; doctor consistency
  - observed: during an interrupted rollback, OpenCode can load the release the plugin entry already names while the launcher still names the other one; that window is what the journal, the exit-4 gate and repair exist for
- [x] T97 Benchmark harness (`eval/`): tasks A–F with hidden `check.py`; `run.sh` (isolated HOME per run, `--standalone --auto`, same model/variant/task text, hidden check copied in afterwards, child sessions exported, `--followup` counted as an intervention), `collect.mjs`, `summarize.mjs`
  - verified: every check fails on the untouched repo, passes on a private reference, and fails on 14 naive solutions (26/26); harness plumbing exercised end to end with a scripted local model against real OpenCode (events, session and child export, final message, check, follow-up, totals)
  - not done: any real-model run (T31)
- [x] T98 Independent review of T90–T96 (security-sensitive installer work)
  - reviewer: a separate Claude agent with a fresh context, given the restart plan, the brief, the diff and the fixture logs as claims to test; read-only on the repository, disposable experiments under /tmp. **This is not ARIA's own Reviewer role inside OpenCode** (no model provider is reachable from OpenCode here); that review is still pending (T36)
  - round 1: FAIL, 4 BLOCKING (all reproduced by the reviewer): (1) `update` repointed `plugins[index]` captured before `npm ci` without re-checking, overwriting a user entry inserted meanwhile; (2) `--keep-changed` never re-adopted ARIA's plugin entry (it compared the whole `plugins` array) and my fixture asserted the bug as correct; (3) a handled error after activation in update/setup cleared the marker and reported "nothing durable applied" while config and launcher already named the new release; (4) `ensureIntegration`/`provisionDep` bypassed the interrupted-operation gate and could download a browser. Plus 5 NON-BLOCKING (installDep never provisioned; adopt applied edits file by file; unset `{env:}` header still counted as initialized; Playwright readiness checked the managed copy, not the one the entry runs; revert considered files never written) and minor notes (bootstrap exit code; node_modules unchecked on reuse/rollback)
  - all accepted and fixed; one fixture per finding added (rollback fixtures 39 → 51, deps 19 → 20, MCP 27 → 28)
  - round 2 (focused re-review): PASS; the reviewer re-ran its reproductions for 1–4 and confirmed them fixed. 3 new NON-BLOCKING: ownership lost if activation is interrupted between the config write and the ownership record (fixed: the activate marker carries the intended entry fingerprint, repair re-adopts it; fault point `activate:after-config`, fixtures handled + crash, 53/53); `ensureIntegration` reported "failed" for a partial install, and a failed browser download left entries repointed to a browserless copy (fixed: partial passes through; the browser is provisioned before the copy is adopted, a failed download discards the new copy); legacy releases with vendored node_modules can fail the new dependency check on rollback (kept as policy, documented in README)
  - not re-reviewed after round 2: the two round-2 fixes above (verified by fixtures only)

- [x] T99 Repeated permission requests after a user rejection (real-model failure: `zotero.zotero_semantic_search` rejected, then retried with a reworded query)
  - root cause (reproduced on real OpenCode 2.3.0, scripted model): the gate's `Permission.DeclinedError` has no message; inside Code Mode the model was shown only "Tool.Error" (vanilla OpenCode: "Permission.DeclinedError") and the turn continued, so a refusal looked transient. OpenCode keeps no memory of it, and `researcher` is allowed the same tool, so delegating bypassed the decision (reproduced: the call executed with no prompt). It is a correctable framework failure; whether a real model complies once told is not measured.
  - fix: `src/denials.ts` + the tool gate in `src/index.ts`: explicit rejection message; rejection remembered per (session tree, tool name) until the user's next root prompt; repeats and delegated calls refused without asking; OpenCode's collateral cancellation of sibling requests told apart through `permission.asked/replied` events and not recorded; prompts (aria, scientist, researcher) and README updated. Native tools (shell, edit, read, web) are not covered.
  - verified (scripted model, real OpenCode 2.3.0, 9 scenarios plus the reviewer's): retry refused with no second prompt; reason forwarded; delegation refused; unrelated tool still prompted and executed; next prompt reopens; Once still works with one prompt per call; pre-authorised researcher unaffected; parallel calls. typecheck and lint clean; identity fixtures 34/34, e2e 19/19.
  - independent review (separate Claude agent, NOT ARIA's own Reviewer): round 1 FAIL, 2 BLOCKING (sibling cancellation recorded as a rejection of unrelated tools; a false README claim), fixed; round 2 PASS, 6 non-blocking. Two fixed afterwards (honest wording when the verdict is unknown; event loop stop flag instead of an ignored abort signal) and checked by scenarios only, not re-reviewed. Left open: a narrow event-ordering race could record a sibling; an answer through the `question` tool does not reopen a rejection; `rootOf` failure refuses gated tools.
  - not verified: any real model (blocked); the TUI; event-stream failure in a real server; plugin reload.

## Remaining release blockers (need authorization or a real runtime)

- [~] T30 Runtime acceptance in OpenCode >= 2.3.0: mechanics done live (T50–T56); behaviour with a real model still needs provider access (blocked here by the egress proxy)
  - acceptance: plugin loads; 7 agents, `aria` default; `agents.<id>.model` override shows in `aria_status`; skills listed; `aria_git` and `aria_status` work; guard denies a symlink edit; tool gate asks for `opencode_schedule_create` and a test plugin tool; background subagent delegation works; TUI sidebar/panel/`/aria-plan` render once; reload leaves one set of contributions
- [!] T31 Autonomy evaluation (incl. review-judgement scenarios), ARIA vs vanilla OpenCode with the same model
  - blocked: needs real model access; no results exist yet. The procedure is ready: `eval/README.md`
- [!] T32 Live zotero-mcp check (installing it here was blocked as unauthorized): `aria deps enable zotero-mcp` then `aria deps probe zotero-mcp` against your real install; classify anything it reports as unclassified
- [ ] T33 Choose default models per role after T31 (or keep none pinned)
- [ ] T34 Windows / network-mount behaviour of `safe-fs` (case-insensitive paths fail closed; untested)
- [ ] T35 Real Chromium and real zotero-mcp readiness, and a tool rollback with npm/pip-installed copies (needs authorization to install them)
- [ ] T36 Independent review by ARIA's own Reviewer inside OpenCode (needs provider access); see the review record below for the review that was possible

## Known limitations (by design, documented in README)

- Shell rules are text policy; only OS isolation contains a write-capable agent.
- Whether review is invoked is model judgement; the plugin records and surfaces review state but does not block completion.
- Tool gate trusts OpenCode's built-in tool names; a plugin that replaces a built-in tool is not gated.
- No published update channel: updates come from a local directory or `.tgz`.
- Same-user filesystem races between check and use cannot be fully closed without `openat`-style APIs.
