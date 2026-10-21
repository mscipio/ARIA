# ARIA v1.3.2 — Native OpenCode 2

**ARIA** — **A**rchival, **R**esearch, **I**mplementation, and **A**uthoring — is a multi-role OpenCode workstation. Its `coder` implements Review-Driven Coding (RDC), while `scientist`, `writer`, `archivist`, and `researcher` own scientific specification and interpretation, writing, knowledge, and evidence-research workflows.

## Features

- **Conversational coder** — answers questions directly; creates plans only for non-trivial implementation requests
- **Specialized roles** — coding specialists plus opt-in Wiki, scientific/professional writing, and scientific-authority specialists, each with focused authority
- **Architect plan review** — QA before implementation: `READY` or `REVISED` with the smallest corrections needed
- **Explicit human approval** — the coder summarizes the plan and **stops and waits** for the user to approve before any code is written
- **Independent reviewer verification** — compares implementation against each approved requirement as `PASS`/`FAIL`/`INSUFFICIENT EVIDENCE`
- **Optional adversarial review** — after normal review passes, the reviewer may run a second adversarial pass that attacks plausible counterexamples, hidden assumptions, and hostile edge/error/security/ordering paths; risk-based invocation, not universal
- **Autonomous remediation within approved scope** — blocking findings trigger `remediate` (preserves approval) for an implementation-fix-review loop
- **Renewed approval for material scope changes** — if review reveals work outside the approved scope, the coder tasks the architect for a scope assessment, adds scope via `add` (invalidates approval), and stops for renewed approval
- **First-class MCP evidence** — coder and coding specialists can use CodeGraph, Context7, and Engram when they materially improve the work; Wiki, writer, and scientist remain intentionally isolated
- **Evidence-bounded researcher** — `mode: all` literature specialist with direct ZotPilot library research tools, approval-gated Zotero mutation, explicit evidence-level/uncertainty reporting, claim-level citation verification of source identity and claim-source support, and chat-first tutoring/guided reading of an identified library paper
- **Bounded scientist authority** — `mode: all` scientific authority for question specification, methodology, and result interpretation, with deny-by-default code/shell/MCP/evidence/persistence authority; delegates evidence to `researcher`, prose to `writer`, and computation to `coder`

## Workflow

1. At the start of every turn, the coder calls `plan` action `get` to read `.aria/rdc/TASKS.md`. If an active plan exists, work continues it instead of planning again.
2. For non-trivial new work, the coder tasks explorer and visualizer (when applicable) to gather the minimum necessary evidence.
3. The planner calls `plan` `get` then `create` to persist a title and an actionable, ordered task list; each task integrates its acceptance criteria and the relevant tests. The planner does not implement.
4. The architect always runs as QA of the plan: it calls `plan` `get`, and replies `READY` if the plan is correct, or `plan` `replace` (with `expectedPlanID`/`revision`) to correct it and replies `REVISED` with the changes. Any `replace` invalidates previous approval.
5. The coder re-reads the plan, summarizes the title, tasks, and any architect changes to the user, and **stops and waits for explicit user approval**.
6. Only after the user approves, the coder calls `plan` action `approve` to persist the approval. Tasks cannot enter implementation until the current plan revision is approved.
7. The implementer completes tasks and runs the relevant checks; the coder records evidence by updating tasks.
8. The reviewer independently reads the plan via `plan` `get`, compares implementation against approved requirements, and reports `PASS`/`FAIL`/`INSUFFICIENT EVIDENCE` per requirement with `BLOCKING`/`NON-BLOCKING` findings.
9. If reviewer reports blocking findings for tasks within approved scope, the coder uses `plan` action `remediate` (preserves approval) to add remediation tasks, completes them through the implementer, and re-reviews. After any substantive adversarial-origin fix, normal review runs again before adversarial re-review.
10. Optionally, after normal review passes, the coder may invoke adversarial review based on risk signals (permissions, mutation, security, migration, concurrency, public API, architecture). Adversarial review attacks the apparently correct implementation and follows the same remediation/re-review cycle. Both normal and adversarial review must pass after the last substantive change.
11. If review reveals a material scope change, the coder tasks the architect for a post-review scope assessment. If the architect determines the work is outside the approved scope (`SCOPE_CHANGE`), the coder adds scope via `plan` action `add` (invalidates approval), presents the amended plan, and stops for renewed approval.
12. A clean, completed plan is archived under `.aria/rdc/plans/` via `plan` action `close`.

The shared plan (`.aria/rdc/TASKS.md`) is scoped to the OpenCode workspace directory, not to one OpenCode conversation. A new session can continue the same active plan without rebuilding context from scratch. Revision checks prevent two sessions from silently overwriting each other.

## Team

| Agent | Responsibility | Default model | Strength |
|---|---|---|---|
| coder (`all`) | Coordinates work and maintains the shared plan | `opencode-go/muse-spark-1.3-contributor` | `xhigh` |
| explorer | Maps code, tests, and dependencies | `opencode-go/muse-spark-1.3-contributor` | `high` |
| visualizer | Interprets screenshots and diagrams | `opencode-go/muse-spark-1.3-contributor` | `xhigh` |
| planner | Persists executable plans with integrated acceptance/tests | `openai/gpt-6-luna` | `xhigh` |
| architect | QA of the plan: READY or REVISED before implementation; post-review scope assessment | `openai/gpt-6.1-sol` | `high` |
| implementer | Edits code and runs relevant checks | `opencode-go/muse-spark-1.3-contributor` | `xhigh` |
| reviewer | Finds regressions, risks, and missing verification | `openai/gpt-6.1-sol` | `medium` |
| researcher (`all`) | Direct or delegated external literature and evidence research | `openai/gpt-6.1-sol` | `medium` |
| archivist (`all`) | Direct or delegated Wiki lookup, archival, and curated compilation | `opencode-go/muse-spark-1.3-contributor` | `high` |
| writer (`all`) | Owns scientific/academic and professional writing objectives; can request read-only Wiki evidence | `openai/gpt-6-luna` | `xhigh` |
| scientist (`all`) | Scientific authority: question specification, methodology design, and result interpretation | `openai/gpt-6.1-sol` | `medium` |

Only implementer and visualizer can use OpenCode's edit tool for application code, with identical effective edit/shell decisions (T003 parity): both allow ordinary development shell commands and gate protected `.env` files, except destructive removal and package publishing commands, which remain blocked. Workspace/scratch instructions confine transient/generated artifacts, not intentional authorized repo edits; scratch artifacts are never staged, and staging authorized source changes requires human-authorized Git operations (editing alone is not authorization). RDC approvals remain required but are not OS-level sandbox enforcement: the Unix account can still write outside those locations, and confinement is enforced only where ARIA controls paths/environment. Reviewer has unrestricted shell access for inspection and verification; coder cannot edit or run shell commands.

The six RDC coding specialists — explorer, visualizer, planner, architect, implementer, reviewer — run through OpenCode's native `task` tool. The five durable roles — `coder`, `researcher`, `archivist`, `writer`, and `scientist` — run with OpenCode `mode: all` and are available both directly and through `task`. The coder may task `researcher` for external evidence questions; the writer tasks it for focused literature, Zotero, citation-verification, or claim-support evidence (evidence only, never manuscript prose). Mode availability is not authority: every role's tools are deny-by-default except what is explicitly granted, and `scientist` in particular has no unrestricted code, shell, MCP, evidence, or persistence authority.

## Agent and Skill Architecture

ARIA separates **role authority** from **task methodology**:

- **Agent prompts** define identity, authority, delegation, hard boundaries, and required output contracts.
- **Package-owned skills** (`rdc-*` for coding methodology, `aria-*` for broader ARIA capabilities) contain task-specific procedures and reusable expertise, loaded on demand through OpenCode's native `skill` tool.
- **Tool permissions** enforce what each role can actually read, edit, execute, delegate, or load.
- **Persisted state** (the Plan and curated Wiki) remains authoritative independently of prompts or skills.

Examples:

- explorer → `rdc-code-exploration`
- planner → `rdc-implementation-planning` + `rdc-testing-discipline`
- architect → `rdc-plan-review` or `rdc-scope-assessment`
- implementer → `rdc-code-implementation` + proportional testing guidance
- reviewer → `rdc-implementation-review` + `rdc-adversarial-review` (optional, after normal PASS) + proportional testing guidance
- archivist → `aria-wiki-lookup`, `aria-wiki-archive`, or `aria-wiki-compile`
- writer → `aria-document-design`, `aria-academic-writing`, `aria-writing-anti-ai`, `aria-review-response`, and `aria-paper-self-review` as needed
- researcher → `aria-research-evidence` (discovery/verification) or `aria-zotero-tutor` (tutoring an identified paper)
- scientist → `aria-research-planning` or `aria-results-analysis`

ARIA reserves `aria-*` for package-wide capabilities and retains `rdc-*` specifically for Review-Driven Coding skills. The plugin registers its packaged `skills/` directory through OpenCode's native `skills.paths` configuration, appending it to any pre-existing paths (append-and-preserve), so skills stay version-locked to the loaded ARIA package without copying files into the user's global skill directory or depending on myopencode/another registry.

## Shared Plan

`.aria/rdc/TASKS.md` is the project-wide source of truth for the coder workflow, following the OpenCode workspace/session directory rather than the Git worktree or a single OpenCode conversation. On first Plan access, a legacy `.code-ensemble/` state directory is migrated once to `.aria/rdc/` when the canonical destination does not already exist.

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
- `approve` (coder only) sets `approval: approved` and increments revision
- `replace` (architect only) resets `approval: pending` (invalidates any previous approval)
- `add` (coder only) resets `approval: pending` (scope changes require re-approval)
- `remediate` (coder only) preserves `approval: approved` (autonomous remediation loop)
- `update`, `close` require `approval: approved`

```md
<!-- aria-rdc-plan
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

Only the `coder`, planning specialists, and reviewer can call `plan`; every other agent has `plan: deny`.

| Agent | Allowed `plan` actions |
|---|---|
| coder | `get`, `create`, `update`, `add`, `remediate`, `approve`, `close` |
| planner | `get`, `create` |
| architect | `get`, `replace` |
| reviewer | `get` |
| researcher | none |
| explorer | none |
| visualizer | none |
| implementer | none |
| scientist | none |

- `get` returns the active plan (or `No active plan.`).
- `create` writes a new plan with `approval: pending` and returns the initial `revision` (`1`); rejected when an active plan already exists.
- `approve` accepts the current `expectedPlanID` and `expectedRevision`, sets `approval: approved`, and increments the revision. Only the coder may approve.
- `replace` accepts the current `expectedPlanID` and `expectedRevision` plus the corrected `title` and `tasks`, produces a new revision, and resets `approval: pending`. Used only by the architect before implementation starts.
- `update`, `add`, `remediate`, and `close` require both `expectedPlanID` and `expectedRevision` to detect conflicts.
- `update` requires `approval: approved`.
- `add` resets `approval: pending` (scope changes require renewed approval).
- `remediate` requires `approval: approved` and all existing tasks completed; preserves `approval: approved` (autonomous remediation loop).
- `close` requires `approval: approved` and all tasks completed; archives the plan.

The coder is the only agent allowed to approve, update plan status, add remediation tasks, and archive. OpenCode todos may mirror current progress in the UI, but the Markdown file remains the durable source of truth.

## Plan Ownership

- **Planner** owns plan creation: it turns evidence into an actionable, ordered task list with integrated acceptance/tests and persists it with `create`.
- **Architect** owns plan correctness: it reviews the planner's plan with `get`, and either accepts it (`READY`) or corrects it with `replace` (`REVISED` + changes). Replace invalidates any previous approval. After review, the architect performs scope assessment: `SCOPE_CHANGE` or `WITHIN_SCOPE`.
- **Coder** owns plan lifecycle: it re-reads the plan after the architect, summarizes to the user, waits for explicit approval, then drives implementation through implementer/reviewer, records evidence with `update`, adds remediation with `remediate`, adds scope changes with `add` (requiring re-approval), and archives completed work with `close`.
- **Reviewer** independently reads the plan via `get` and evaluates each approved requirement against the actual implementation as `PASS`, `FAIL`, or `INSUFFICIENT EVIDENCE`.

## Workspace execution policy

Canonical source: `src/scratch.ts` via `src/paths.ts` guards. Confine transient/generated artifacts (logs, fixtures, temporary outputs, verification evidence, etc.) to `<worktree>/scratch/` (per-task noncolliding subdirs, single `/scratch/` gitignore, task-scoped env/helper with explicit output paths); this does not restrict intentional edits to authorized repository code, tests, configuration, or documentation. Never stage scratch artifacts. Staging explicitly approved source changes is permitted only during human-authorized Git operations; editing does not itself authorize staging. `HOME`/`XDG`/global config preserved; atomic sibling-tmp/file-lock preserved; no OS-sandbox promise (approvals remain required). External tools that cannot accept explicit paths are documented exceptions in the canonical header. See `src/scratch.ts` for the full fail-closed policy.

## Install

Canonical install is the released global package `github:mscipio/ARIA#v1.3.2`:

```sh
NPM_CONFIG_ALLOW_GIT=all npm install -g 'github:mscipio/ARIA#v1.3.2'
aria setup
aria doctor
```

Bare `aria` is the globally installed released package: it runs that install's own assets and never infers or requires a development checkout. From a development checkout, run the local CLI explicitly (`node ./bin/aria.mjs ...`); `npm link` is not a supported workflow.

`NPM_CONFIG_ALLOW_GIT=all` is process-local to that install invocation only — no global `npm config` change, no environment export, and no `.npmrc` edit. A bare install without it fails with `EALLOWGIT` on Git specs.

Restart OpenCode after setup to load the registered plugin.

Tags before v1.1.0 predate the current v1.1.x line and are retained unchanged.

## Configuration

ARIA resolves role model and variant overrides from two optional JSON files sharing the same schema. Project `aria.json` is read-only; the global file may be created manually or written interactively by `aria models --config` (see below).

| File | Path | Scope |
|------|------|-------|
| Global | `~/.config/opencode/aria.json` | Per-user, applies to every project |
| Project | `aria.json` in the worktree root (or an explicit path via the plugin `configPath` option) | Per-project |

For transition compatibility, ARIA still reads the legacy `~/.config/opencode/review-driven-code.json` and project `review-driven-code.json` filenames when the corresponding `aria.json` file is absent. Legacy filenames are read-only fallbacks and are never written or migrated. `aria.json` is canonical and wins when both names exist; `aria models --config` writes only the canonical global `~/.config/opencode/aria.json`.

```json
{
  "roles": {
    "planner": { "model": "openai/gpt-6-luna", "variant": "xhigh" },
    "architect": { "model": "openai/gpt-6.1-sol" },
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

ARIA currently requires three external integrations. ARIA does not fork, vendor, or duplicate their internal implementation — updates track their latest stable upstream releases and services.

| Integration | Purpose | Upstream |
|---|---|---|
| [Engram](https://github.com/Gentleman-Programming/engram) | Durable semantic/project memory | `engram setup opencode` |
| [Context7](https://github.com/upstash/context7) | Current external library, framework, and API documentation | Remote MCP endpoint |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Codebase intelligence for structure and impact | `@colbymchenry/codegraph` |

### Quota 5 (optional, safety-gated)

OpenCode Quota 5 is optional: the setup bootstrap lifecycle installs it only when positively absent (install-missing-only with validation and rollback where feasible; setup never upgrades present installs). Ambiguous, observed, or unsupported targets stay observed-but-unmanaged with zero mutation — setup leaves present installs untouched. `aria deps` remains a read-only inventory and does not independently chase or install Quota (`SyncResult` carries no quota field). Quota is therefore absent from the required-dependency plan above. A Quota 5 version upgrade belongs exclusively to `aria deps --upgrade` and proceeds only when its installed npm target is positively identified as Quota 5 and the native update preview demonstrates a safe change that preserves the TUI and server surfaces, with validation and rollback where feasible; any unknown or unsafe target stays observed-but-unmanaged with zero mutation.

### Commands

Public CLI surface (see `aria --help`):

```bash
aria setup                # Register ARIA with OpenCode; install missing dependencies (idempotent; never upgrades present deps)
aria doctor               # Read-only health check of ARIA (package, config, routes/models, integrations, skills, ZotPilot, Wiki)
aria upgrade              # Show upgrade inventory without mutation (requires --yes to apply; ARIA-only)
aria upgrade --check      # Read-only upgrade inventory (current + available releases, component table)
aria upgrade --yes        # Approve and run the ARIA-only upgrade pipeline
aria models               # Print resolved model routes for each ARIA role (compact role/model/effort table)
aria models --config      # Interactively configure ARIA role models (the v1.1.x configuration surface)
aria deps                 # Read-only dependency inventory (plugins/MCPs with observed versions)
aria deps --upgrade       # Check and propose managed dependency upgrades (zero mutation; re-run with --yes to apply)
aria deps --upgrade --yes # Apply managed upgrades (unknown/unmanaged stay report-only)
aria --help               # Show help
aria --version            # Show version
```

Retired commands are rejected with guidance and are not supported: `aria configure` → `aria models --config`; `aria routes` → `aria models`; `aria update` → `aria upgrade` (ARIA release moves) or `aria setup` (install missing dependencies); `aria deps sync` → `aria deps` (read-only inventory), `aria deps --upgrade` (managed upgrades), or `aria setup` (install missing). The v1.1.x public configuration surface is `aria models` / `aria models --config`.

### `aria setup`

First install and bootstrap: registers the ARIA plugin globally with OpenCode, then idempotently reconciles registration, global configuration, managed agent files, and packaged skills. It installs required managed dependencies only when missing and never version-chases present ones — upgrades belong to `aria deps --upgrade`. Package-owned skills are discovered directly from the loaded package through `skills.paths`. Setup uses OpenCode CLI introspection when available to check whether the plugin is already registered:

- **First run**: registers the plugin, then installs missing dependencies.
- **Repeated runs**: reports `already registered`, skips duplicate global registration, and still reconciles configuration/agents/skills and installs anything missing (itself idempotent) — without upgrading anything already present.
- **Compatibility fallback**: when introspection is unavailable or returns an unrecognized format, setup attempts registration and treats a non-zero exit only as `already registered` when the output explicitly indicates a duplicate entry. Every other registration error is treated as a failure and blocks the dependency install.

Setup fails non-zero at the labeled stage (registration or dependency install). OpenCode must be restarted after setup to load the registered plugin.

Setup never creates or overwrites project `aria.json`, commits, pushes, or introduces postinstall, daemon, or background behavior. `aria setup` also accepts `--plugin-spec <spec>` (see `aria --help`) to register a Git package specifier instead of the local checkout; it is not part of the normal install flow.

### `aria models --config`

`aria models --config` is the v1.1.x public configuration surface: an interactive role-model configuration pass with no plugin registration and no dependency install. It discovers the models the installed `opencode` CLI reports (`opencode models`, plus `opencode models --verbose` for names and variants) once per run and shows the eleven configurable roles (`coder`, `explorer`, `visualizer`, `planner`, `architect`, `implementer`, `reviewer`, `researcher`, `archivist`, `writer`, `scientist`) with each role's four-layer precedence: packaged default, global override, project override, and resolved route. A resolved model the CLI did not list is annotated `[not listed by OpenCode]`; the annotation is purely diagnostic — no fallback routing or automatic replacement is added.

From the top-level menu you may:

- **Keep current configuration** — writes nothing; existing overrides are preserved exactly.
- **Configure roles** — pick roles from a comma-separated list, then for each role keep the current assignment (Enter), reset to the ARIA default (`0`), type an exact model identifier, or search discovered models by case-insensitive substring. A search listing at most ten models offers numbered selection; larger result sets ask you to refine the search.

Choosing a model replaces the role's global `model` field, then a compact variant prompt offers the model's reported variants (`Enter` for no variant, a number to select one), so a stale variant cannot survive a model change. Resetting a role to the ARIA default removes that role's global `model` and `variant` fields rather than writing sentinel or copied values. Only the canonical global `~/.config/opencode/aria.json` is written, atomically, after creating its parent directory. When the canonical file is absent, existing legacy-global choices seed the result only if you make an explicit edit, and no canonical file is created for an unchanged or default-only result when none existed. Project-local `aria.json` files are never written; when a project override masks a global edit, the result reports it and points to `aria models` as the authoritative resolved-routing view. When stdin is not a terminal, the configuration pass is skipped without failure.

`configured`, `unchanged`, and non-TTY `skipped` outcomes exit `0`; discovery/write failures and thrown errors report `Model configuration: [FAIL]` and exit nonzero. Like `setup`, it never writes project-local `aria.json`.

### Retired: `aria update`

`aria update` (checkout pull, reinstall, and re-sync) is retired. To move ARIA itself to a new release use `aria upgrade --yes`; to install missing dependencies use `aria setup`. There is no checkout-based update workflow.

Neither `aria setup` nor any retired command runs as a postinstall script, daemon, background task, or automatic update. Setup is manual. Setup never creates or overwrites project `aria.json`, creates commits, or pushes.

### `aria upgrade`

`aria upgrade` moves ARIA itself to a new release: the global CLI, registration, managed agents, and ARIA-owned config/skills. It does not upgrade third-party dependencies — version upgrades belong exclusively to `aria deps --upgrade`.

- `aria upgrade --check` — strictly read-only: current and available ARIA releases plus a Component|Installed|Available|Status table. Never installs, writes, or repairs.
- `aria upgrade` (bare) — shows the same inventory without mutation, then stops: explicit `--yes` approval is required before any change is applied.
- `aria upgrade --yes` — approves the inventoried ARIA-only target and runs the upgrade pipeline. After approval the exact target is validated before the current registration is touched; unrelated entries are preserved; everything stays XDG-contained with no `.npmrc` side effects, and any git allowlist (`NPM_CONFIG_ALLOW_GIT=all`) is process-local only.

### `aria deps`

Read-only inventory first, explicitly approved upgrades second — a two-step with no interactive prompt:

- `aria deps` — read-only inventory/status of managed plugins/MCPs (installed and available versions with per-component status). No changes are made.
- `aria deps --upgrade` — checks eligible updates and prints a proposal with zero mutation (exits nonzero to signal nothing was applied). Re-run as `aria deps --upgrade --yes` to apply managed upgrades; unknown/unmanaged targets stay report-only either way.
- Missing dependencies remain `aria setup`'s responsibility, not an upgrade step.

### `aria doctor`

Read-only health check. It inspects — and never writes, installs, or repairs — the packaged assets, configuration, resolved role routes, model discovery, required integrations, packaged skills, and the optional ZotPilot and Wiki capabilities. Every finding is labeled with one of four literal severities:

- **PASS** — the check succeeded.
- **FAIL** — a required item is missing, invalid, or disconnected. Any FAIL makes `aria doctor` exit **1**.
- **WARN** — a non-fatal degradation of an optional capability (ZotPilot CLI or MCP, unverifiable variant metadata, or a shallow effective `subagent_depth`). WARN never changes the exit code.
- **SKIP** — a check that does not apply to the current environment (for example, `WIKI_DIR` unset, or the standalone live-tool-inventory comparison).

Exit code is **0 if and only if no finding is FAIL**, otherwise **1**.

Required checks (FAIL when broken): package `package.json` version, packaged defaults and each defaults-referenced prompt, role route resolution (invalid global or project config), model discovery, every resolved role route against the models `opencode models` lists (with configured variants verified only against observable variant metadata — a variant whose metadata is not observable is WARN, never guessed), the OpenCode/Engram/Context7/CodeGraph integrations, packaged skills (matching `name` and `metadata.owner: aria`), canonical role requirements, and the packaged Wiki pipeline assets. A configured `WIKI_DIR` that does not exist, is not a directory, or lacks read/write accessibility is FAIL; an unset `WIKI_DIR` is SKIP.

One config-area finding evaluates the effective cooperation surface, provenance-neutrally: `aria doctor` reads the effective merged top-level `subagent_depth` reported by a read-only `opencode debug config` probe. An absent field is PASS, stating that ARIA supplies the runtime default/recommendation 3; a finite numeric value >= 3 is PASS, reporting the effective value as sufficient for nested ARIA cooperation; a finite numeric value < 3 is a nonfatal WARN, reporting the effective value and that nested ARIA cooperation may be degraded. Unavailable command/output or malformed JSON/value is handled as a nonfatal WARN. This advisory never FAILs, never writes configuration, and never attributes the value to user configuration or ARIA.

ZotPilot is reported as two clearly separate findings:

- **ZotPilot CLI** — availability and version from the smallest read-only probe (`zotpilot --version`). PASS when identified; WARN when the executable is missing or the probe is nonzero or unparseable, because ZotPilot MCP may still work.
- **ZotPilot MCP** — server presence/connectivity from a fresh standalone `opencode mcp list` CLI observation (not live-session inventory). Connected is PASS; absent, disconnected, or unknown is WARN.

A dedicated SKIP finding states the standalone limitation: `aria doctor` cannot compare expected/present/missing/unexpected live ZotPilot tool IDs or OpenCode session permissions, because no safe supported `tools/list` mechanism exists — it validates the packaged ZotPilot policy, not a live tool inventory.

`aria doctor` emits plain text only: no ANSI escapes (regardless of `NO_COLOR`), no JSON mode or payload, no prompts, and no repair/install hints. It runs no mutations and touches neither Zotero nor configuration.

### `aria models`

Prints the resolved model (and effort) for every ARIA role as a compact role/model/effort table, following the defaults → global → project precedence: each field resolves from the first defined value at the project, then global, then built-in default level. The effort column is the resolved variant (`-` when the route carries none). If any configuration file is invalid the command fails with a non-zero exit code.

```
role  model  effort
coder  opencode-go/muse-spark-1.3-contributor  xhigh
explorer  opencode-go/muse-spark-1.3-contributor  high
visualizer  opencode-go/muse-spark-1.3-contributor  xhigh
planner  openai/gpt-6-luna  xhigh
architect  openai/gpt-6.1-sol  high
implementer  opencode-go/muse-spark-1.3-contributor  xhigh
reviewer  openai/gpt-6.1-sol  medium
researcher  openai/gpt-6.1-sol  medium
archivist  opencode-go/muse-spark-1.3-contributor  high
writer  openai/gpt-6-luna  xhigh
scientist  openai/gpt-6.1-sol  medium
```

MCPs are preferred evidence sources, not mandatory routes for every task. Engram is durable project memory, not transactional workflow state. `.aria/rdc/TASKS.md` and the native Plan tool remain authoritative for active plan, task, scope, and approval state.

## Writer

`writer` is a `mode: all` agent for writing objectives rather than a general researcher. Invoke it directly for writing work; its small role prompt selects package-owned writing skills on demand:

- `aria-academic-writing` — evidence-bounded peer-reviewed scientific prose and section-aware journal style
- `aria-writing-anti-ai` — removes formulaic LLM prose while preserving technical meaning and appropriate formality
- `aria-review-response` — reviewer-response/rebuttal strategy, evidence anchoring, and tone; consumes verified researcher evidence but owns rebuttal strategy
- `aria-paper-self-review` — structure, overclaim, claim-evidence, reproducibility, and submission-readiness audit; may flag citations needing verification but does not perform external verification
- `aria-document-design` — document information architecture, hierarchy/navigation, progressive disclosure, and representation choices, deferring prose/claims to `aria-academic-writing` and audits to `aria-paper-self-review`

The writer owns final prose and citation placement. It may task `archivist` only for explicitly read-only project/internal evidence. For external literature, Zotero, citation-verification, and claim-support evidence it tasks `researcher` with a focused evidence request (evidence, not manuscript prose). The writer does not query Zotero or the literature itself; it marks external evidence the researcher could not resolve as `[RESEARCH NEEDED]` or `[CITATION NEEDED]`.

## Researcher

`researcher` is the evidence specialist with `mode: all`: you can invoke it directly for literature and citation questions, and the `coder`, `writer`, or `scientist` may delegate focused evidence requests to it. It is read/research-only for the project (protected read plus navigation), with no edit, shell, plan, or Wiki authority.

ARIA owns the research workflow; **ZotPilot remains the Zotero backend/capability provider**. The researcher uses the available ZotPilot MCP research/read tools directly for library search, metadata/content retrieval, and evidence inspection, plus `websearch`/`webfetch` for external authoritative sources and Context7 for library/API documentation. ARIA does not install a second Zotero backend or MCP, and no user-level ZotPilot skill installation is introduced by this role. Zotero mutation is approval-gated: ingest, note/tag/collection management, PDF annotation, and indexing tools require an explicit per-operation user approval, as does any `zotpilot` CLI fallback; the researcher never mutates the library on its own authority.

The packaged `aria-research-evidence` skill defines the repeatable evidence procedure:

- **Evidence ladder** — inspected full text, passage with expanded context, abstract/snippet, secondary mention; claims are labeled with the level actually used.
- **Library-vs-external provenance** — every finding states whether its source is a library item (Zotero identity) or an external source (DOI/URL/identifier).
- **Primary/authoritative-source preference** — original studies, official documentation, standards, and registry records over reviews and summaries.
- **Passage-context expansion** — surrounding context is retrieved before passage-specific claims.
- **Disagreement, uncertainty, and evidence-gap reporting** — conflicts across sources and missing evidence are reported explicitly, never smoothed over.
- **Structured evidence handoffs** — findings with provenance and level, an itemized disagreements/uncertainties/gaps list, and cited sources.
- **Claim-level citation verification** — source identity/existence is checked separately from claim-source support, so a citation is confirmed to exist and its support for the specific claim is classified, never inferred from topical similarity.

`aria-zotero-tutor` is the researcher's skill for a different question: chat-first interactive tutoring and guided reading of a single, already-identified paper in the Zotero library. Unlike `aria-research-evidence` — which owns discovery, verification, citation support, and evidence handoffs — tutoring calibrates goal, familiarity, target, and depth with the learner and explains only from the paper's exposed source content. Any surfaced PDF annotation or reading-persona save uses the existing ZotPilot operation and requires separate explicit approval for that operation; neither is automatic.

Hard boundaries: the researcher verifies source identity and claim-source support, not scientific meaning — interpretation, hypotheses, mechanisms, and nontrivial scientific judgment belong to the `scientist`, whom the researcher may task when claim-to-source alignment exceeds straightforward comparison. The researcher never edits project files, performs software/shell work, maintains the Wiki, drafts manuscript or rebuttal prose, persists to Engram automatically, spawns nested researcher subagents, or mutates Zotero without explicit per-operation approval. It has no Engram, CodeGraph, Wiki, broad MCP, or wildcard ZotPilot authority; its Bash access is deny-by-default with only `zotpilot`/`zotpilot *` approval-gated as a fallback path.

### Dogfood scenario

A realistic literature task to try once ZotPilot is configured with a library and the MCP server is running:

> Ask `researcher` to investigate susceptibility-distortion correction in diffusion MRI. It should search the Zotero library and external authoritative sources (e.g., primary journal studies) through ZotPilot plus web evidence; compare the primary studies it finds; label each supporting passage as abstract/snippet versus inspected full text; expand passage context before making passage-specific claims; report disagreements between sources and any evidence gaps; and request explicit approval before ingesting selected DOI records into the library.

The scenario is a request template, not a claim that it has already run.

## Scientist

`scientist` is the scientific authority with `mode: all`: you can invoke it directly, and `coder`, `researcher`, or `writer` may task it. It owns scientific specification and interpretation — what is being asked, what would count as evidence, methodology and design, what results mean, hypotheses, mechanisms, and nontrivial scientific judgment — and it is not an evidence researcher, a prose writer, or a software engineer.

### Cooperation graph

Scientist cooperation is explicit and narrow: exactly six scientist-related task edges, never an all-to-all role graph.

- **Inbound** — `coder`, `researcher`, and `writer` may task `scientist` for scientific question framing, methodology design, or result interpretation.
- **Outbound** — `scientist` tasks `researcher` for external evidence acquisition (evidence, not conclusions — the scientist interprets), `writer` for prose, manuscript, and report drafting (the scientist decides scientific meaning; the writer decides expression), and `coder` for computation, software, or RDC implementation of its specification. When `coder` computes, `scientist` retains ownership of the scientific specification and of the interpretation of what the computation means; the coder owns implementation correctness.
- **Retained RDC delegation** — a coder delegated by `scientist` keeps its full RDC delegation authority: it still reaches all six RDC coding specialists.

Reciprocal grants cannot bounce: a delegated role must not task any role that is already an active ancestor in the current delegation chain (`scientist` never tasks back whoever tasked it, directly or indirectly). Cycle protection comes from OpenCode's hard depth bound plus this active-ancestor prompt hygiene; ARIA adds no cycle-detection subsystem.

### Prompt and skills

`scientist`'s packaged prompt (`defaults/prompts/scientist.md`) is deliberately lean: it defines authority, ownership, delegation, boundaries, and the required output contract, and routes methodology to two package-owned skills instead of duplicating their checklists:

- `aria-research-planning` — tractable question framing (optional 5W1H), cautious gap/novelty and importance/feasibility reasoning, competing hypotheses, evidence needs versus assumptions, falsification/discrimination criteria, measurement/method/control/confounder/information-value planning, and a minimal next decision.
- `aria-results-analysis` — artifact/comparability and unit/dependence validation, explicit comparisons and metrics, descriptive counts, uncertainty/effect sizes/inference assumptions/multiple comparisons/missingness, practical versus statistical significance, figure/table interpretation, observation versus mechanism, calibrated claims, and explicit blockers/underdetermination.

`scientist` runs on `openai/gpt-6.1-sol` (variant `medium`), the same reasoning-model family and variant as `researcher`: interpretation-heavy scientific reasoning at a balanced reasoning budget, distinct from the `xhigh` variants reserved for `planner` and `writer` plan and prose work.

### Authority and permissions

Availability is not authority: although `scientist` runs with `mode: all`, its tools are deny-by-default. It holds protected project read plus `glob`/`grep`/`list`, exactly two skills (`aria-research-planning`, `aria-results-analysis`), and exactly three task targets (`researcher`, `writer`, `coder`). It has no edit, bash, plan, external-directory, web, LSP, or MCP authority (no CodeGraph/Context7/Engram, no ZotPilot), and no persistence authority — it cannot write Engram observations, SDD documents, registries, or other durable state.

### Cooperation depth

ARIA's nested cooperation (e.g. `scientist → coder → implementer`) needs three subagent levels. The plugin sets `subagent_depth = 3` only as a runtime default when the merged runtime value is absent or nullish; every explicit value — including shallow values such as 0, 1, or 2 and values >= 3 — is preserved untouched, and no user OpenCode config file is read or written for this. Recursion is bounded by OpenCode's hard depth bound plus the active-ancestor prompt rule above. `aria doctor` reports the effective merged top-level `subagent_depth` read-only, and warns nonfatally when the effective value is below 3 (see `aria doctor`).

## Wiki Compiler

`archivist` is a separate, opt-in specialist for Wiki operations with `mode: all`: you can invoke it directly for queries, archival, or compilation, and another agent may delegate to it when appropriate. The coder delegates to it only when the user explicitly requests Wiki work. It never runs automatically.

### Modes

- **Lookup** (read-only) — reads `WIKI_DIR/wiki/index.json`, selects the strongest curated page matches, and performs one bounded related-term coverage pass. No writes, no pipeline initialization, no archival, and no mandatory primer access. An existing primer may be consulted read-only when useful.
- **Archival** (write, explicit request only) — archives raw session or observation data to `WIKI_DIR/raw/` as immutable provenance files. Three commands: `archive-opencode` (OpenCode sessions), `archive-engram` (Engram observations), and `archive-all` (both). Archival does not compile, promote raw material, or regenerate the primer; it only writes raw files and updates archive trackers.
- **Compile / Update** (write, explicit request only) — promotes raw files into curated wiki pages following the manual compilation protocol (`wiki-pipeline/docs/compile-workflow.md`). For each candidate raw file the specialist inspects existing pages, deduplicates, and decides create/update/skip. Updates merge new information while preserving existing content and source provenance, then regenerate `wiki/index.md`, `wiki/index.json`, and append to `wiki/log.md`. An optional primer refresh and lint pass may follow.

Ordinary lookup and compile/update do not archive automatically. Archival occurs only when the user explicitly requests it. There is no CLI command for compilation — compilation is a specialist-led manual workflow, not an automated process.

### Configuration

`WIKI_DIR` is the sole external wiki path, required to locate the Wiki. It must be set to a non-empty value before any wiki operation — write-capable (archival, compile, primer generation) and read-only search alike. When `WIKI_DIR` is absent, write work fails with a clear error before creating any file or directory, and read-only search returns a clear no-write configuration error.

ARIA ships its Wiki procedures as package skills and its pipeline/documentation assets under `wiki-pipeline/`. Pipeline assets are published with the package as listed in `package.json`. The coder receives no wiki filesystem paths or package paths — only the `archivist` specialist does.

### Engram-to-Wiki boundary

Engram-to-Wiki is not an automatic bridge. Engram archival is an explicit user-requested operation. Archived Engram observations remain immutable raw provenance files under `WIKI_DIR/raw/`. Promotion from raw to curated wiki pages is explicit and passes the specialist's deduplicate/create/update/skip curation gate. Engram remains distinct from curated wiki knowledge and from RDC Plan workflow state.

### Out of scope

The archivist does not reference, require, or support:

- `REPO_DIR` or workspace-relative configuration
- `myopencode` runtime dependency, modification, or deletion — myopencode is treated as a source-only upstream
- Automatic wiki, archive, or primer behavior — every operation is explicit
- Zotero, biblio, research, writing, or Phase 3 / wiki-bridge workflows
- Refactors unrelated to wiki integration

## Development

```sh
npm run typecheck
npm test
npm run lint
npm run compile
npm run smoke:package
```

### Release

- `npm run release:check` — seven-stage pre-tag gate (version/package sanity → compile + dist sync → typecheck → targeted ESLint → `git diff --check` → focused lifecycle/hotfix Vitest subset → `npm pack` + isolated install + bare `aria` smoke). Must pass on the commit you intend to tag.
- `git commit` — land any remaining reviewed preparation work.
- `git tag -a vX.Y.Z -m "ARIA vX.Y.Z"` — create an annotated tag on the final reviewed HEAD (semver, e.g. `v1.1.2`).
- `git push` — push the commits, then the tag (`git push origin vX.Y.Z`).
- `npm run verify:release-tag -- vX.Y.Z` — six-stage post-tag check (tag→commit identity → remote tag identity → isolated install of the exact tag spec → bare version + non-checkout package path → hermetic doctor smoke → `upgrade --check` + `models` dispatch). Short smokes only; it does not rerun behavioral qualification or the full suite.
- GitHub Release — publish the release notes for the tag.

The tag is the immutable boundary: never move, delete, or re-point a pushed tag to "fix" a release — cut a new version instead. Multiple release-preparation commits are allowed before tagging; only the tag itself is immutable.

## Acknowledgement

ARIA's Review-Driven Coding subsystem is derived from [cgize/code-ensemble](https://github.com/cgize/code-ensemble) and retains its MIT license.

## License

MIT
