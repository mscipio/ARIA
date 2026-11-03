import { allocatePlanExecutionDir, allocateUnplannedExecutionDir, PLAN_ID_PATTERN, PLAN_TASK_ID_PATTERN } from "./scratch.js";

export const SCRATCH_TASK_TOOL_NAME = "scratch_task";

/**
 * `scratch_task` allocates one execution directory and returns its namespace and
 * path. Supplying both `planId` and `taskId` allocates
 * `.aria/scratch/<plan-id>/<task-id>/<timestamp>/`. Omitting both allocates
 * `.aria/scratch/unplanned/<timestamp>-<description>/`. Supplying only one is an
 * error. Only identifier formats are checked; no plan file is read.
 */
export const scratchTaskToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    taskName: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Short description. Used as the directory description for unplanned work and as the allocation title.",
    },
    planId: {
      type: "string",
      pattern: PLAN_ID_PATTERN.source,
      description: "Exact lowercase UUIDv4 of the Markdown plan. Must be supplied together with taskId.",
    },
    taskId: {
      type: "string",
      pattern: PLAN_TASK_ID_PATTERN.source,
      description: "Exact plan task identifier such as T001. Must be supplied together with planId.",
    },
  },
  required: ["taskName"],
  additionalProperties: false,
};

type ScratchTaskToolResult = {
  content: string;
  metadata: { title: string };
};

function toolError(message: string): ScratchTaskToolResult {
  return { content: message, metadata: { title: "Error" } };
}

/** Build a native V2 tool that allocates one scratch execution directory under the startup project. */
export function createScratchTaskTool(projectDirectory: string | undefined): {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown) => Promise<ScratchTaskToolResult>;
} {
  return {
    name: SCRATCH_TASK_TOOL_NAME,
    description:
      "Allocate one scratch execution directory under .aria/scratch and return its namespace and executionDir. With planId and taskId: .aria/scratch/<plan-id>/<task-id>/<timestamp>/. Without them: .aria/scratch/unplanned/<timestamp>-<description>/. No plan file is read.",
    input: scratchTaskToolInputSchema,
    async execute(input) {
      if (!projectDirectory) {
        return toolError("Scratch allocation requires an OpenCode project location directory; no cwd fallback is used.");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return toolError("taskName is required for scratch allocation");
      }

      const args = input as Record<string, unknown>;
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

      const hasPlan = args.planId !== undefined;
      const hasTask = args.taskId !== undefined;
      if (hasPlan !== hasTask) {
        return toolError("planId and taskId must be supplied together for planned scratch, or both omitted for unplanned scratch");
      }

      try {
        if (hasPlan) {
          const executionDir = await allocatePlanExecutionDir(projectDirectory, String(args.planId), String(args.taskId));
          return {
            content: JSON.stringify({ namespace: "plan", executionDir }, null, 2),
            metadata: { title: `Allocate plan scratch · ${String(args.taskId)}` },
          };
        }
        const executionDir = await allocateUnplannedExecutionDir(projectDirectory, taskName);
        return {
          content: JSON.stringify({ namespace: "unplanned", executionDir }, null, 2),
          metadata: { title: `Allocate scratch · ${taskName}` },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
