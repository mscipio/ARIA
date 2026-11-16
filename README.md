# ARIA 2

ARIA is an OpenCode plugin for OpenCode v2.3.0 or later. It adds:

- a default coding agent (`aria`)
- six scoped specialist roles
- permission rules, plus two hooks that close gaps native OpenCode leaves open
- safe per-session scratch space
- plans owned by sessions
- a read-only git tool, a status report, and a TUI plan view

Everything else is native OpenCode.

**Status: experimental alpha (2.0.0-alpha.3).** Everything has been typechecked against `@opencode/plugin` 2.3.0, and the logic has been checked against disposable fixtures using OpenCode's own rule semantics. **It has not yet been loaded in a running OpenCode.** See `.aria/plans/aria2-implementation-map.md` for exactly what has been verified.

## Install and manage

ARIA ships a manager: `aria` opens a keyboard-driven terminal UI. The same operations are available as commands for scripts. Both run without OpenCode installed, so they can diagnose a broken setup.

**First install from a release** (needs Node ≥ 22.18 and npm; nothing else from ARIA has to exist yet):

```
mkdir aria-pkg && tar -xzf aria-2.0.0-alpha.6.tgz -C aria-pkg
node aria-pkg/package/bin/bootstrap.mjs --from aria-2.0.0-alpha.6.tgz --scope global --with zotero-mcp --link-bin --yes
```

The bootstrap uses only Node built-ins. It:
1. checks the tarball's sha256 (`--sha256`, or the `.sha256` file next to it), validates every member, and rejects any entry outside the release inventory;
2. installs the manager's packages with `npm ci --omit=dev --ignore-scripts` from the release's lockfile, checks every installed package against that lockfile, smoke-tests the release, and asks the release itself whether the environment fits (OpenCode and Node versions);
3. moves it to `ARIA_HOME/releases/<version>/` and writes the `aria` launcher to `ARIA_HOME/bin/aria`;
4. hands over to that release's own `aria setup --release`.

Without `--yes` it only prints the plan. `--link-bin` adds `~/.local/bin/aria` → the launcher, but never replaces a file that is already there. Otherwise add `ARIA_HOME/bin` to your `PATH`. The launcher always runs the active release, and follows updates and rollbacks.

**Building a release:** `aria pack --out <dir>` writes `aria-<version>.tgz` and its `.sha256`. The archive is deterministic, is written from the exact bytes whose identity it records, and includes `package-lock.json`, which `npm pack` would drop. `aria inspect <dir|tgz>` prints a source's version and release identity without installing anything. Change the version with `npm version <v> --no-git-tag-version`, which updates `package.json` and the lockfile together; a release whose two files disagree is refused.

**Trust boundary.** A sha256 proves that an archive is the one whose checksum you hold. It does not prove who published it: a `.sha256` file downloaded next to an archive can be replaced together with it. Use a checksum you obtained through a channel you trust (or build the release yourself with `aria pack`). ARIA has no signing infrastructure.

**Development checkout:** run `npm install`, then `node bin/aria.mjs …` (or `aria setup --dev`). The OpenCode plugins themselves need none of the manager's packages.

### What the manager does

| Section | What it covers |
|---|---|
| 1 Install | Development install (register a checkout) or release install (copy, verify, register) per scope; repair |
| 2 Health | Every check with its status and how it was established (`static`, `runtime` or `none`); evidence; repair preview |
| 3 Models | Per-role model and variant, which config file sets it, the value OpenCode resolved, and availability. Set, change variant, remove pin, undo |
| 4 Deps | The dependency manifest with ownership: OpenCode, Node, Git, CLI packages, and the Zotero, Context7 and Playwright MCPs. Install, enable, disable, check readiness, and probe a server's real tool list |
| 5 Updates | Current and previous releases; update from a directory or `.tgz`; rollback |
| 6 Config | Config files found, entries ARIA owns, paths, and a permission summary |

Keys: `1`–`6` or arrows switch sections, `↑↓` select, Enter runs a row's main action or opens details, `r` queries OpenCode for runtime facts, `s` switches scope (project/global), `?` help, `q` quit.

**Every change is previewed first** (a dry run of the same backend) and needs `y`. On the command line, mutating commands preview by default and apply with `--yes`.

### Commands

```
aria doctor [--runtime] [--json]
aria setup [--scope project|global] [--dev [path] | --release [--from dir|tgz] [--sha256 hex]]
           [--with zotero-mcp,context7,playwright-mcp] [--adopt] [--link-bin] [--force]
aria update [--check] --from <dir|tgz> [--sha256 hex] [--force]
aria rollback [--to version] [--keep-tools]   ·   aria repair [--keep-changed]
aria pack [--out dir] [--source dir]   ·   aria inspect [dir|tgz]   ·   aria reconcile
aria models [list|available] [--runtime]  ·  aria models set|reset|restore <role|default> ...
aria deps [list]  ·  aria deps install|update|enable|disable|probe <id>  ·  aria deps check [id]
aria plans  ·  aria scratch list|clean
```

Exit codes: `0` ok, `1` problem, `2` usage, `3` preview only (add `--yes`), `4` blocked: a conflict that needs your decision, another ARIA operation holds the lock, or an interrupted operation is waiting for `aria repair`.

**Results.** Each operation reports one of these outcomes, with each step marked done, FAILED or skipped:
- `success`
- `partial`: ARIA itself was installed, but a requested integration failed or isn't ready
- `failed`: nothing durable changed
- `blocked`
- `unchanged`

A partial result exits `1` and is never reported as success.

### Guarantees and limits

- **Ownership.** ARIA records each config entry it writes and changes only those. If an entry of yours occupies the same key, the operation stops and reports a conflict.
- **Edits are minimal.** Changes are targeted JSONC edits that keep comments and formatting, are written atomically, and are refused if the file changed since the preview.
- **Releases:**
  - Stored in `ARIA_HOME/releases/<version>/`, where `ARIA_HOME` defaults to `~/.local/share/aria` and `%LOCALAPPDATA%\aria` on Windows. Versions are validated (semver, no path characters), and every release path must be a real directory inside the real releases directory.
  - **One definition of release content** (`src/manager/inventory.ts`) is used by pack, inspect, staging, the same-version check and the rollback integrity check: `package.json`, `package-lock.json` and the `files` entries, minus `node_modules`, `.git` and OS clutter. The release identity is a sha256 over each file's relative path, execute bit and content, so a checkout, its tarball, its staging directory and the installed release have the same identity wherever they are. Symlinks (including a symlinked parent of a `files` entry), special files, and a lockfile that disagrees with `package.json` are rejected.
  - A `.tgz` **must** match a sha256 (`--sha256` or `<file>.sha256`). Its members are validated before anything is written: no `..`, absolute paths, links, devices, anything outside `package/`, or any file or directory outside the release inventory (so a release never ships `node_modules`).
  - Staging directories are created exclusively and carry a random marker that is also recorded in `state.json`. The staged copy is written from the bytes that were hashed and must have the source's identity. It then gets `npm ci --omit=dev --ignore-scripts` from its own lockfile (always; a release that already contains `node_modules` is refused), every installed package is checked against the lockfile (version, name, nothing extra), it is smoke-tested, and it is checked against the environment by the new release's own manifest. Incompatibilities such as an OpenCode outside its range block activation unless you pass `--force`. A failed install never activates the release; the previous one stays.
  - **Same version, different content is a conflict.** A version that is already installed is reused only if its identity is the same and nothing was added to it.
  - Activation repoints the one ARIA-owned plugin entry and `ARIA_HOME/current`. Release directories are never edited, so running sessions keep their files.
  - **Rollback** is journaled, because no filesystem or OpenCode mechanism makes several files change atomically:
    1. Everything is validated first: the target release's integrity, every config file's syntax, ARIA's ownership of every entry it will change, and the tool copies the target release recorded. A user-modified MCP entry or a missing tool copy blocks the rollback (exit 4) before anything is written; `--keep-tools` rolls back only the package.
    2. A journal records each file's exact content before and after, then an interrupted-operation marker is set.
    3. Files are written in order: MCP config files, the plugin config file, the launcher (`ARIA_HOME/current`), then `state.json`. Each write is atomic and the journal records `{written, inflight}`.
    4. A handled error reverts at once (only this invocation's journal). A crash leaves the journal; `aria repair` puts back every file that still holds what ARIA wrote and never overwrites a file you changed afterwards. `aria repair --keep-changed` keeps your changes, takes the active release from the registration OpenCode actually loads, re-adopts only values that are still ARIA's, and reports `partial` if the package and a tool path now come from different releases.
  - **Tool records.** Each release keeps the full records of the ARIA-managed tools it ran with: written when the release is left and on every tool change. Installing or updating a managed tool repoints ARIA-owned MCP entries to the new copy (an entry you changed is left alone and reported).
  - **Reuse and rollback also check dependencies**: an installed release whose `node_modules` no longer matches its lockfile is not reused or rolled back to. This includes releases installed by alpha.4 or earlier from an archive that vendored `node_modules` (alpha.4 skipped `npm ci` then): if their modules differ from the lockfile, roll back to them is refused; remove that release directory and install it again.
  - Up to three releases are retained beyond the active and previous ones; unknown directories are never deleted.
  - One operation at a time: a lock file in `ARIA_HOME` makes a second operation stop with exit code 4.
- **No update channel yet.** ARIA isn't published, so updates come from a local directory or tarball.
- **Interrupted operations.**
  - A handled failure leaves nothing pending; an invocation clears only the marker it wrote.
  - A crash leaves a marker (and, for rollback, a journal). While one is recorded, every other mutating operation refuses with exit 4; `aria doctor` reports it, including what each journaled file holds now.
  - `aria repair` resolves journals as described above, removes only staging directories whose marker matches ARIA's record, and re-records the active release from config. Anything it can't prove it owns is listed and left alone. A journal without a marker counts as complete only if the active release is its target.
- **Integrations (`--with`):**
  - Each one is either reused, if a compatible executable exists, or installed as a pinned version under `ARIA_HOME/tools/` (zotero-mcp-server 0.17.2, @playwright/mcp 0.0.85).
  - It is then configured and checked for readiness. One check (`readiness()`) is behind `aria deps check`, `aria doctor --runtime`, `setup --with` and the management TUI (`c` on the Deps tab), and it never calls a mutating tool:
    - Zotero: the server starts, lists its tools, and answers `zotero_get_recent` (needs Zotero desktop with its local API). An answer that starts with "Error" counts as a failure, because zotero-mcp reports errors as plain text.
    - Context7 (remote): a real MCP `initialize` with the URL and headers of your config entry (`{env:NAME}` is expanded). The response must be valid JSON-RPC with the right id, a supported protocol version (OpenCode 2.3.0's: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07), `serverInfo` and capabilities; SSE answers are read incrementally. Redirects are not followed. ARIA then sends `notifications/initialized` and closes the session with DELETE (also after a rejection). Results distinguish unreachable, timeout, reachable-but-not-MCP, authentication, incompatible, rejected and initialized; `initialized` does not prove the hosted service works.
    - Playwright: always ARIA's pinned copy, `--browser chromium` (channel `chrome-for-testing`), browsers in `ARIA_HOME/tools/playwright-browsers`. Readiness resolves the browser revision through that copy's own `playwright-core`, requires Playwright's `INSTALLATION_COMPLETE` marker and the executable, launches headless once and closes it, then starts the MCP server. A complete browser is never downloaded again. A launch failure caused by missing host libraries is reported as an environment limitation.
  - An integration that isn't ready makes the result `partial`.
- **Ownership** comes from the manifest: `aria-managed` (ARIA installs, updates, rolls back and repairs it; another copy on `PATH` is not used), `reused` (an existing Zotero MCP; ARIA does not change it), `external` (OpenCode, Node, Git) and `hosted` (Context7). Engram and CodeGraph were removed in alpha.5: nothing in ARIA needs them, and detect-only entries produced warnings without a lifecycle. You can still configure any MCP server yourself; its tools are unclassified, so coding roles are asked before each use and read-only roles can't see them.
- **External tools are never touched.** OpenCode, Node, Git, and existing MCP installations are only detected, never installed, upgraded or removed. A copy ARIA installs itself goes under `ARIA_HOME/tools/`.
- **Runtime facts are opt-in.** `--runtime` (or `r` in the TUI) runs `opencode debug agents`, `models` and `debug config`, which starts or contacts an OpenCode server and may reach providers. Without it, every result is labelled static.

### Registering by hand

One `plugins` entry loads both parts: the server plugin (`exports["."]`) and the OpenCode TUI extension (`exports["./tui"]`). Do not add a second entry.

```jsonc
{ "plugins": [{ "package": "/absolute/path/to/aria", "options": { "zoteroServer": "zotero" } }] }
```

- **Entry forms.** An entry can be an absolute path, a `file://` URL, or `./` / `../` relative to the config file's own directory. Any other string is treated as an npm package name.
- **Auto-loading.** A directory under `.opencode/plugins/` or `~/.config/opencode/plugins/` is also loaded automatically; `aria doctor` reports that as a duplicate.
- **Build and dependencies.** No build is needed: OpenCode runs on Bun and loads TS/TSX directly. The host supplies `@opencode/plugin`, `effect`, `solid-js` and `@opentui/*`. *(Source-verified, not yet runtime-verified.)*

## Roles

| Role | Mode | Purpose |
|---|---|---|
| `aria` | primary/subagent | Default engineer: investigate, implement, verify, report |
| `scientist` | primary/subagent | Scientific work end to end: method, Python/MATLAB code, analysis, interpretation |
| `planner` | primary/subagent | Durable plans for large work |
| `writer` | primary/subagent | Manuscripts, reports, rebuttals |
| `researcher` | primary/subagent | Literature and evidence (Zotero, web) |
| `scout` | subagent | Read-only exploration |
| `reviewer` | subagent | Independent read-only review |

**Models.** ARIA pins no models. Each role uses the model you selected; subagents use their caller's model. Pin one with `aria models set <role> provider/model#variant` (or section 3 of the manager). That writes `agents.<role>.model` to the project or global config, and the change applies to sessions started afterwards.

The manager keeps three values apart:

- **Configured:** read from the config files (static).
- **Resolved:** what OpenCode reports through `opencode debug agents`.
- **Available:** whether `opencode models` lists the model.

Variants cannot be listed from the OpenCode CLI, so they are checked only when a session starts. Inside a session, `aria_status` shows the effective model.

## Permissions

How rules are evaluated, from OpenCode v2.3.0 source:

- Rules are ordered and the last matching rule wins.
- A tool whose name is denied outright is removed from the model's tool list, including from Code Mode.
- Per-call checks happen only where a tool asserts permission.

Your own `permissions` and `agents.<id>.permissions` are applied after ARIA's rules and override them. `policies` can only deny.

### Role matrix

Every cell was checked against OpenCode's evaluate and visibility logic: 184 cases. It has not been checked in a live server.

| | aria / scientist | planner | writer | scout / reviewer | researcher |
|---|---|---|---|---|---|
| read, glob, grep | yes | yes | yes | yes | yes |
| `.env` read | ask | ask | ask | ask | ask |
| credential files (keys, `.ssh`, `.aws`, `.netrc`, auth.json…) | deny | deny | deny | deny | deny |
| outside the project | read asks, write denied | read asks | read asks | read asks | read asks |
| edit/write/patch | project, except: config/authority files ask, secrets deny | `.aria/plans/*.md` only (top level) | prose files only (`md tex bib txt rst typ qmd org adoc`); never inside `.aria/ .opencode/ .claude/ .agents/ .git/ .github/ .vscode/ node_modules/` at any depth, nor `AGENTS.md`, `CLAUDE.md` or other authority files | hidden | hidden |
| shell | yes; installs, history changes, recursive deletes, containers ask; publish, deploy and sudo denied | hidden | hidden | hidden | hidden |
| Code Mode (`execute`) | yes | hidden | hidden | hidden | hidden |
| unknown MCP / plugin tools | ask | hidden | hidden | hidden | hidden |
| Zotero (zotero-mcp) | ask | hidden | hidden | hidden | reads allowed; library/index/authorization changes ask; unclassified tools hidden |
| web fetch/search | yes | no | no | scout yes, reviewer no | yes |
| subagents | aria: all six; scientist: scout, reviewer, researcher, writer | scout | researcher | none | none |
| scheduling, worktree creation, artifact delete | ask | hidden | hidden | hidden | hidden |

The coding roles start from **ask** for anything unknown, instead of OpenCode's default allow-all. A newly connected MCP server or plugin tool cannot act without a prompt. Normal development runs without prompts: read, search, project edits, shell, todo, web reads and Code Mode.

### Enforced by ARIA's hooks

Both hooks can only tighten a decision, never loosen one.

- **Guard** (`permission.evaluate`):
  - Denies reads and edits whose real path leaves the project through a symlink.
  - Denies any edit that goes through a symlink inside the project. Otherwise the planner's `.aria/plans/*.md` could be redirected into `src/`.
  - Denies a read when an innocent-looking link points to an env or credential file.
  - Enforces scratch ownership per session.
- **Tool gate** (`tool.execute.before`): asserts permission for every tool except OpenCode's built-in tools that check permission themselves. That includes MCP tools, plugin tools and the built-in `opencode_*` tools that never check, so `ask` and `deny` rules hold for all of them, including inside Code Mode. OpenCode records no tool provenance, so no name prefix is trusted. An MCP tool's own identical check, in the same call, passes once after the gate's approval, so you are not asked twice.
- **Rejections** (the tool gate, `src/denials.ts`): when you answer a prompt for one of those tools with Reject, OpenCode 2.3.0 gives the model only a bare error (`Tool.Error`, or `Permission.DeclinedError` without ARIA), and inside Code Mode the turn carries on. ARIA replaces that with a message saying you rejected the tool (and why, if you typed a reason), and remembers it. For the rest of that request, until you send your next message, any call to the same tool is refused without asking you again, whatever the arguments, including a call made by a subagent the model launches. Only the tool you actually answered is blocked. OpenCode also cancels every other request pending in the session when you reject one; ARIA recognises those from OpenCode's permission events, tells the model its call was cancelled and not decided, and does not record it, so the model may ask again. If the events cannot establish which request you answered (for example the event stream failed), nothing is recorded, the model is told the refusal could not be confirmed, and the protection against a retry is off for that call. Your next typed message (or command) reopens the question, so you can still approve what you then ask for; an answer given through the model's `question` tool does not. Memory is per session tree and in process only. A plain Reject on one of these tools used to end the model's step when the model called it directly; now the step continues with the explicit message. Tools that OpenCode checks itself (shell, edit, write, web) keep OpenCode's own handling, which is per resource: a plain Reject there ends the step.

### Not enforced: policy only

- **Shell rules match command text.** `sh -c`, interpreters, compound commands and scripts can do anything your user account can, including writing outside the project. For the coding roles this is a practical policy, not containment. Read-only roles have no shell at all, which is the only reason "read-only" holds for them.
- **Only OS isolation is a boundary**, for example a container, a separate user, or read-only mounts.
- **MCP servers act with their own privileges.** ARIA controls whether a tool may be called, not what the server does. For example, Zotero semantic search may write its own cache.
- **The tool gate trusts OpenCode's built-in tool names.** A third-party plugin that registers a tool under a built-in name (for example `read`) replaces the built-in and is not gated.
- **Remaining races.** Between check and use, a process running as your user can swap a directory for a link. ARIA fails closed where it can (see `src/safe-fs.ts`), but cannot fully close this gap without OS support.

A denial is a boundary. The agents are instructed to stop and report, not to route around it.

## Independent review

ARIA decides when a change needs an independent review, runs it, fixes blocking findings and asks for a focused re-review. You don't have to request it.

| Level | When | What happens |
|---|---|---|
| 0 | typos, formatting, small docs, low-risk local edits | self-verification only; no reviewer |
| 1 | non-trivial local fixes, moderate refactors, uncertain behaviour | aria/scientist decide; a skip is reported with a reason |
| 2 | architecture, filesystem/paths/cleanup, permissions/security, installer/update/rollback, data loss, concurrency/recovery, public APIs or formats, numerical/scientific algorithms, imaging, units, calibration | review required, however small the diff |

**The cycle.** implement → self-verify → `reviewer` (read-only, reads the real diff) → **PASS**, **FAIL** (blocking findings with locations) or **INSUFFICIENT_EVIDENCE** (what is missing and how to get it). After FAIL: confirm or rebut each finding, fix it, re-verify, then a focused re-review in the same reviewer session. If disagreement or a missing piece of evidence persists, ARIA reports it rather than looping.

**Enforced by the plugin:**
- The verdict is structured data the reviewer records with `aria_review_verdict`. Only a reviewer launched as a subagent can call it; implementing agents can't see the tool.
- ARIA observes edits, shell runs and reviewer launches. It keeps the state in the root session's metadata and shows it in aria's context, `aria_status` and the TUI sidebar:
  - `none` / `requested` / `passed` / `failed` / `insufficient`
  - `stale`: changed after the review started
- A FAIL stays failed until a later review passes.
- Forks and unrelated sessions do not inherit the record.

**Not enforced:**
- Whether a change *needed* review is the agent's judgement under the policy above; nothing blocks completion without one.
- The final report wording is the model's. ARIA cannot stop a model from misreporting, but the recorded state it is told to report and the state you see are the real ones.
- Edits made by shell commands are counted but not attributed to files.

With a plan, tasks carry `- review: required | not-required | skipped: … | pass | fail | insufficient`, which the TUI shows next to the task.

## Scratch

Each session that can write gets `.aria/scratch/<root-session>/<session>/` for throwaway files: scripts, logs, terminal captures, intermediate output, disposable fixtures. Deliverables and intentional edits go in their proper place.

- **Layout.** Single files go directly in the session directory. To group related files an agent makes an activity directory named `YYYYMMDD-HHMMSS-short-kebab-description` with plain `mkdir` (it fails if the name exists; add a suffix). Names are organisation only: ownership is decided by the two session ids, and nested paths below the session directory are allowed.
- **Creation.** It is created one directory at a time from the real project root. A symlinked `.aria` or `.aria/scratch` disables scratch rather than being followed. Session IDs are validated before being used as paths.
- **Ignored by Git.** `.aria/scratch/.gitignore` contains `*`.
- **Delivery.** For the `aria` and `scientist` roles (the only ones with a shell or project edits) the absolute path is added to the system context on every model request, after the directory has been re-created if it was removed. If scratch cannot be provisioned, the context says so and forbids `/tmp` instead of naming another place. Read-only roles get no scratch and no write access. A subagent has its own directory under the same root; it cannot write its caller's, and the caller shares a file by giving the subagent its path.
- **Shell.** OpenCode starts every shell command with `OPENCODE_SESSION_ID` set, but its `shell` hook does not say which session a command belongs to, so ARIA does not set `TMPDIR` automatically. The context gives the path and tells the agent to run tools that choose their own temporary location as `TMPDIR=<scratch> command`, or to use `mktemp -d -p <scratch>`. The host's own `TMPDIR` (e.g. a cluster's `/home/scratch`) otherwise applies to `mktemp`.
- **Limits.** This is a convention, not containment. What is enforced: the `edit`/`write`/`patch` tools may write only the caller's own scratch (guard), `edit` to absolute paths outside the project is denied, and reading outside the project asks. Anything a shell does depends on the model following the instruction in its context.
- **DONE marker.** The root session marks completion with `.aria/scratch/<root>/DONE`. It must be a regular file; a link is ignored. If any session of that root is active more than ten minutes after DONE was written, the marker is treated as stale and the scratch is kept.
- **Activity.** Every model request of a session refreshes its directory's modification time, so cleanup judges activity without scanning nested files. A job that runs for longer than the `--stale` age without any model request is not detected.
- **Cleanup.** `node bin/aria.mjs scratch clean [--stale N] [--dry-run]` removes only DONE-marked (and not reopened) or explicitly stale root trees; `N` is a whole number of days. Before deleting, it re-reads the tree, renames it and re-checks its identity. It never follows links, never crosses filesystems, and keeps anything malformed or changed meanwhile.

## Instruction files

ARIA does not create, read, update or depend on `AGENTS.md` or `CLAUDE.md`. Its behaviour lives in the role prompts and skills, its filesystem rules in code. OpenCode 2.3.0 itself still loads a project's `AGENTS.md` (from the working directory up to the project root) and the one in its global config directory into the model context; it does not load `CLAUDE.md`. The only switch found is `OPENCODE_DISABLE_PROJECT_CONFIG`, which also disables the project's `opencode.jsonc` (plugin, model pins, permissions), so ARIA leaves it alone. ARIA still asks before editing a project's own instruction files.

## Plans

Plans are plain Markdown files at the top level of `.aria/plans/`, with front matter containing `status` and `session`.

- **Ownership.** `session:` records the root session that owns the plan. A session resumes only its own plan. Other active plans are listed as not its task, unless you refer to them.
- **State.** A checkbox is plan state. A `verified:` line is recorded evidence, which the UI shows as "evidence recorded", not "verified". A subagent finishing never changes task state.
- **What is read.** Plans are read by one confined reader. Symlinked directories or files, nested files, odd names, files without front matter and files over 256 KB are skipped with a reason that never includes their content.

## Tools

- **`aria_git`**: read-only `status`, `diff`, `log` and `show`. It runs with no pager, external diff, textconv, fsmonitor, signature program or submodule recursion. Every configured `filter.*` driver is disabled for that one call. Credential files are excluded, and `rev:path` blob reads are rejected.
- **`aria_status`**: effective roles, models and availability; plans owned by this session and by others; any skipped plan files; the recorded review state.
- **`aria_review_verdict`**: reviewer only; records PASS / FAIL / INSUFFICIENT_EVIDENCE as structured state.

## TUI

- **Sidebar ("ARIA Plan", collapsible):** the plan you selected for this session (`[select]` or `/aria-plan`), or else the plan owned by this session, as a task list coloured by state (pending, in progress, executed, evidence recorded, blocked), then the session family with agent, state and model. The choice is remembered per project and session.
- **Review reminder:** one line under the progress line, shown only when it matters: `◌ N edits unreviewed` / `since review` once N edits (default 5, set `ARIA_REVIEW_NUDGE_EDITS`) have no review, `◌ review running`, `✗ review failed · n blocking`, or `◌ review: evidence missing`. Nothing is shown below the threshold or after a PASS for the current changes.
- **Plan panel:** click the plan title or use `/aria-plan-open`. It shows the selected plan as rendered Markdown (scroll, `y` copy over OSC 52, `m` raw/rendered, `f` fullscreen). Plan files are read through the OpenCode server, so this works over SSH; if that fails the local reader is used, and if nothing can be read the panel says so instead of showing stale data.
- **Updates:** toasts for task and subagent changes. An OS notification fires only for a blocked task, a failure, a finished plan, or the root session finishing, and only while the terminal is unfocused.
- **Refresh:** debounced to at most one per 500 ms, plus a 5-second timer.
- **Read states:** plan reads are reported as absent, empty, complete, partial or unavailable. A partial or failed read never triggers "started"/"done" notifications, and old plans are not shown as current.

## Zotero

The researcher's Zotero tool names come from the source of [zotero-mcp](https://github.com/54yyyu/zotero-mcp) (PyPI `zotero-mcp-server`). Its read tools are allowed; anything that changes the library, the index, the active library or write authorization asks. Tools that aren't classified yet are hidden.

- **Server name.** Tool names are matched as `<server>_<tool>` under the `zoteroServer` option, which defaults to `zotero`.
- **Running the server.** `aria deps enable zotero-mcp` finds an existing install (PATH, conda/mamba environments, `~/.local/bin`) and writes its absolute path, so no environment needs activating. `aria deps install zotero-mcp` creates an ARIA-owned venv instead (network).
- **Checking the tool names.** `aria deps probe zotero-mcp` starts the server, lists its real tools without calling any, and reports tools ARIA has not classified (they stay hidden) and expected names the server lacks.
- **No Zotero.** If the server is missing, the researcher says so and uses web sources.
- **Not verified live.** The names come from zotero-mcp's source and have been checked only against a fake server; the real server has not been probed yet.

## Licence

MIT. See `LICENSE` and `NOTICE` for the two copyright holders and what each covers.
