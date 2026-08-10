import { existsSync, readFileSync } from "node:fs";
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
    constructor(path, got, want) {
        super(`review-driven-code.json: ${path}: expected ${want}, got ${typeOf(got)}`);
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
function fail(path, got, want) {
    throw new ConfigValidationError(path, got, want);
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
export function parseOverrides(raw) {
    if (!isObject(raw))
        fail("(root)", raw, "object");
    const rootKeys = Object.keys(raw);
    if (rootKeys.length > 1 || (rootKeys.length === 1 && rootKeys[0] !== "roles")) {
        fail("(root)", rootKeys.join(", "), "'roles'");
    }
    const rolesValue = raw.roles;
    if (rolesValue === undefined)
        return {};
    if (!isObject(rolesValue))
        fail("roles", rolesValue, "object");
    const roles = {};
    for (const [key, value] of Object.entries(rolesValue)) {
        if (!ROLE_SET.has(key))
            fail(`roles.${key}`, key, "valid role");
        if (!isObject(value))
            fail(`roles.${key}`, value, "object");
        const roleKeys = Object.keys(value);
        for (const field of roleKeys) {
            if (!ROLE_OVERRIDE_FIELDS.has(field)) {
                fail(`roles.${key}.${field}`, field, "'model' or 'variant'");
            }
        }
        const override = {};
        const rawRole = value;
        if ("model" in rawRole) {
            if (!isModelIdentifier(rawRole.model)) {
                fail(`roles.${key}.model`, rawRole.model, "model identifier in provider/model format");
            }
            override.model = rawRole.model;
        }
        if ("variant" in rawRole) {
            if (!isString(rawRole.variant)) {
                fail(`roles.${key}.variant`, rawRole.variant, "non-empty string");
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
    const explicitPath = options.configPath ? resolve(worktree, options.configPath) : undefined;
    const discoveredPath = resolve(worktree, "review-driven-code.json");
    const overridePath = explicitPath ?? (existsSync(discoveredPath) ? discoveredPath : undefined);
    const overrides = overridePath && existsSync(overridePath)
        ? parseOverrides(JSON.parse(readFileSync(overridePath, "utf8")))
        : {};
    const roles = Object.fromEntries(ROLES.map((role) => {
        const roleDefaults = defaults.roles[role];
        const override = overrides.roles?.[role];
        return [role, {
                ...roleDefaults,
                model: override?.model ?? roleDefaults.model,
                variant: override?.variant ?? roleDefaults.variant,
                promptText: withMcpGuidance(readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")),
            }];
    }));
    roles.director.promptText = roles.director.promptText.replace("{{routing}}", generateRouting({ roles }));
    return { roles };
}
export { ConfigValidationError };
//# sourceMappingURL=overrides.js.map