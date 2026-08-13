import { tool } from "@opencode-ai/plugin";
import path from "node:path";
import { getPackageRoot } from "./defaults.js";
import { resolveAriaConfig } from "./overrides.js";
import { addPlanTasks, approvePlan, closePlan, createPlan, readActivePlan, remediatePlanTasks, replacePlan, updatePlanTask, } from "./plans.js";
import { formatClosedPlanOutput, formatPlanOutput, formatToolError, planToolTitle, } from "./present.js";
function stringField(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    const field = value[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
}
function projectDirectory(input) {
    return (stringField(input, "worktree") ??
        stringField(input?.project, "worktree") ??
        stringField(input, "directory") ??
        stringField(input?.project, "directory") ??
        process.cwd());
}
function pluginOptions(options) {
    const configPath = stringField(options, "configPath");
    return configPath ? { configPath } : {};
}
const PLAN_ACTIONS_BY_ROLE = {
    coder: new Set(["get", "create", "update", "add", "remediate", "close", "approve"]),
    planner: new Set(["get", "create"]),
    architect: new Set(["get", "replace"]),
    reviewer: new Set(["get"]),
};
function authorizePlan(context, action) {
    if (!stringField(context, "sessionID"))
        return "A sessionID is required to use ARIA RDC plan tools";
    const agent = stringField(context, "agent");
    if (!agent || !PLAN_ACTIONS_BY_ROLE[agent]?.has(action)) {
        return `Role ${agent ?? "unknown"} may not ${action} the plan`;
    }
    return null;
}
const BASE_PERMISSION = {
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
const PROTECTED_READ = {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
};
const PROTECTED_EDIT = {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
};
const CODE_READ = {
    ...BASE_PERMISSION,
    read: PROTECTED_READ,
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
};
const REQUIRED_MCP_PERMISSION = {
    "engram_*": "allow",
    "context7_*": "allow",
    "codegraph_*": "allow",
};
// Verified ZotPilot MCP inventory (environment-provided; not part of this
// repository's dependencies). Verified against zotpilot 0.5.3 in this
// environment: the FastMCP server is named `zotpilot` (`zotpilot mcp serve`),
// and OpenCode exposes its tools as `zotpilot_<tool>`, the same server-name
// prefix convention used for engram/context7/codegraph above. Tool IDs were
// enumerated from the live server's `tools/list` response on 2026-08-13:
// 14 research/read tools and 8 mutation tools (all others are unlisted and
// fall back to the base `*` deny — no wildcard ZotPilot grant is encoded).
const ZOTPILOT_MCP_READ = {
    "zotpilot_search_papers": "allow",
    "zotpilot_search_topic": "allow",
    "zotpilot_search_boolean": "allow",
    "zotpilot_search_formulas": "allow",
    "zotpilot_advanced_search": "allow",
    "zotpilot_search_academic_databases": "allow",
    "zotpilot_browse_library": "allow",
    "zotpilot_get_paper_details": "allow",
    "zotpilot_get_notes": "allow",
    "zotpilot_get_annotations": "allow",
    "zotpilot_get_citations": "allow",
    "zotpilot_get_passage_context": "allow",
    "zotpilot_get_index_stats": "allow",
    "zotpilot_get_paper_for_tutor": "allow",
};
// ZotPilot mutation tools are approval-gated (`ask`); the permission model
// supports per-tool ask (OpenCode PermissionAction: allow | deny | ask). The
// researcher prompt additionally requires explicit user approval before any
// Zotero mutation.
const ZOTPILOT_MCP_MUTATION = {
    "zotpilot_index_library": "ask",
    "zotpilot_index_formulas": "ask",
    "zotpilot_ingest_by_identifiers": "ask",
    "zotpilot_create_note": "ask",
    "zotpilot_manage_tags": "ask",
    "zotpilot_manage_collections": "ask",
    "zotpilot_annotate_pdf": "ask",
    "zotpilot_save_reading_persona": "ask",
};
function skillAccess(...names) {
    return Object.fromEntries([
        ["*", "deny"],
        ...names.map((name) => [name, "allow"]),
    ]);
}
const ROLE_PERMISSIONS = {
    explorer: {
        ...CODE_READ,
        ...REQUIRED_MCP_PERMISSION,
        skill: skillAccess("rdc-code-exploration"),
    },
    visualizer: {
        ...BASE_PERMISSION,
        ...REQUIRED_MCP_PERMISSION,
        read: PROTECTED_READ,
        skill: skillAccess("rdc-visual-analysis"),
    },
    planner: {
        ...CODE_READ,
        ...REQUIRED_MCP_PERMISSION,
        webfetch: "allow",
        websearch: "allow",
        skill: skillAccess("rdc-implementation-planning", "rdc-testing-discipline"),
        plan: "allow",
    },
    architect: {
        ...CODE_READ,
        ...REQUIRED_MCP_PERMISSION,
        webfetch: "allow",
        websearch: "allow",
        skill: skillAccess("rdc-plan-review", "rdc-scope-assessment", "rdc-testing-discipline"),
        plan: "allow",
    },
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
        skill: skillAccess("rdc-code-implementation", "rdc-testing-discipline"),
    },
    reviewer: {
        ...CODE_READ,
        ...REQUIRED_MCP_PERMISSION,
        bash: "allow",
        webfetch: "allow",
        websearch: "allow",
        skill: skillAccess("rdc-implementation-review", "rdc-testing-discipline"),
        plan: "allow",
    },
    researcher: {
        ...BASE_PERMISSION,
        read: PROTECTED_READ,
        glob: "allow",
        grep: "allow",
        list: "allow",
        webfetch: "allow",
        websearch: "allow",
        "context7_*": "allow",
        ...ZOTPILOT_MCP_READ,
        ...ZOTPILOT_MCP_MUTATION,
        skill: skillAccess("aria-research-evidence"),
        // Deny-by-default shell access: only the zotpilot executable family is
        // approval-gated as a fallback/administrative path, never allowed and
        // never the primary ZotPilot interface (the MCP tools are).
        bash: {
            "*": "deny",
            "zotpilot": "ask",
            "zotpilot *": "ask",
        },
    },
    writer: {
        ...BASE_PERMISSION,
        read: PROTECTED_READ,
        skill: skillAccess("aria-academic-writing", "aria-writing-anti-ai", "aria-review-response", "aria-paper-self-review"),
        task: {
            "*": "deny",
            "archivist": "allow",
            "researcher": "allow",
        },
    },
    "archivist": {
        ...BASE_PERMISSION,
        read: { "*": "deny" },
        edit: { "*": "deny" },
        glob: "deny",
        grep: "deny",
        list: "deny",
        bash: { "*": "deny" },
        skill: skillAccess("aria-wiki-lookup", "aria-wiki-archive", "aria-wiki-compile"),
        external_directory: "deny",
    },
};
const PACKAGE_ROOT = getPackageRoot();
const PACKAGE_SKILLS_ROOT = path.join(PACKAGE_ROOT, "skills");
function buildArchivistPermissions(worktree) {
    const wikiDir = process.env.WIKI_DIR;
    if (!wikiDir) {
        return ROLE_PERMISSIONS["archivist"];
    }
    const pipelineRoot = path.join(PACKAGE_ROOT, "wiki-pipeline");
    const pipelineRun = path.join(pipelineRoot, "run.py");
    const wikiRelative = path.relative(worktree, wikiDir).replaceAll("\\", "/");
    const pipelineRelative = path.relative(worktree, pipelineRoot).replaceAll("\\", "/");
    // OpenCode evaluates read/edit permissions against paths relative to the
    // active worktree, even when the tool was called with an absolute path.
    const readScope = {
        "*": "deny",
        [wikiRelative]: "allow",
        [`${wikiRelative}/**`]: "allow",
        [pipelineRelative]: "allow",
        [`${pipelineRelative}/**`]: "allow",
    };
    const editScope = {
        "*": "deny",
        [wikiRelative]: "allow",
        [`${wikiRelative}/**`]: "allow",
    };
    // external_directory is evaluated against absolute filesystem paths.
    const externalDirScope = {
        "*": "deny",
        [`${wikiDir}/**`]: "allow",
        [`${pipelineRoot}/**`]: "allow",
    };
    return {
        ...BASE_PERMISSION,
        glob: "deny",
        grep: "deny",
        list: "deny",
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
        skill: skillAccess("aria-wiki-lookup", "aria-wiki-archive", "aria-wiki-compile"),
        external_directory: externalDirScope,
    };
}
const NON_CODER_ROLES = Object.keys(ROLE_PERMISSIONS);
function agentDefinitions(config, worktree) {
    const taskPermissions = {
        "*": "deny",
        explorer: "allow",
        visualizer: "allow",
        planner: "allow",
        architect: "allow",
        implementer: "allow",
        reviewer: "allow",
        researcher: "allow",
        "archivist": "allow",
    };
    const definitions = {
        coder: {
            description: "Coordinates planning, implementation, and review.",
            mode: config.roles.coder.mode,
            model: config.roles.coder.model,
            ...(config.roles.coder.variant ? { variant: config.roles.coder.variant } : {}),
            prompt: config.roles.coder.promptText,
            permission: {
                ...REQUIRED_MCP_PERMISSION,
                edit: "deny",
                bash: "deny",
                task: taskPermissions,
                plan: "allow",
            },
        },
    };
    for (const role of NON_CODER_ROLES) {
        const roleConfig = config.roles[role];
        definitions[role] = {
            description: role === "writer"
                ? "Primary scientific, academic, and professional writing agent."
                : role === "researcher"
                    ? "Direct or delegated specialist for external literature and evidence research."
                    : role === "archivist"
                        ? "Direct or delegated specialist for curated Wiki lookup and maintenance."
                        : `${role} coding specialist for ARIA Review-Driven Coding.`,
            mode: roleConfig.mode,
            model: roleConfig.model,
            ...(roleConfig.variant ? { variant: roleConfig.variant } : {}),
            prompt: roleConfig.promptText,
            permission: role === "archivist"
                ? buildArchivistPermissions(worktree)
                : ROLE_PERMISSIONS[role],
        };
    }
    return definitions;
}
export const ariaPlugin = async (input, options = {}) => {
    const directory = projectDirectory(input);
    const config = resolveAriaConfig(directory, pluginOptions(options));
    return {
        config: async (runtimeConfig) => {
            runtimeConfig.agent ??= {};
            Object.assign(runtimeConfig.agent, agentDefinitions(config, directory));
            // These fields are supported by OpenCode 1.18.16 but are newer than the
            // @opencode-ai/plugin SDK version currently used for ARIA's compile-time types.
            const extendedConfig = runtimeConfig;
            // Package-owned skills stay version-locked to the loaded ARIA package.
            // OpenCode discovers ARIA and RDC skills directly from this additional root.
            extendedConfig.skills ??= {};
            extendedConfig.skills.paths ??= [];
            if (!extendedConfig.skills.paths.includes(PACKAGE_SKILLS_ROOT)) {
                extendedConfig.skills.paths.push(PACKAGE_SKILLS_ROOT);
            }
        },
        tool: {
            plan: tool({
                description: "Read or update the shared project plan in .aria/rdc/TASKS.md.",
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
                    if (error)
                        return formatToolError(error);
                    const ok = (output) => ({ title, output });
                    try {
                        switch (args.action) {
                            case "get": {
                                const active = await readActivePlan(directory);
                                return ok(formatPlanOutput(active?.plan ?? null));
                            }
                            case "create": {
                                if (!args.title || !args.tasks)
                                    return formatToolError("title and tasks are required for create");
                                return ok(formatPlanOutput(await createPlan(directory, args.title, args.tasks, context.abort)));
                            }
                            case "replace": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for replace");
                                if (args.expectedRevision === undefined) {
                                    return formatToolError("expectedRevision is required for replace");
                                }
                                if (!args.title || !args.tasks)
                                    return formatToolError("title and tasks are required for replace");
                                return ok(formatPlanOutput(await replacePlan(directory, args.expectedPlanID, args.expectedRevision, args.title, args.tasks, context.abort)));
                            }
                            case "add": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for add");
                                if (args.expectedRevision === undefined)
                                    return formatToolError("expectedRevision is required for add");
                                if (!args.tasks)
                                    return formatToolError("tasks are required for add");
                                return ok(formatPlanOutput(await addPlanTasks(directory, args.expectedPlanID, args.expectedRevision, args.tasks, context.abort)));
                            }
                            case "remediate": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for remediate");
                                if (args.expectedRevision === undefined)
                                    return formatToolError("expectedRevision is required for remediate");
                                if (!args.tasks)
                                    return formatToolError("tasks are required for remediate");
                                return ok(formatPlanOutput(await remediatePlanTasks(directory, args.expectedPlanID, args.expectedRevision, args.tasks, context.abort)));
                            }
                            case "update": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for update");
                                if (args.expectedRevision === undefined)
                                    return formatToolError("expectedRevision is required for update");
                                if (!args.taskID || !args.status)
                                    return formatToolError("taskID and status are required for update");
                                return ok(formatPlanOutput(await updatePlanTask(directory, args.expectedPlanID, args.expectedRevision, args.taskID, args.status, args.evidence, context.abort)));
                            }
                            case "approve": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for approve");
                                if (args.expectedRevision === undefined)
                                    return formatToolError("expectedRevision is required for approve");
                                return ok(formatPlanOutput(await approvePlan(directory, args.expectedPlanID, args.expectedRevision, context.abort)));
                            }
                            case "close": {
                                if (!args.expectedPlanID)
                                    return formatToolError("expectedPlanID is required for close");
                                if (args.expectedRevision === undefined)
                                    return formatToolError("expectedRevision is required for close");
                                const closed = await closePlan(directory, args.expectedPlanID, args.expectedRevision, context.abort);
                                return ok(formatClosedPlanOutput(closed.plan, closed.archived));
                            }
                            default:
                                return formatToolError(`Unknown plan action: ${String(args.action)}`);
                        }
                    }
                    catch (caught) {
                        return formatToolError(caught instanceof Error ? caught.message : String(caught));
                    }
                },
            }),
        },
    };
};
//# sourceMappingURL=register.js.map