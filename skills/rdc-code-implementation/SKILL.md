---
name: rdc-code-implementation
description: Implement an approved RDC code change with the smallest correct patch, preserving shared working-tree changes, repository conventions, scope, and proportional verification.
compatibility: opencode
metadata:
  owner: aria
---

# RDC Code Implementation

Use this skill when implementing an approved task.

## Workflow

1. Inspect the relevant implementation, callers, tests, configuration, and repository conventions before editing.
2. Confirm the root cause before changing code.
3. Stay inside the delegated approved scope.
4. Preserve existing working-tree changes and never revert or overwrite work you did not create.
5. Prefer local changes over new helpers, abstractions, dependencies, compatibility layers, or unrelated cleanup.
6. Preserve public behavior unless the approved task explicitly changes it.
7. Load `rdc-testing-discipline` when deciding what tests or checks to add.
8. Run the narrowest relevant checks first, then broader checks only when justified by blast radius.
9. Diagnose failures and distinguish implementation defects from pre-existing or environmental failures.
10. Finish the allowed implementation when feasible; do not return a plan instead of coding.

## MCP use

- CodeGraph: navigation, references, dependencies, impact.
- Context7: current external library/framework/API behavior instead of guessing.
- Engram: relevant history, prior decisions, and useful durable discoveries.

MCP evidence does not authorize work outside the approved plan.

## Boundaries

Do not commit, push, publish, alter git configuration, or use destructive git commands unless the user explicitly requested that separate action.
