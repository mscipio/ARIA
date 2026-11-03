export declare const SCRATCH_TASK_TOOL_NAME = "scratch_task";
/**
 * `scratch_task` allocates one execution directory and returns its namespace and
 * path. Supplying both `planId` and `taskId` allocates
 * `.aria/scratch/<plan-id>/<task-id>/<timestamp>/`. Omitting both allocates
 * `.aria/scratch/unplanned/<timestamp>-<description>/`. Supplying only one is an
 * error. Only identifier formats are checked; no plan file is read.
 */
export declare const scratchTaskToolInputSchema: Record<string, unknown>;
type ScratchTaskToolResult = {
    content: string;
    metadata: {
        title: string;
    };
};
/** Build a native V2 tool that allocates one scratch execution directory under the startup project. */
export declare function createScratchTaskTool(projectDirectory: string | undefined): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown) => Promise<ScratchTaskToolResult>;
};
export {};
//# sourceMappingURL=scratch-tool.d.ts.map