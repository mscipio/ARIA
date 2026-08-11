import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
const ROLES = [
    "director",
    "explorer",
    "visualizer",
    "planner",
    "architect",
    "implementer",
    "reviewer",
];
const ROLE_SET = new Set(ROLES);
const ROLE_OVERRIDE_FIELDS = new Set(["model", "variant"]);
const SHARED_MCP_GUIDANCE = `## MCP Guidance

Use any available MCP whenever it materially improves the evidence; these are preferred evidence sources, not exclusive routing. Do not force unnecessary calls.
- CodeGraph provides codebase intelligence for structure, symbols and references, dependencies, impact, and locating paths.
- Context7 provides current, version-specific external library, framework, and API documentation plus supported interfaces; use it instead of guessing external behavior.
- Engram provides durable semantic/project memory for prior decisions, investigations, conventions, history, continuity, and useful durable discoveries or decisions. All roles may read or write it when useful.
- Engram is not authoritative transactional workflow state. It must not approve plans, change task status or scope, replace .code-ensemble/TASKS.md, or bypass the Plan tool's CAS/revision/approval checks. .code-ensemble/TASKS.md and the Plan tool remain authoritative for active plan, task, scope, and approval state.`;
function withMcpGuidance(promptText) {
    const normalized = promptText.trimEnd();
    const returnMarker = "\nReturn:\n";
    if (normalized.includes(returnMarker)) {
        return `${normalized.replace(returnMarker, `\n${SHARED_MCP_GUIDANCE}\n\nReturn:\n`)}\n`;
    }
    return `${normalized}\n\n${SHARED_MCP_GUIDANCE}\n`;
}
class ConfigValidationError extends Error {
    constructor(filePath, path, got, want) {
        super(`${filePath}: ${path}: expected ${want}, got ${typeOf(got)}`);
        this.name = "ConfigValidationError";
    }
}
function typeOf(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
function parseJSON(text, filePath) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw new SyntaxError(`${filePath}: ${error.message}`);
        }
        throw error;
    }
}
function fail(filePath, path, got, want) {
    throw new ConfigValidationError(filePath, path, got, want);
}
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isModelIdentifier(value) {
    return isString(value) && /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value);
}
export function parseOverrides(raw, filePath = "review-driven-code.json") {
    if (!isObject(raw))
        fail(filePath, "(root)", raw, "object");
    const rootKeys = Object.keys(raw);
    if (rootKeys.length > 1 || (rootKeys.length === 1 && rootKeys[0] !== "roles")) {
        fail(filePath, "(root)", rootKeys.join(", "), "'roles'");
    }
    const rolesValue = raw.roles;
    if (rolesValue === undefined)
        return {};
    if (!isObject(rolesValue))
        fail(filePath, "roles", rolesValue, "object");
    const roles = {};
    for (const [key, value] of Object.entries(rolesValue)) {
        if (!ROLE_SET.has(key))
            fail(filePath, `roles.${key}`, key, "valid role");
        if (!isObject(value))
            fail(filePath, `roles.${key}`, value, "object");
        const roleKeys = Object.keys(value);
        for (const field of roleKeys) {
            if (!ROLE_OVERRIDE_FIELDS.has(field)) {
                fail(filePath, `roles.${key}.${field}`, field, "'model' or 'variant'");
            }
        }
        const override = {};
        const rawRole = value;
        if ("model" in rawRole) {
            if (!isModelIdentifier(rawRole.model)) {
                fail(filePath, `roles.${key}.model`, rawRole.model, "model identifier in provider/model format");
            }
            override.model = rawRole.model;
        }
        if ("variant" in rawRole) {
            if (!isString(rawRole.variant)) {
                fail(filePath, `roles.${key}.variant`, rawRole.variant, "non-empty string");
            }
            override.variant = rawRole.variant;
        }
        roles[key] = override;
    }
    return { roles };
}
function formatRoutingVariant(variant) {
    return variant ? ` [${variant}]` : "";
}
function generateRouting(resolved) {
    return ROLES.map((role) => {
        const config = resolved.roles[role];
        return `- ${role}: \`${role}\` → ${config.model}${formatRoutingVariant(config.variant)}`;
    }).join("\n");
}
export function resolveReviewDrivenCodeConfig(worktree, options = {}, metaUrl = import.meta.url) {
    const defaults = loadDefaultConfig(metaUrl);
    const packageRoot = getPackageRoot(metaUrl);
    // Global config (optional) — per-user overrides in ~/.config/opencode/review-driven-code.json
    const globalPath = resolve(homedir(), ".config", "opencode", "review-driven-code.json");
    const globalOverrides = existsSync(globalPath)
        ? parseOverrides(parseJSON(readFileSync(globalPath, "utf8"), globalPath), globalPath)
        : {};
    // Project config — explicit or auto-discovered review-driven-code.json
    const explicitPath = options.configPath ? resolve(worktree, options.configPath) : undefined;
    const discoveredPath = resolve(worktree, "review-driven-code.json");
    const overridePath = explicitPath ?? (existsSync(discoveredPath) ? discoveredPath : undefined);
    const overrides = overridePath && existsSync(overridePath)
        ? parseOverrides(parseJSON(readFileSync(overridePath, "utf8"), overridePath), overridePath)
        : {};
    const roles = Object.fromEntries(ROLES.map((role) => {
        const roleDefaults = defaults.roles[role];
        const globalOverride = globalOverrides.roles?.[role];
        const projectOverride = overrides.roles?.[role];
        return [role, {
                ...roleDefaults,
                model: projectOverride?.model ?? globalOverride?.model ?? roleDefaults.model,
                variant: projectOverride?.variant ?? globalOverride?.variant ?? roleDefaults.variant,
                promptText: withMcpGuidance(readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")),
            }];
    }));
    roles.director.promptText = roles.director.promptText.replace("{{routing}}", generateRouting({ roles }));
    return { roles };
}
export { ConfigValidationError };
//# sourceMappingURL=overrides.js.map