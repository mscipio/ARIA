# Review-Driven Coding

**RDC** is an OpenCode orchestration plugin that turns OpenCode into a focused software team with explicit human plan approval before any implementation begins.

## Features

- **Conversational director** — answers questions directly; creates plans only for non-trivial implementation requests
- **Specialized roles** — explorer, visualizer, planner, architect, implementer, reviewer each with focused responsibility
- **Architect plan review** — QA before implementation: `READY` or `REVISED` with the smallest corrections needed
- **Explicit human approval** — the director summarizes the plan and **stops and waits** for the user to approve before any code is written
- **Independent reviewer verification** — compares implementation against each approved requirement as `PASS`/`FAIL`/`INSUFFICIENT EVIDENCE`
- **Autonomous remediation within approved scope** — blocking findings trigger `remediate` (preserves approval) for an implementation-fix-review loop
- **Renewed approval for material scope changes** — if review reveals work outside the approved scope, the director tasks the architect for a scope assessment, adds scope via `add` (invalidates approval), and stops for renewed approval
- **First-class MCP evidence** — every role can use CodeGraph, Context7, and Engram when they materially improve the work

## Workflow

1. At the start of every turn, the director calls `plan` action `get` to read `.code-ensemble/TASKS.md`. If an active plan exists, work continues it instead of planning again.
2. For non-trivial new work, the director tasks explorer and visualizer (when applicable) to gather the minimum necessary evidence.
3. The planner calls `plan` `get` then `create` to persist a title and an actionable, ordered task list; each task integrates its acceptance criteria and the relevant tests. The planner does not implement.
4. The architect always runs as QA of the plan: it calls `plan` `get`, and replies `READY` if the plan is correct, or `plan` `replace` (with `expectedPlanID`/`revision`) to correct it and replies `REVISED` with the changes. Any `replace` invalidates previous approval.
5. The director re-reads the plan, summarizes the title, tasks, and any architect changes to the user, and **stops and waits for explicit user approval**.
6. Only after the user approves, the director calls `plan` action `approve` to persist the approval. Tasks cannot enter implementation until the current plan revision is approved.
7. The implementer completes tasks and runs the relevant checks; the director records evidence by updating tasks.
8. The reviewer independently reads the plan via `plan` `get`, compares implementation against approved requirements, and reports `PASS`/`FAIL`/`INSUFFICIENT EVIDENCE` per requirement with `BLOCKING`/`NON-BLOCKING` findings.
9. If reviewer reports blocking findings for tasks within approved scope, the director uses `plan` action `remediate` (preserves approval) to add remediation tasks, completes them through the implementer, and re-reviews.
10. If review reveals a material scope change, the director tasks the architect for a post-review scope assessment. If the architect determines the work is outside the approved scope (`SCOPE_CHANGE`), the director adds scope via `plan` action `add` (invalidates approval), presents the amended plan, and stops for renewed approval.
11. A clean, completed plan is archived under `.code-ensemble/plans/` via `plan` action `close`.

The tasklist is scoped to the worktree, not to one OpenCode conversation. A new session can continue the same active plan without rebuilding context from scratch. Revision checks prevent two sessions from silently overwriting each other.

## Team

| Agent | Responsibility | Default model |
|---|---|---|
| director | Coordinates work and maintains the shared plan | `opencode-go/deepseek-v4-pro` |
| explorer | Maps code, tests, and dependencies | `opencode-go/deepseek-v4-flash` |
| visualizer | Interprets screenshots and diagrams | `opencode-go/kimi-k2.7-code` |
| planner | Persists executable plans with integrated acceptance/tests | `openai/gpt-5.6-terra` |
| architect | QA of the plan: READY or REVISED before implementation; post-review scope assessment | `openai/gpt-5.6-sol` |
| implementer | Edits code and runs relevant checks | `opencode-go/glm-5.2` |
| reviewer | Finds regressions, risks, and missing verification | `opencode-go/deepseek-v4-pro` |

Only implementer can use OpenCode's edit tool for application code. Implementer shell commands run without permission prompts, except destructive removal and package publishing commands, which remain blocked. Reviewer has unrestricted shell access for inspection and verification; director cannot edit or run shell commands.

Every specialist runs through OpenCode's native `task` tool, so planner and architect appear in the UI like any other subagent.

## Shared Plan

`.code-ensemble/TASKS.md` is the project-wide source of truth. RDC retains the inherited `.code-ensemble/` on-disk namespace for compatibility with its plan format; a future schema migration may rename this independently.

Schema v3 fields:

- `version`: schema version (`3`)
- `id`: stable Plan ID (UUID) identifying this plan across sessions
- `revision`: integer incremented on every mutation; callers pass the current Plan ID and revision to detect conflicts
- `status`: `active` or `closed`
- `approval`: `pending` or `approved` — a plan must be `approved` before tasks can enter implementation
- `title`, `createdAt`, `updatedAt`: plan metadata
- `tasks[]`: ordered tasks with stable `id` (e.g. `T001`), `text` (action plus integrated acceptance/tests), `status` (`pending`/`in_progress`/`completed`/`blocked`), and optional `evidence`

Approval lifecycle:
- `create` produces a plan with `approval: pending`
- `approve` (director only) sets `approval: approved` and increments revision
- `replace` (architect only) resets `approval: pending` (invalidates any previous approval)
- `add` (director only) resets `approval: pending` (scope changes require re-approval)
- `remediate` (director only) preserves `approval: approved` (autonomous remediation loop)
- `update`, `close` require `approval: approved`

```md
<!-- code-ensemble-plan
{"version":3,"id":"7e3f1a92-...","revision":4,"status":"active","approval":"approved","title":"Dashboard","createdAt":"2026-07-20T12:00:00.000Z","updatedAt":"2026-07-20T12:05:00.000Z","tasks":[{"id":"T001","text":"Define the data model; schema tests pass","status":"completed","evidence":"schema tests pass"},{"id":"T002","text":"Implement the dashboard; renders without errors","status":"in_progress"},{"id":"T003","text":"Review responsive behavior; no layout regressions at common breakpoints","status":"pending"}]}
-->

# Plan: Dashboard

Status: **active**
Approval: **approved**
Revision: **4**

## Tasks

- [x] **T001** Define the data model; schema tests pass
  - Evidence: schema tests pass
- [~] **T002** Implement the dashboard; renders without errors
- [ ] **T003** Review responsive behavior; no layout regressions at common breakpoints
```

## Plan Tool ACL

Only the `director`, planning specialists, and reviewer can call `plan`; every other agent has `plan: deny`.

| Agent | Allowed `plan` actions |
|---|---|
| director | `get`, `create`, `update`, `add`, `remediate`, `approve`, `close` |
| planner | `get`, `create` |
| architect | `get`, `replace` |
| reviewer | `get` |
| explorer | none |
| visualizer | none |
| implementer | none |

- `get` returns the active plan (or `No active plan.`).
- `create` writes a new plan with `approval: pending` and returns the initial `revision` (`1`); rejected when an active plan already exists.
- `approve` accepts the current `expectedPlanID` and `expectedRevision`, sets `approval: approved`, and increments the revision. Only the director may approve.
- `replace` accepts the current `expectedPlanID` and `expectedRevision` plus the corrected `title` and `tasks`, produces a new revision, and resets `approval: pending`. Used only by the architect before implementation starts.
- `update`, `add`, `remediate`, and `close` require both `expectedPlanID` and `expectedRevision` to detect conflicts.
- `update` requires `approval: approved`.
- `add` resets `approval: pending` (scope changes require renewed approval).
- `remediate` requires `approval: approved` and all existing tasks completed; preserves `approval: approved` (autonomous remediation loop).
- `close` requires `approval: approved` and all tasks completed; archives the plan.

The director is the only agent allowed to approve, update plan status, add remediation tasks, and archive. OpenCode todos may mirror current progress in the UI, but the Markdown file remains the durable source of truth.

## Plan Ownership

- **Planner** owns plan creation: it turns evidence into an actionable, ordered task list with integrated acceptance/tests and persists it with `create`.
- **Architect** owns plan correctness: it reviews the planner's plan with `get`, and either accepts it (`READY`) or corrects it with `replace` (`REVISED` + changes). Replace invalidates any previous approval. After review, the architect performs scope assessment: `SCOPE_CHANGE` or `WITHIN_SCOPE`.
- **Director** owns plan lifecycle: it re-reads the plan after the architect, summarizes to the user, waits for explicit approval, then drives implementation through implementer/reviewer, records evidence with `update`, adds remediation with `remediate`, adds scope changes with `add` (requiring re-approval), and archives completed work with `close`.
- **Reviewer** independently reads the plan via `get` and evaluates each approved requirement against the actual implementation as `PASS`, `FAIL`, or `INSUFFICIENT EVIDENCE`.

## Install

```sh
git clone https://github.com/mscipio/review-driven-code.git
cd review-driven-code
npm ci --omit=dev
node ./bin/rdc.mjs setup
node ./bin/rdc.mjs doctor
```

The `node ./bin/rdc.mjs` form works from the cloned checkout without requiring the package bin to be on `PATH`. If you have installed RDC globally or linked it, the shorter `rdc setup` / `rdc doctor` forms are equivalent.

Restart OpenCode after setup to load the registered plugin.

## Configuration

RDC resolves role model and variant overrides from two optional JSON files sharing the same schema. RDC reads both files but never writes them — create them manually.

| File | Path | Scope |
|------|------|-------|
| Global | `~/.config/opencode/review-driven-code.json` | Per-user, applies to every project |
| Project | `review-driven-code.json` in the worktree root (or an explicit path via the plugin `configPath` option) | Per-project |

```json
{
  "roles": {
    "planner": { "model": "openai/gpt-5.6-terra", "variant": "xhigh" },
    "architect": { "model": "openai/gpt-5.6-sol" },
    "explorer": { "variant": "xhigh" }
  }
}
```

Every model identifier must use `provider/model` format. Variant is optional.

### Per-field resolution

For each role and field (`model`, `variant`), the first defined value wins:

1. **Project** override
2. **Global** override
3. **Built-in default**

Missing a field at one level inherits the value from the level below — there is no merging or blocking between levels. Setting only `variant` at the project level leaves the `model` to be resolved from global or defaults independently.

## Required Integrations

RDC requires three external integrations. RDC does not fork, vendor, or duplicate their internal implementation — updates track their latest stable upstream releases and services.

| Integration | Purpose | Upstream |
|---|---|---|
| [Engram](https://github.com/Gentleman-Programming/engram) | Durable semantic/project memory | `engram setup opencode` |
| [Context7](https://github.com/upstash/context7) | Current external library, framework, and API documentation | Remote MCP endpoint |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Codebase intelligence for structure and impact | `@colbymchenry/codegraph` |

### Commands

```bash
rdc setup      # Register RDC plugin with OpenCode and synchronize dependencies
rdc update     # Pull latest changes, reinstall, and re-sync dependencies
rdc deps sync  # Synchronize required integrations (Engram, Context7, CodeGraph)
rdc doctor     # Report status of required integrations (read-only)
rdc routes     # Print resolved model routes for each RDC role
```

### `rdc setup`

Registers the RDC plugin globally with OpenCode and runs the idempotent dependency sync. Setup uses OpenCode CLI introspection when available to check whether the plugin is already registered:

- **First run**: registers the plugin, then synchronizes all dependencies.
- **Repeated runs**: reports `already registered`, skips duplicate global registration, and still runs the dependency sync (which is itself idempotent).
- **Compatibility fallback**: when introspection is unavailable or returns an unrecognized format, setup attempts registration and treats a non-zero exit only as `already registered` when the output explicitly indicates a duplicate entry. Every other registration error is treated as a failure and blocks dependency sync.

Setup fails non-zero at the labeled stage (registration or sync). OpenCode must be restarted after setup to load the registered plugin.

Setup never creates or overwrites project `review-driven-code.json`, commits, pushes, or introduces postinstall, daemon, or background behavior.

### `rdc update`

Pulls the latest changes from the upstream Git repository, reinstalls production dependencies, and hands off dependency synchronization to the updated checkout in a fresh process.

```bash
# From the cloned checkout:
node ./bin/rdc.mjs update
node ./bin/rdc.mjs doctor
```

The update workflow requires:

- A clean Git working tree (no uncommitted changes or untracked files)
- A configured upstream remote
- Fast-forward-only merge (`git pull --ff-only`)

After `git pull --ff-only` and `npm ci --omit=dev` succeed, update spawns `node <checkout>/bin/rdc.mjs deps sync` in a new process using the updated checkout's code. The subprocess exit status and captured diagnostic output are reported. If any stage fails, update returns non-zero at the labeled stage and skips downstream stages.

OpenCode must be restarted after update to load the changed code.

Neither `rdc setup` nor `rdc update` runs as a postinstall script, daemon, background task, or automatic update. Both are manual commands. Neither creates or overwrites project `review-driven-code.json`, creates commits, or pushes.

### `rdc deps sync`

Synchronizes each integration using its upstream-supported mechanism, then reconciles OpenCode MCP configuration. This is the same dependency sync invoked by `rdc setup` and the post-update handoff.

### `rdc doctor`

Read-only status report. Checks that OpenCode, Engram, Context7, and CodeGraph are present and their MCP connections are active. Returns non-zero if any required integration is missing or disconnected.

### `rdc routes`

Prints the resolved model (and optional variant) for every RDC role, following the defaults → global → project precedence: each field resolves from the first defined value at the project, then global, then built-in default level. If any configuration file is invalid the command fails with a non-zero exit code.

```
Resolved RDC role routes:
director  opencode-go/deepseek-v4-pro
explorer  opencode-go/deepseek-v4-flash (high)
visualizer  opencode-go/kimi-k2.7-code
planner  openai/gpt-5.6-terra (xhigh)
architect  openai/gpt-5.6-sol (xhigh)
implementer  opencode-go/glm-5.2
reviewer  opencode-go/deepseek-v4-pro
```

MCPs are preferred evidence sources, not mandatory routes for every task. Engram is durable project memory, not transactional workflow state. `.code-ensemble/TASKS.md` and the native Plan tool remain authoritative for active plan, task, scope, and approval state.

## Wiki Compiler

`wiki-compiler` is a separate, opt-in specialist for wiki operations. The director delegates to it only when the user explicitly requests Wiki lookup, archival, or curated compilation. It never runs automatically.

### Modes

- **Lookup** (read-only) — searches the curated wiki via `wiki-pipeline/search.py` against `WIKI_DIR/wiki/index.json`. No writes, no pipeline initialization, no archival, and no mandatory primer access. An existing primer may be consulted read-only when useful.
- **Archival** (write, explicit request only) — archives raw session or observation data to `WIKI_DIR/raw/` as immutable provenance files. Three commands: `archive-opencode` (OpenCode sessions), `archive-engram` (Engram observations), and `archive-all` (both). Archival does not compile, promote raw material, or regenerate the primer; it only writes raw files and updates archive trackers.
- **Compile / Update** (write, explicit request only) — promotes raw files into curated wiki pages following the manual compilation protocol (`wiki-pipeline/docs/compile-workflow.md`). For each candidate raw file the specialist inspects existing pages, deduplicates, and decides create/update/skip. Updates merge new information while preserving existing content and source provenance, then regenerate `wiki/index.md`, `wiki/index.json`, and append to `wiki/log.md`. An optional primer refresh and lint pass may follow.

Ordinary lookup and compile/update do not archive automatically. Archival occurs only when the user explicitly requests it. There is no CLI command for compilation — compilation is a specialist-led manual workflow, not an automated process.

### Configuration

`WIKI_DIR` is the sole external wiki path, required to locate the Wiki. It must be set to a non-empty value before any wiki operation — write-capable (archival, compile, primer generation) and read-only search alike. When `WIKI_DIR` is absent, write work fails with a clear error before creating any file or directory, and read-only search returns a clear no-write configuration error.

RDC ships and resolves its own pipeline, search, and documentation assets from the package root under `wiki-pipeline/`. Pipeline assets are published with the package as listed in `package.json`. The director receives no wiki filesystem paths or package paths — only the `wiki-compiler` specialist does.

### Engram-to-Wiki boundary

Engram-to-Wiki is not an automatic bridge. Engram archival is an explicit user-requested operation. Archived Engram observations remain immutable raw provenance files under `WIKI_DIR/raw/`. Promotion from raw to curated wiki pages is explicit and passes the specialist's deduplicate/create/update/skip curation gate. Engram remains distinct from curated wiki knowledge and from RDC Plan workflow state.

### Out of scope

The wiki-compiler does not reference, require, or support:

- `REPO_DIR` or workspace-relative configuration
- `myopencode` runtime dependency, modification, or deletion — myopencode is treated as a source-only upstream
- Automatic wiki, archive, or primer behavior — every operation is explicit
- Zotero, biblio, research, writing, or Phase 3 / wiki-bridge workflows
- Root or plugin-local skill packages, global skill installation, setup lifecycle changes, symlinks, or new skill-source configuration
- Refactors unrelated to wiki integration

## Development

```sh
npm run typecheck
npm test
npm run lint
npm run build
npm run smoke:package
```

## Acknowledgement

Review-Driven Coding is derived from [cgize/code-ensemble](https://github.com/cgize/code-ensemble) and retains its MIT license.

## License

MIT
