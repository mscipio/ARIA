import { join } from "node:path";

import { createScratchRunDir, resolveScratchRoot } from "./scratch.js";

export const SCRATCH_TASK_TOOL_NAME = "scratch_task";

export const scratchTaskToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      description: "Optional workflow reference; scratch allocation does not inspect task or plan state",
    },
    taskName: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Short descriptive task name used to form a safe scratch-directory slug",
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

/** Build a native V2 tool for allocating a named output run under the startup project. */
export function createScratchTaskTool(projectDirectory: string | undefined): {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown) => Promise<ScratchTaskToolResult>;
} {
  return {
    name: SCRATCH_TASK_TOOL_NAME,
    description:
      "Allocate a canonical timestamped scratch directory for generated task output; no plan or task lookup is performed.",
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

      try {
        const { scratch } = await resolveScratchRoot(projectDirectory);
        const taskDir = await createScratchRunDir(projectDirectory, taskName);
        const subdirectories = [
          ["tmp", "tmp"], ["testFixtures", "tests/fixtures"], ["testResults", "tests/results"],
          ["logs", "logs"], ["screenshots", "captures/screenshots"], ["videos", "captures/videos"],
          ["builds", "builds"], ["environments", "environments"], ["runtime", "runtime"], ["experiments", "experiments"],
        ] as const;
        const dirs = Object.fromEntries(subdirectories.map(([key, subdir]) => [key, join(taskDir, subdir)]));
        return {
          content: JSON.stringify({ scratch, taskDir, dirs }, null, 2),
          metadata: { title: `Allocate scratch · ${taskName}` },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
