export declare const SCRATCH_TASK_TOOL_NAME = "scratch_task";
export declare const scratchTaskToolInputSchema: Record<string, unknown>;
type ScratchTaskToolResult = {
    content: string;
    metadata: {
        title: string;
    };
};
/** Build a native V2 tool for allocating a task scope under the startup project. */
export declare function createScratchTaskTool(projectDirectory: string | undefined): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown) => Promise<ScratchTaskToolResult>;
};
export {};
//# sourceMappingURL=scratch-tool.d.ts.map