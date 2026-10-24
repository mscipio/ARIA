export declare const PLAN_PREMISE_RECOVERY_TOOL_NAME = "plan_premise_recovery";
/** Roles without authority to mutate the shared plan may request a one-shot coder handoff. */
export declare const PLAN_PREMISE_RECOVERY_ROLES: readonly ["explorer", "visualizer", "implementer", "reviewer", "researcher", "archivist", "writer", "scientist"];
export declare const planPremiseRecoveryInputSchema: Record<string, unknown>;
export interface PlanPremiseRecoverySessionApi {
    create(input: {
        parentID: string;
        agent: "coder";
        title: string;
    }): Promise<{
        id?: unknown;
        parentID?: unknown;
        agent?: unknown;
    }>;
    prompt(input: {
        sessionID: string;
        text: string;
    }): Promise<unknown>;
    wait(input: {
        sessionID: string;
    }): Promise<void>;
    context(input: {
        sessionID: string;
    }): Promise<readonly unknown[]>;
}
type RecoveryContext = {
    agent?: unknown;
    sessionID?: unknown;
};
type ToolResult = {
    content: string;
    metadata: {
        title: string;
    };
};
/** Build a single-purpose native tool that validates, then asks coder to recover one premise. */
export declare function createPlanPremiseRecoveryTool(planRoot: string, sessions: PlanPremiseRecoverySessionApi): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown, context: RecoveryContext) => Promise<ToolResult>;
};
export {};
//# sourceMappingURL=plan-premise-recovery-tool.d.ts.map