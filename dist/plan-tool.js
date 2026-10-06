import { realpathSync } from "node:fs";
import path from "node:path";
import { addPlanTasks, approvePlan, closePlan, createPlan, readActivePlan, remediatePlanTasks, replacePlan, updatePlanTask, } from "./plans.js";
import { formatClosedPlanOutput, formatPlanOutput, formatToolError, planToolTitle, } from "./present.js";
/**
 * T006 — Native V2 RDC plan tool (`ctx.tool.transform(editor => editor.add(...))`).
 *
 * Single V2 registration home for the shared plan. Plan semantics
 * (CAS `expectedPlanID`/`expectedRevision`, atomic/locked `.aria/rdc/TASKS.md`
 * persistence, UUID/revision/approval/caps) are owned by `src/plans.ts` and
 * reused here without duplication; presentation titles/error strings are
 * owned by `src/present.ts`. This module only owns the V2 registration
 * adapter: JSON-Schema input, `ToolContext` authorization, startup-location
 * root guards, and `signal`/`progress` mapping.
 *
 * V1 source (`src/register.ts`) stays untouched as the frozen V1 reference
 * until migration completes.
 *
 * V2 incompatibility (narrow, justified):
 * - V1 `ToolContext` carried per-invocation `directory`/`worktree` plus
 *   `abort`/`metadata()`. V2 `Tool.Context` carries only
 *   `{ sessionID, agent, messageID }` plus `signal`/`progress` — no
 *   per-invocation directory. Persistence therefore resolves once at plugin
 *   `setup` from `ctx.location` (startup location) instead of per invocation
 *   from `context.directory`. The lexical + symlink-to-root guards
 *   (`isFilesystemRoot`) are otherwise identical to V1.
 * - V1 `abort` maps to V2 `signal` (both `AbortSignal`, passed through to
 *   the `plans.ts` APIs as `signal`).
 * - V1 `metadata({ title })` + `{ title, output }` maps to V2
 *   `progress({ title })` + `{ content, metadata: { title } }`. Error
 *   semantics stay content-carried (`{ content: message,
 *   metadata: { title: "Error" } }`, never thrown) exactly like V1's
 *   `formatToolError` success-carried errors.
 */
export const PLAN_TOOL_NAME = "plan";
export const PLAN_TOOL_DESCRIPTION = "Read or update the shared project plan in .aria/rdc/TASKS.md.";
export const PLAN_TOOL_ACTIONS = [
    "create",
    "get",
    "replace",
    "add",
    "remediate",
    "update",
    "approve",
    "close",
];
const PLAN_ACTION_SET = new Set(PLAN_TOOL_ACTIONS);
/** V1 `PLAN_ACTIONS_BY_ROLE` preserved verbatim (coder has no `replace`). */
export const PLAN_ACTIONS_BY_ROLE = {
    coder: new Set(["get", "create", "update", "add", "remediate", "close", "approve"]),
    planner: new Set(["get", "create"]),
    architect: new Set(["get", "replace"]),
    reviewer: new Set(["get"]),
};
function stringField(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    const field = value[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
}
/** V1 `authorizePlan` preserved verbatim (sessionID required, role auth). */
export function authorizePlan(context, action) {
    if (!stringField(context, "sessionID"))
        return "A sessionID is required to use ARIA RDC plan tools";
    const agent = stringField(context, "agent");
    if (!agent || !PLAN_ACTIONS_BY_ROLE[agent]?.has(action)) {
        return `Role ${agent ?? "unknown"} may not ${action} the plan`;
    }
    return null;
}
/**
 * V1 `isFilesystemRoot` preserved verbatim: lexical root sentinel plus an
 * existing symlink whose canonical realpath resolves to the filesystem root.
 */
export function isFilesystemRoot(dir) {
    const resolved = path.resolve(dir);
    const parsed = path.parse(resolved);
    if (resolved === parsed.root)
        return true;
    try {
        const real = realpathSync(resolved);
        const realParsed = path.parse(real);
        return real === realParsed.root;
    }
    catch {
        return false;
    }
}
function meaningfulDirectory(value, key) {
    const dir = stringField(value, key);
    if (dir && !isFilesystemRoot(dir))
        return dir;
    return undefined;
}
/**
 * V2 startup-location root selector (V1 `projectDirectory` + startup half of
 * `planInvocationRoot`, adapted: no per-invocation directory exists in V2).
 *
 * Prefers a meaningful `location.directory`, then a meaningful
 * `location.project.directory` — each validated individually before
 * precedence so a root sentinel or symlink-to-root never shadows a
 * meaningful candidate. Returns `""` when neither is meaningful; callers
 * surface the meaningful-root error at execution time (never at setup).
 */
export function resolvePlanRootFromLocation(location) {
    if (!location || typeof location !== "object")
        return "";
    const record = location;
    return (meaningfulDirectory(record, "directory") ??
        meaningfulDirectory(record.project, "directory") ??
        "");
}
/** V2 execution-time root guard (startup-location only; see module note). */
export function requirePlanRoot(planRoot) {
    if (planRoot && !isFilesystemRoot(planRoot))
        return planRoot;
    throw new Error("Plan execution requires a meaningful OpenCode directory; the plugin-startup location did not provide a valid root");
}
export const planToolInputSchema = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: [...PLAN_TOOL_ACTIONS],
            description: "Plan action to perform",
        },
        title: { type: "string", description: "Plan title for create or replace" },
        tasks: {
            type: "array",
            items: { type: "string" },
            description: "Task texts for create, replace, add, or remediate",
        },
        expectedPlanID: {
            type: "string",
            description: "Plan id from get; required by replace, update, add, remediate, approve, and close",
        },
        expectedRevision: {
            type: "integer",
            minimum: 1,
            description: "Current plan revision",
        },
        taskID: { type: "string", description: "Task id for update, e.g. T001" },
        status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "blocked"],
            description: "New task status for update",
        },
        evidence: { type: "string", description: "Verification evidence when completing a task" },
    },
    required: ["action"],
};
function planError(message) {
    const formatted = formatToolError(message);
    return { content: formatted.output, metadata: { title: formatted.title } };
}
function planSuccess(title, output) {
    return { content: output, metadata: { title } };
}
async function safeProgress(context, title) {
    try {
        await context.progress?.({ title });
    }
    catch {
        // Progress is best-effort display metadata; never fail the tool on it.
    }
}
async function executePlanAction(rawArgs, context, planRoot) {
    const args = (rawArgs ?? {});
    const action = typeof args.action === "string" ? args.action : "";
    const title = planToolTitle(args);
    await safeProgress(context, title);
    const authError = authorizePlan(context, action);
    if (authError)
        return planError(authError);
    const ok = (output) => planSuccess(title, output);
    try {
        const root = requirePlanRoot(planRoot);
        const signal = context.signal;
        switch (action) {
            case "get": {
                const active = await readActivePlan(root);
                return ok(formatPlanOutput(active?.plan ?? null));
            }
            case "create": {
                if (!args.title || !args.tasks)
                    return planError("title and tasks are required for create");
                return ok(formatPlanOutput(await createPlan(root, args.title, args.tasks, signal)));
            }
            case "replace": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for replace");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for replace");
                if (!args.title || !args.tasks)
                    return planError("title and tasks are required for replace");
                return ok(formatPlanOutput(await replacePlan(root, args.expectedPlanID, args.expectedRevision, args.title, args.tasks, signal)));
            }
            case "add": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for add");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for add");
                if (!args.tasks)
                    return planError("tasks are required for add");
                return ok(formatPlanOutput(await addPlanTasks(root, args.expectedPlanID, args.expectedRevision, args.tasks, signal)));
            }
            case "remediate": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for remediate");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for remediate");
                if (!args.tasks)
                    return planError("tasks are required for remediate");
                return ok(formatPlanOutput(await remediatePlanTasks(root, args.expectedPlanID, args.expectedRevision, args.tasks, signal)));
            }
            case "update": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for update");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for update");
                if (!args.taskID || !args.status)
                    return planError("taskID and status are required for update");
                return ok(formatPlanOutput(await updatePlanTask(root, args.expectedPlanID, args.expectedRevision, args.taskID, args.status, args.evidence, signal)));
            }
            case "approve": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for approve");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for approve");
                return ok(formatPlanOutput(await approvePlan(root, args.expectedPlanID, args.expectedRevision, signal)));
            }
            case "close": {
                if (!args.expectedPlanID)
                    return planError("expectedPlanID is required for close");
                if (args.expectedRevision === undefined)
                    return planError("expectedRevision is required for close");
                const closed = await closePlan(root, args.expectedPlanID, args.expectedRevision, signal);
                return ok(formatClosedPlanOutput(closed.plan, closed.archived));
            }
            default:
                return planError(`Unknown plan action: ${String(args.action)}`);
        }
    }
    catch (caught) {
        return planError(caught instanceof Error ? caught.message : String(caught));
    }
}
/**
 * Build the native V2 tool definition for `editor.add(...)`.
 *
 * The runtime owns registration only; CAS, file locking, and atomic
 * `.aria/rdc/TASKS.md` persistence stay ARIA-owned inside `src/plans.ts`.
 * `planRoot` is the setup-time startup location root (see module note);
 * per-invocation directories do not exist in V2.
 */
export function createPlanTool(planRoot) {
    return {
        name: PLAN_TOOL_NAME,
        description: PLAN_TOOL_DESCRIPTION,
        input: planToolInputSchema,
        execute: (input, context) => executePlanAction(input, context ?? {}, planRoot),
    };
}
/** Is the action string one of the eight supported plan actions? */
export function isPlanToolAction(value) {
    return typeof value === "string" && PLAN_ACTION_SET.has(value);
}
//# sourceMappingURL=plan-tool.js.map