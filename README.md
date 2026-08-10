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
opencode plugin "file:///absolute/path/to/review-driven-code"
```

Restart OpenCode and select `director` from the agent selector.

## Configuration

Create `review-driven-code.json` in the project root only to override models or variants:

```json
{
  "roles": {
    "planner": {
      "model": "openai/gpt-5.6-terra",
      "variant": "xhigh"
    },
    "architect": {
      "model": "openai/gpt-5.6-sol"
    },
    "explorer": {
      "variant": "xhigh"
    }
  }
}
```

Every model identifier must use `provider/model` format. Variant is optional. If a field is omitted, the built-in default for that role applies.

## Required Integrations

RDC requires three external integrations. RDC does not fork, vendor, or duplicate their internal implementation -- updates track their latest stable upstream releases and services.

| Integration | Purpose | Upstream |
|---|---|---|
| [Engram](https://github.com/Gentleman-Programming/engram) | Durable semantic/project memory | `engram setup opencode` |
| [Context7](https://github.com/upstash/context7) | Current external library, framework, and API documentation | Remote MCP endpoint |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Codebase intelligence for structure and impact | `@colbymchenry/codegraph` |

```bash
rdc deps sync   # install/update all required integrations
rdc doctor      # report status of all required integrations
rdc routes      # print resolved model routes for each RDC role
```

`rdc deps sync` synchronizes each dependency using its upstream-supported mechanism, then reconciles OpenCode MCP configuration. `rdc doctor` is read-only and reports which integrations are present.

`rdc routes` prints the resolved model (and optional variant) for every RDC role, using built-in defaults merged with any `review-driven-code.json` project overrides. If the configuration file is invalid the command fails with a non-zero exit code.

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
