---
name: aria-grill-me
description: Run a focused, general-purpose interview to clarify a user's goal, constraints, trade-offs, and success criteria before work proceeds.
compatibility: opencode
metadata:
  owner: aria
---

# Grill Me

Use this skill when the user asks to be interviewed, questioned, or "grilled" to refine a request, including after opting in to the coder's offer. It is a temporary conversation technique—not an agent, a plan, or an authorization to act.

## Choose a depth

- **Light**: ask only the one to three highest-impact unanswered questions; prefer this when the user asks for a quick pass.
- **Standard**: clarify the outcome, relevant context, important constraints or trade-offs, scope boundaries, and what success looks like. Ask only what is material; this is the default when no depth is specified.
- **Deep**: explore the goal and context more thoroughly, including stakeholders/workflow, priorities, non-goals, constraints, risks or failure cases, and acceptance evidence. Stay bounded to the request and stop once further answers are unlikely to change the next step.

Before asking, review the available conversation, active plan, and relevant project context or evidence using authorized read-only tools as needed. Do not ask for information already available. Honor an explicit mode. If the request is ambiguous about depth, use standard rather than escalating to deep. Ask one question at a time when an answer determines the next question; otherwise group a few related, concise questions. Use concrete choices where helpful and let the user answer "not sure" or "no preference." Adapt follow-ups to the answers instead of presenting a fixed questionnaire.

## Interview

1. Briefly state the goal you understand and the selected depth.
2. Ask the highest-value missing questions first. Prioritize answers that could materially change the outcome, scope, approach, safety, or acceptance criteria; do not spend the user's time on low-impact preferences.
3. Check stated goals, constraints, and proposed solutions for contradictions. When requirements conflict, point out the conflict and ask a targeted question instead of silently choosing one.
4. Constructively assess proposed solutions against the goal and constraints. Respectfully flag mismatches or material risks, and present meaningful alternatives with their trade-offs when they could change the choice; avoid generic option lists.
5. Make consequential assumptions explicit. If an unknown is not blocking, record a reasonable assumption rather than turning it into another question.
6. Stop when the request is clear enough for its next ordinary workflow step; do not keep probing for exhaustive certainty.
7. Give a concise, natural handoff summary of the objective, scope/non-goals, constraints, and success criteria. Keep confirmed decisions distinct from assumptions and recommendations, and do not present a recommendation as user-confirmed. Adapt the structure to the discussion; omit empty categories. Do not add a separate approval or confirmation ceremony; the user can correct the summary naturally.

## Authority and handoff

- Clarification alone does not authorize implementation, tool use that changes project state, a new plan, or a plan mutation. After the interview, the coder follows the existing workflow and approval gates for the user's request.
- If an active plan exists, use the interview only to clarify its currently approved work. Do not change the plan, its task state, or its approval as part of this skill. No extra approval is needed merely to clarify in-scope details.
- If answers introduce work outside an active plan's approved scope, identify that boundary and stop treating the new work as authorized. Hand the summary back to the coder to use the existing scope-change and renewed-approval process before proceeding.
- Do not broaden permissions, bypass a required approval, or create a permanent interviewing role. The skill ends with its handoff summary.
