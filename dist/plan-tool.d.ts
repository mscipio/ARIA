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
export declare const PLAN_TOOL_NAME = "plan";
export declare const PLAN_TOOL_DESCRIPTION = "Read or update the shared project plan in .aria/rdc/TASKS.md.";
export declare const PLAN_TOOL_ACTIONS: readonly ["create", "get", "replace", "add", "remediate", "update", "approve", "close"];
export type PlanToolAction = (typeof PLAN_TOOL_ACTIONS)[number];
/** V1 `PLAN_ACTIONS_BY_ROLE` preserved verbatim (coder has no `replace`). */
export declare const PLAN_ACTIONS_BY_ROLE: Record<string, ReadonlySet<string>>;
/** V1 `authorizePlan` preserved verbatim (sessionID required, role auth). */
export declare function authorizePlan(context: unknown, action: string): string | null;
/**
 * V1 `isFilesystemRoot` preserved verbatim: lexical root sentinel plus an
 * existing symlink whose canonical realpath resolves to the filesystem root.
 */
export declare function isFilesystemRoot(dir: string): boolean;
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
export declare function resolvePlanRootFromLocation(location: unknown): string;
/** V2 execution-time root guard (startup-location only; see module note). */
export declare function requirePlanRoot(planRoot: string): string;
export declare const planToolInputSchema: Record<string, unknown>;
export interface PlanToolInput {
    action: string;
    title?: string;
    tasks?: string[];
    expectedPlanID?: string;
    expectedRevision?: number;
    taskID?: string;
    status?: "pending" | "in_progress" | "completed" | "blocked";
    evidence?: string;
}
export interface PlanToolContext {
    sessionID?: unknown;
    agent?: unknown;
    messageID?: unknown;
    signal?: AbortSignal;
    progress?: (update: Record<string, unknown>) => Promise<void> | void;
}
export interface PlanToolResult {
    content: string;
    metadata: {
        title: string;
    };
}
/**
 * Build the native V2 tool definition for `editor.add(...)`.
 *
 * The runtime owns registration only; CAS, file locking, and atomic
 * `.aria/rdc/TASKS.md` persistence stay ARIA-owned inside `src/plans.ts`.
 * `planRoot` is the setup-time startup location root (see module note);
 * per-invocation directories do not exist in V2.
 */
export declare function createPlanTool(planRoot: string): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown, context: PlanToolContext) => Promise<PlanToolResult>;
};
/** Is the action string one of the eight supported plan actions? */
export declare function isPlanToolAction(value: unknown): value is PlanToolAction;
//# sourceMappingURL=plan-tool.d.ts.map