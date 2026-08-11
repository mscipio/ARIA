import { tool, type Plugin } from "@opencode-ai/plugin";

import { getPackageRoot } from "./defaults.js";
import { resolveReviewDrivenCodeConfig } from "./overrides.js";
import {
  addPlanTasks,
  approvePlan,
  closePlan,
  createPlan,
  readActivePlan,
  remediatePlanTasks,
  replacePlan,
  updatePlanTask,
} from "./plans.js";
import {
  formatClosedPlanOutput,
  formatPlanOutput,
  formatToolError,
  planToolTitle,
} from "./present.js";
import type { ReviewDrivenCodePluginOptions, ResolvedReviewDrivenCodeConfig, RoleName } from "./types.js";

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function projectDirectory(input: unknown): string {
  return (
    stringField(input, "worktree") ??
    stringField((input as { project?: unknown } | undefined)?.project, "worktree") ??
    stringField(input, "directory") ??
    stringField((input as { project?: unknown } | undefined)?.project, "directory") ??
    process.cwd()
  );
}

function pluginOptions(options: unknown): ReviewDrivenCodePluginOptions {
  const configPath = stringField(options, "configPath");
  return configPath ? { configPath } : {};
}

const PLAN_ACTIONS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  director: new Set(["get", "create", "update", "add", "remediate", "close", "approve"]),
  planner: new Set(["get", "create"]),
  architect: new Set(["get", "replace"]),
  reviewer: new Set(["get"]),
};

function authorizePlan(context: unknown, action: string): string | null {
  if (!stringField(context, "sessionID")) return "A sessionID is required to use Review-Driven Coding tools";
  const agent = stringField(context, "agent");
  if (!agent || !PLAN_ACTIONS_BY_ROLE[agent]?.has(action)) {
    return `Role ${agent ?? "unknown"} may not ${action} the plan`;
  }
  return null;
}

type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type AgentPermission = Record<string, PermissionRule>;
type SubagentRole = Exclude<RoleName, "director">;

const BASE_PERMISSION: AgentPermission = {
  "*": "deny",
  read: "deny",
  edit: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  task: "deny",
  external_directory: "deny",
  todowrite: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
  lsp: "deny",
  doom_loop: "ask",
  skill: "deny",
  plan: "deny",
};

const PROTECTED_READ: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
};

const PROTECTED_EDIT: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
};

const CODE_READ: AgentPermission = {
  ...BASE_PERMISSION,
  read: PROTECTED_READ,
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
};

const REQUIRED_MCP_PERMISSION: AgentPermission = {
  "engram_*": "allow",
  "context7_*": "allow",
  "codegraph_*": "allow",
};

const SUBAGENT_PERMISSIONS: Record<SubagentRole, AgentPermission> = {
  explorer: { ...CODE_READ, ...REQUIRED_MCP_PERMISSION },
  visualizer: { ...BASE_PERMISSION, ...REQUIRED_MCP_PERMISSION, read: PROTECTED_READ, skill: "allow" },
  planner: { ...CODE_READ, ...REQUIRED_MCP_PERMISSION, webfetch: "allow", websearch: "allow", skill: "allow", plan: "allow" },
  architect: { ...CODE_READ, ...REQUIRED_MCP_PERMISSION, webfetch: "allow", websearch: "allow", skill: "allow", plan: "allow" },
  implementer: {
    ...CODE_READ,
    ...REQUIRED_MCP_PERMISSION,
    edit: PROTECTED_EDIT,
    bash: {
      "*": "allow",
      "rm": "deny",
      "rm *": "deny",
      "rmdir": "deny",
      "rmdir *": "deny",
      "del": "deny",
      "del *": "deny",
      "Remove-Item*": "deny",
      "npm publish*": "deny",
      "pnpm publish*": "deny",
      "yarn publish*": "deny",
      "bun publish*": "deny",
    },
    skill: "allow",
  },
  reviewer: {
    ...CODE_READ,
    ...REQUIRED_MCP_PERMISSION,
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
    skill: "allow",
    plan: "allow",
  },
  "wiki-compiler": {
    ...BASE_PERMISSION,
    read: { "*": "deny" },
    edit: { "*": "deny" },
    glob: "deny",
    grep: "deny",
    list: "deny",
    bash: { "*": "deny" },
    external_directory: "deny",
  },
};

const PACKAGE_ROOT = getPackageRoot();

function buildWikiCompilerPermissions(): AgentPermission {
  const wikiDir = process.env.WIKI_DIR;

  if (!wikiDir) {
    return SUBAGENT_PERMISSIONS["wiki-compiler"];
  }

  const pipelineRun = `${PACKAGE_ROOT}/wiki-pipeline/run.py`;

  const readScope: Record<string, PermissionAction> = {
    "*": "deny",
  };
  readScope[`${wikiDir}/**`] = "allow";
  readScope[`${PACKAGE_ROOT}/wiki-pipeline/**`] = "allow";

  const editScope: Record<string, PermissionAction> = {
    "*": "deny",
  };
  editScope[`${wikiDir}/**`] = "allow";

  const externalDirScope: Record<string, PermissionAction> = {
    "*": "deny",
  };
  externalDirScope[wikiDir] = "allow";
  externalDirScope[PACKAGE_ROOT] = "allow";

  // Discovery tools scoped to the same boundaries as read
  const discoveryScope: Record<string, PermissionAction> = {
    "*": "deny",
  };
  discoveryScope[`${wikiDir}/**`] = "allow";
  discoveryScope[`${PACKAGE_ROOT}/wiki-pipeline/**`] = "allow";

  return {
    ...BASE_PERMISSION,
    glob: discoveryScope,
    grep: discoveryScope,
    list: discoveryScope,
    read: readScope,
    edit: editScope,
    bash: {
      "*": "deny",
      [`python ${pipelineRun} archive-opencode`]: "allow",
      [`python ${pipelineRun} archive-engram`]: "allow",
      [`python ${pipelineRun} archive-all`]: "allow",
      [`python ${pipelineRun} lint`]: "allow",
      [`python ${pipelineRun} primer`]: "allow",
    },
    external_directory: externalDirScope,
  };
}

const SUBAGENT_ROLES = Object.keys(SUBAGENT_PERMISSIONS) as SubagentRole[];

function agentDefinitions(config: ResolvedReviewDrivenCodeConfig): Record<string, unknown> {
  const taskPermissions: Record<string, "allow" | "deny"> = {
    "*": "deny",
    explorer: "allow",
    visualizer: "allow",
    planner: "allow",
    architect: "allow",
    implementer: "allow",
    reviewer: "allow",
    "wiki-compiler": "allow",
  };
  const definitions: Record<string, unknown> = {
    director: {
      description: "Coordinates planning, implementation, and review.",
      mode: "primary",
      model: config.roles.director.model,
      ...(config.roles.director.variant ? { variant: config.roles.director.variant } : {}),
      prompt: config.roles.director.promptText,
      permission: {
        ...REQUIRED_MCP_PERMISSION,
        edit: "deny",
        bash: "deny",
        task: taskPermissions,
        plan: "allow",
      },
    },
  };

  for (const role of SUBAGENT_ROLES) {
    const roleConfig = config.roles[role];
    definitions[role] = {
      description: `${role} specialist for Review-Driven Coding.`,
      mode: "subagent",
      model: roleConfig.model,
      ...(roleConfig.variant ? { variant: roleConfig.variant } : {}),
      prompt: roleConfig.promptText,
      permission: role === "wiki-compiler"
        ? buildWikiCompilerPermissions()
        : SUBAGENT_PERMISSIONS[role],
    };
  }

  return definitions;
}

export const reviewDrivenCodePlugin: Plugin = async (input, options = {}) => {
  const directory = projectDirectory(input);
  const config = resolveReviewDrivenCodeConfig(directory, pluginOptions(options));

  return {
    config: async (runtimeConfig) => {
      runtimeConfig.agent ??= {};
      Object.assign(runtimeConfig.agent, agentDefinitions(config));
    },
    tool: {
      plan: tool({
        description: "Read or update the shared project plan in .code-ensemble/TASKS.md.",
        args: {
          action: tool.schema
            .enum(["create", "get", "replace", "add", "remediate", "update", "approve", "close"])
            .describe("Plan action to perform"),
          title: tool.schema.string().optional().describe("Plan title for create or replace"),
          tasks: tool.schema.array(tool.schema.string()).optional().describe("Task texts for create, replace, add, or remediate"),
          expectedPlanID: tool.schema
            .string()
            .optional()
            .describe("Plan id from get; required by replace, update, add, remediate, approve, and close"),
          expectedRevision: tool.schema.number().int().positive().optional().describe("Current plan revision"),
          taskID: tool.schema.string().optional().describe("Task id for update, e.g. T001"),
          status: tool.schema
            .enum(["pending", "in_progress", "completed", "blocked"])
            .optional()
            .describe("New task status for update"),
          evidence: tool.schema.string().optional().describe("Verification evidence when completing a task"),
        },
        async execute(args, context) {
          const title = planToolTitle(args);
          context.metadata({ title });
          const error = authorizePlan(context, args.action);
          if (error) return formatToolError(error);
          const ok = (output: string) => ({ title, output });
          try {
            switch (args.action) {
              case "get": {
                const active = await readActivePlan(directory);
                return ok(formatPlanOutput(active?.plan ?? null));
              }
              case "create": {
                if (!args.title || !args.tasks) return formatToolError("title and tasks are required for create");
                return ok(formatPlanOutput(await createPlan(directory, args.title, args.tasks, context.abort)));
              }
              case "replace": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for replace");
                if (args.expectedRevision === undefined) {
                  return formatToolError("expectedRevision is required for replace");
                }
                if (!args.title || !args.tasks) return formatToolError("title and tasks are required for replace");
                return ok(formatPlanOutput(
                  await replacePlan(directory, args.expectedPlanID, args.expectedRevision, args.title, args.tasks, context.abort),
                ));
              }
              case "add": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for add");
                if (args.expectedRevision === undefined) return formatToolError("expectedRevision is required for add");
                if (!args.tasks) return formatToolError("tasks are required for add");
                return ok(formatPlanOutput(
                  await addPlanTasks(directory, args.expectedPlanID, args.expectedRevision, args.tasks, context.abort),
                ));
              }
              case "remediate": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for remediate");
                if (args.expectedRevision === undefined) return formatToolError("expectedRevision is required for remediate");
                if (!args.tasks) return formatToolError("tasks are required for remediate");
                return ok(formatPlanOutput(
                  await remediatePlanTasks(directory, args.expectedPlanID, args.expectedRevision, args.tasks, context.abort),
                ));
              }
              case "update": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for update");
                if (args.expectedRevision === undefined) return formatToolError("expectedRevision is required for update");
                if (!args.taskID || !args.status) return formatToolError("taskID and status are required for update");
                return ok(formatPlanOutput(
                  await updatePlanTask(
                    directory,
                    args.expectedPlanID,
                    args.expectedRevision,
                    args.taskID,
                    args.status,
                    args.evidence,
                    context.abort,
                  ),
                ));
              }
              case "approve": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for approve");
                if (args.expectedRevision === undefined) return formatToolError("expectedRevision is required for approve");
                return ok(formatPlanOutput(
                  await approvePlan(directory, args.expectedPlanID, args.expectedRevision, context.abort),
                ));
              }
              case "close": {
                if (!args.expectedPlanID) return formatToolError("expectedPlanID is required for close");
                if (args.expectedRevision === undefined) return formatToolError("expectedRevision is required for close");
                const closed = await closePlan(directory, args.expectedPlanID, args.expectedRevision, context.abort);
                return ok(formatClosedPlanOutput(closed.plan, closed.archived));
              }
              default:
                return formatToolError(`Unknown plan action: ${String(args.action)}`);
            }
          } catch (caught) {
            return formatToolError(caught instanceof Error ? caught.message : String(caught));
          }
        },
      }),
    },
  };
};
