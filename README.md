# ARIA 2

ARIA is an OpenCode plugin for OpenCode v2.3.0 or later. It adds:

- a default coding agent (`aria`)
- seven scoped specialist roles
- permission rules, plus two hooks that close gaps native OpenCode leaves open
- safe per-session scratch space
- plans owned by sessions
- a read-only git tool, a status report, and a TUI plan view

Everything else is native OpenCode.

**Status: experimental alpha (2.0.0-alpha.9).** Everything has been typechecked against `@opencode/plugin` 2.3.0, and the logic has been checked against disposable fixtures using OpenCode's own rule semantics. The plugin loaded and resolved its roles under OpenCode 2.3.2; the alpha.9 sidebar change has not been visually exercised in a running TUI. See `.aria/plans/aria2-implementation-map.md` for exactly what has been verified.

## Install and manage

ARIA ships a manager: `aria` opens a keyboard-driven terminal UI. The same operations are available as commands for scripts. Both run without OpenCode installed, so they can diagnose a broken setup.

**First install from a release** (needs Node ≥ 22.18 and npm; nothing else from ARIA has to exist yet):

```
tmp=$(mktemp -d) && tar -xzf aria-2.0.0-alpha.9.tgz -C "$tmp"   # disposable; remove it afterwards
node "$tmp"/package/bin/bootstrap.mjs --from aria-2.0.0-alpha.9.tgz --scope global --with zotero-mcp --link-bin --yes
```

The bootstrap uses only Node built-ins. It:
1. checks the tarball's sha256 (`--sha256`, or the `.sha256` file next to it), validates every member, and rejects any entry outside the release inventory;
2. installs the manager's packages with `npm ci --omit=dev --ignore-scripts` from the release's lockfile, checks every installed package against that lockfile, smoke-tests the release, and asks the release itself whether the environment fits (OpenCode and Node versions);
3. moves it to `ARIA_HOME/releases/<version>/` and writes the `aria` launcher to `ARIA_HOME/bin/aria`;
4. hands over to that release's own `aria setup --release`.

Without `--yes` it only prints the plan. `--link-bin` adds `~/.local/bin/aria` → the launcher, but never replaces a file that is already there. Otherwise add `ARIA_HOME/bin` to your `PATH`. The launcher always runs the active release, and follows updates and rollbacks.

**Building a release:** `aria pack` writes `aria-<version>.tgz` and its `.sha256` to `--out <dir>`, by default `<checkout>/../releases` (never the current directory, and never inside the source tree; an installed release must pass `--out`). The archive is deterministic, is written from the exact bytes whose identity it records, and includes `package-lock.json`, which `npm pack` would drop. `aria inspect <dir|tgz>` prints a source's version and release identity without installing anything. Change the version with `npm version <v> --no-git-tag-version`, which updates `package.json` and the lockfile together; a release whose two files disagree is refused.

**Trust boundary.** A sha256 proves that an archive is the one whose checksum you hold. It does not prove who published it: a `.sha256` file downloaded next to an archive can be replaced together with it. Use a checksum you obtained through a channel you trust (or build the release yourself with `aria pack`). ARIA has no signing infrastructure.

**Development checkout:** run `npm install`, then `node bin/aria.mjs …` (or `aria setup --dev`). The OpenCode plugins themselves need none of the manager's packages.

### What the manager does

| Section | What it covers |
|---|---|
| 1 Install | Development install (register a checkout) or release install (copy, verify, register) per scope; repair |
| 2 Health | Every check with its status and how it was established (`static`, `runtime` or `none`); evidence; repair preview |
| 3 Models | Per-role model and variant, which config file sets it, the value OpenCode resolved, and availability. Set, change variant, remove pin, undo |
| 4 Deps | The dependency manifest with ownership: OpenCode, Node, Git, CLI packages, the Zotero, Context7 and Playwright MCPs, and the Impeccable skill. Install, update (`u`, or `U` for all), repair, remove, enable, disable, check readiness, and probe a server's real tool list. The same backend as `aria deps` |
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
aria deps [list]  ·  aria deps install|update|repair <id> [--scope]  ·  aria deps update --all  ·  aria deps remove|enable|disable|probe <id>  ·  aria deps check [id]
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
- **Edits are minimal.** Changes are targeted JSONC edits that keep comments and formatting, are written atomically, and are refused if the file changed since the preview. Existing file permissions are preserved; new config/state files are private by default.
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
  - **Tool records.** Each release keeps the full records of the ARIA-managed tools it ran with: written when the release is left and on every tool change. Tool adoption journals the generated integration plugins, MCP entries and state together, using the same recovery path as rollback. A handled failure reverts those writes; an incomplete recovery retains the copy and journal for `aria repair` and reports `partial`. An entry you changed is left alone and reported. Rollback also restores the matching ARIA-owned generated integration plugin; a modified plugin blocks it unless you use `--keep-tools`.
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
- **Dependency lifecycle** (`aria deps`, the manager's Deps tab and `setup --with` share one backend, `manageDep` in `src/manager/deps.ts`):
  - `install <id>`: for skills (and `setup --with`) reuses a valid existing installation; `deps install` of an MCP tool installs ARIA's own pinned copy beside an existing one, which then takes precedence. `update <id>`: moves an ARIA-installed copy to the version this ARIA pins (nothing is checked remotely: "outdated" means differing from the pin). `repair <id>`: restores a missing or damaged ARIA-installed copy. `update --all`: does both for every ARIA-installed dependency and leaves the rest listed but untouched. Every mutating command previews first; `--yes` applies. `aria setup` never upgrades an existing installation.
  - After a change, an enabled MCP integration is re-checked for readiness.
  - Externally managed (OpenCode, Node, Git), reused (an existing copy ARIA did not install) and hosted (Context7) dependencies are reported, never updated, repaired or removed by ARIA.
  - Each dependency lists the roles that use it and whether it is `required`, `role` (ARIA works, those roles are not fully ready without it) or `optional`. `aria doctor` shows a readiness line per such role; other roles stay operational.
- **Impeccable** (design skill for the `visualizer`, Apache-2.0, github.com/pbakaus/impeccable) is installed as a managed skill, not bundled in the release: `aria deps install impeccable [--scope global|project]` (default global, `<OpenCode config>/skills/impeccable`; `setup --with impeccable` and the manager use the same default, and reuse any compatible copy in either scope). Version 4.8.1 at a pinned commit; the archive and the native helper (linux-x64 only; other platforms get the skill without it) are downloaded over HTTPS and checked against pinned SHA-256 values before anything is written. The tree carries `.aria-impeccable.json` with a hash of every file. ARIA updates, repairs or removes a copy only if it wrote it and nothing was modified; a copy without that marker (yours, or any other install) is reused when its version is within `>=4.8.0 <5.0.0` and is never changed. The archive hash was computed locally from GitHub's archive of the pinned commit (upstream publishes none), so the pin proves content, not who published it. Only the `visualizer` can load it. If it is missing or broken, `aria doctor` reports the visualizer as not fully ready, and the visualizer stops and reports the fix instead of substituting another skill.
- **Engram and Context7 are shared capabilities for all eight roles** (requirement `role`: a missing one degrades readiness, reported by `aria doctor` and the Deps tab, and never stops other agents).
  - **Engram** (github.com/Gentleman-Programming/engram, MIT; pinned 3.7.1, Linux/macOS builds with SHA-256 from the release's checksums.txt) needs both its MCP server and its OpenCode plugin. `aria deps install|update|repair engram` manages the binary under `ARIA_HOME/tools`; `aria deps enable engram [--scope]` registers `mcp.servers.engram` and writes the plugin file (generated by that binary in a throw-away HOME, recorded as ARIA-owned) into the scope's `plugins/` directory, because OpenCode 2.3.0 loads the plugin only from there. ARIA never runs `engram setup opencode` against your configuration (it also writes an old-form MCP entry and a `tui.json` statusline plugin). An existing install, plugin file or MCP entry of yours (either config form) is reused and never replaced; update and repair apply only to ARIA's own copy, and the plugin file follows the binary.
  - **Permissions:** every role can recall (`mem_search`, `mem_context`, `mem_get_observation`, `mem_current_project`, `mem_list_projects`, `mem_doctor`, `mem_search_prompts`, `mem_suggest_topic_key`: the tools Engram marks read-only). `aria`, `scientist` and `writer` can also `mem_save`, `mem_update`, `mem_session_summary`. Other Engram tools ask for `aria` and `scientist` and are hidden from everyone else. The Engram plugin itself records sessions, prompts and passive task-output observations for every role, and shell policy does not block `engram` commands: "read-only" holds for model tool calls, not for plugin logging or shell use. Prompts tell roles to use memory selectively and treat it as subordinate to source files, plans and the user.
  - **Two kinds of memory writes.** *Agent-invoked*: a role calls `engram_mem_save` and friends; ARIA's permissions decide who may (above). *Automatic*: the Engram plugin, once installed, records sessions, prompts and passive task-output observations for every role and injects its own memory protocol, whatever a role's permissions say; ARIA's prompts tell roles to follow ARIA's policy over that protocol, but cannot stop the recording. Only removing the plugin stops it.
  - **Health.** Engram is operational only when its executable runs, the MCP entry is registered and exactly one copy of the plugin is loaded. Missing or disabled is reported `missing`; MCP without plugin, a foreign file in the plugin's place, or a duplicate plugin is `config-error`; `aria deps check engram` (and `doctor --runtime`) then verify the plugin, the server's tool list and a read-only call.
  - **Disable and duplicates.** `aria deps disable engram` removes both the MCP entry and the plugin file, but only what ARIA wrote and nobody changed. If you own a plugin file (a `.ts`/`.js` file carrying Engram's marker at the top level of a `plugins/` directory in the project root or global scope) or list it in a config `plugin`/`plugins` array (matched by package or file name `engram`, `engram-opencode`, `engram-plugin`; not by any path that merely contains the word), or you wrote the MCP entry, ARIA leaves it, reports the result `partial` and says "NOT fully disabled" with what keeps recording. Enable never adds a plugin when one is already loaded through any of those routes; if two are loaded, health reports the duplicate and ARIA deletes nothing it did not write. A symlinked config directory is refused before anything is changed. A project-scope plugin file contains an absolute path of this machine: do not commit it; `.opencode` is excluded from release packages.
  - **Engram's data directory ignores `$HOME`** (it uses the real home unless `ENGRAM_DATA_DIR` is set), and the plugin and MCP talk to the local server on `ENGRAM_PORT` (default 7437). Isolated tests must set both.
  - **Context7** tools are available to all roles, including reviewer, planner and writer. Anonymous use works; an API key goes in your own entry as a `{env:NAME}` header, never written by ARIA.
- **Ownership** comes from the manifest: `aria-managed` (ARIA installs, updates, rolls back and repairs it; another copy on `PATH` is not used), `reused` (an existing Zotero MCP; ARIA does not change it), `external` (OpenCode, Node, Git) and `hosted` (Context7). Engram is a managed shared capability again (see above); CodeGraph is not used by any ARIA 2 role. You can still configure any MCP server yourself; its tools are unclassified, so coding roles are asked before each use and read-only roles can't see them.
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
| `visualizer` | all | UI/UX and frontend specialist (web, Qt Widgets): direct or delegated design analysis, frontend edits, visual QA |

`all` means the agent can run as either the primary agent or a subagent. The visualizer can use the configured Playwright MCP tools without ARIA prompting on each call; user-level permissions or policies may still deny them. If the configured Zotero server name collides with the `playwright_*` namespace, the Zotero deny takes precedence for safety.

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

The 184-case evaluation covered the seven original roles and was not re-run for `visualizer`. The visualizer's project-edit, scratch, and authority-file rules were checked separately against its resolved rules (from `opencode debug agents` on OpenCode 2.3.0); the Playwright grant is scoped to its `playwright_*` tools. These checks have not been repeated in a live OpenCode session after the current role change.

| | aria / scientist | planner | writer | scout / reviewer | researcher | visualizer |
|---|---|---|---|---|---|---|
| read, glob, grep | yes | yes | yes | yes | yes | yes |
| `.env` read | ask | ask | ask | ask | ask | ask |
| credential files (keys, `.ssh`, `.aws`, `.netrc`, auth.json…) | deny | deny | deny | deny | deny | deny |
| outside the project | read asks, write denied | read asks | read asks | read asks | read asks | read asks, write denied |
| edit/write/patch | project, except: config/authority files ask, secrets deny | `.aria/plans/*.md` only (top level) | prose files only (`md tex bib txt rst typ qmd org adoc`); never inside `.aria/ .opencode/ .claude/ .agents/ .git/ .github/ .vscode/ node_modules/` at any depth, nor `AGENTS.md`, `CLAUDE.md` or other authority files | hidden | hidden | project, except: config/authority files ask, secrets deny (same as aria) |
| shell | yes; installs, history changes, recursive deletes, containers ask; publish, deploy and sudo denied | hidden | hidden | hidden | hidden | same policy as aria (to run the app and existing checks) |
| Code Mode (`execute`) | yes | hidden | hidden | hidden | hidden | hidden |
| unknown MCP / plugin tools | ask | hidden | hidden | hidden | hidden | ask; `playwright_*` allowed |
| Zotero (zotero-mcp) | ask | hidden | hidden | hidden | reads allowed; library/index/authorization changes ask; unclassified tools hidden | hidden |
| web fetch/search | yes | no | no | scout yes, reviewer no | yes | yes |
| subagents | aria: all seven; scientist: scout, reviewer, researcher, writer | scout | researcher | none | none | none |
| scheduling, worktree creation, artifact delete | ask | hidden | hidden | hidden | hidden | hidden |

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
- Shell commands count conservatively as possible changes, not confirmed edits, because the hook cannot establish what they changed. They can make a review stale; status and sidebar wording identify shell activity explicitly.

With a plan, tasks carry `- review: required | not-required | skipped: … | pass | fail | insufficient`, which the TUI shows next to the task.

## Scratch

Each session that can write gets `.aria/scratch/<root-session>/<session>/` for throwaway files: scripts, logs, terminal captures, intermediate output, disposable fixtures. Deliverables and intentional edits go in their proper place.

- **Layout.** Single files go directly in the session directory. To group related files an agent makes an activity directory named `YYYYMMDD-HHMMSS-short-kebab-description` with plain `mkdir` (it fails if the name exists; add a suffix). Names are organisation only: ownership is decided by the two session ids, and nested paths below the session directory are allowed.
- **Creation.** It is created one directory at a time from the real project root. A symlinked `.aria` or `.aria/scratch` disables scratch rather than being followed. Session IDs are validated before being used as paths.
- **Ignored by Git.** `.aria/scratch/.gitignore` contains `*`.
- **Delivery.** For the `aria`, `scientist` and `visualizer` roles (the only ones with a shell or project edits) the absolute path is added to the system context on every model request, after the directory has been re-created if it was removed. If scratch cannot be provisioned, the context says so and forbids `/tmp` instead of naming another place. Read-only roles get no scratch and no write access. A subagent has its own directory under the same root; it cannot write its caller's, and the caller shares a file by giving the subagent its path.
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

- **Sidebar ("ARIA Plan", collapsible):** the plan you selected for this session (`[select]` or `/aria-plan`), or else the plan owned by this session, as a compact task list coloured by state (pending, in progress, executed, evidence recorded, blocked). The choice is remembered per project and session; selection mode and unavailable-selection fallback are labelled. Blocker counts stay visible even when their tasks are outside the window or the widget is collapsed. `/aria-plan-toggle` collapses or expands without a mouse. OpenCode's native sidebar shows the session/agent family; ARIA does not repeat that list or overlay it with agent-lifecycle toasts.
- **Review reminder:** one line below the header, visible even when collapsed and shown only when it matters: `◌ N changes unreviewed` / `since review` once N observed changes (default 5, set `ARIA_REVIEW_NUDGE_EDITS`) have no review, `◌ review running`, `✗ review failed · n blocking`, or `◌ review: evidence missing`. Shell activity is labelled as possible changes, not confirmed edits. A failed review stays visible during pending or inconclusive re-reviews until a subsequent review passes. Nothing is shown below the threshold or after a PASS for the current changes.
- **Plan panel:** click the plan title or use `/aria-plan-open`. It shows the selected plan as rendered Markdown (scroll, `y` copy over OSC 52, `m` raw/rendered, `f` fullscreen). Plan files are read through the OpenCode server, so this works over SSH; if that fails the local reader is used, and if nothing can be read the panel says so instead of showing stale data.
- **Updates:** plan changes appear as toasts. Blocked-task and plan-completion alerts take priority over routine updates; larger alert bursts are summarised with attention preserved. Agent lifecycle is shown in OpenCode's native sidebar; blocked tasks, finished plans, agent failures and root-session completion may produce OS notifications while the terminal is unfocused.
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
