import { scratchTaskScope } from "./scratch.js";
export const SCRATCH_TASK_TOOL_NAME = "scratch_task";
export const scratchTaskToolInputSchema = {
    type: "object",
    properties: {
        taskId: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
            description: "Approved task ID (a safe 1–64 character path component)",
        },
        taskName: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Short descriptive task name used to form a safe scratch-directory slug",
        },
    },
    required: ["taskId", "taskName"],
    additionalProperties: false,
};
function toolError(message) {
    return { content: message, metadata: { title: "Error" } };
}
/** Build a native V2 tool for allocating a task scope under the startup project. */
export function createScratchTaskTool(projectDirectory) {
    return {
        name: SCRATCH_TASK_TOOL_NAME,
        description: "Allocate the canonical date-scoped scratch directory for an approved task and return its task directory and useful output subpaths.",
        input: scratchTaskToolInputSchema,
        async execute(input) {
            if (!projectDirectory) {
                return toolError("Scratch allocation requires an OpenCode project location directory; no cwd fallback is used.");
            }
            if (!input || typeof input !== "object" || Array.isArray(input)) {
                return toolError("taskId and taskName are required for scratch allocation");
            }
            const args = input;
            if (typeof args.taskId !== "string" || args.taskId.trim().length === 0 || args.taskId.trim().length > 64) {
                return toolError("taskId must be a non-empty safe task ID of at most 64 characters");
            }
            if (typeof args.taskName !== "string") {
                return toolError("taskName must be a non-empty descriptive string");
            }
            const taskName = args.taskName.trim();
            const hasControlCharacters = taskName.split("").some((character) => {
                const codeUnit = character.charCodeAt(0);
                return (codeUnit >= 0x00 && codeUnit <= 0x1f) || codeUnit === 0x7f;
            });
            if (taskName.length === 0 || taskName.length > 200 || hasControlCharacters) {
                return toolError("taskName must be a non-empty descriptive string of at most 200 characters without control characters");
            }
            try {
                const scope = await scratchTaskScope(projectDirectory, args.taskId, taskName);
                return {
                    content: JSON.stringify({ scratch: scope.scratch, taskDir: scope.taskDir, dirs: scope.dirs }, null, 2),
                    metadata: { title: `Allocate task scratch · ${taskName}` },
                };
            }
            catch (error) {
                return toolError(error instanceof Error ? error.message : String(error));
            }
        },
    };
}
//# sourceMappingURL=scratch-tool.js.map