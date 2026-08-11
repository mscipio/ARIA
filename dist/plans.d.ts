export type PlanTaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanApproval = "pending" | "approved";
export type PlanTask = {
    id: string;
    text: string;
    status: PlanTaskStatus;
    evidence?: string;
};
export type SharedPlan = {
    version: 3;
    id: string;
    revision: number;
    status: "active" | "closed";
    approval: PlanApproval;
    title: string;
    createdAt: string;
    updatedAt: string;
    tasks: PlanTask[];
};
export declare function renderPlan(plan: SharedPlan): string;
export declare function readActivePlan(worktree: string): Promise<{
    plan: SharedPlan;
    markdown: string;
} | null>;
export declare function createPlan(worktree: string, title: string, tasks: string[], signal?: AbortSignal): Promise<SharedPlan>;
export declare function approvePlan(worktree: string, expectedPlanID: string, expectedRevision: number, signal?: AbortSignal): Promise<SharedPlan>;
export declare function updatePlanTask(worktree: string, expectedPlanID: string, expectedRevision: number, taskID: string, status: PlanTaskStatus, evidence?: string, signal?: AbortSignal): Promise<SharedPlan>;
export declare function addPlanTasks(worktree: string, expectedPlanID: string, expectedRevision: number, tasks: string[], signal?: AbortSignal): Promise<SharedPlan>;
export declare function remediatePlanTasks(worktree: string, expectedPlanID: string, expectedRevision: number, tasks: string[], signal?: AbortSignal): Promise<SharedPlan>;
export declare function replacePlan(worktree: string, expectedPlanID: string, expectedRevision: number, title: string, tasks: string[], signal?: AbortSignal): Promise<SharedPlan>;
export declare function closePlan(worktree: string, expectedPlanID: string, expectedRevision: number, signal?: AbortSignal): Promise<{
    plan: SharedPlan;
    archived: string;
}>;
//# sourceMappingURL=plans.d.ts.map