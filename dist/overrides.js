import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
const ROLES = [
    "coder",
    "explorer",
    "visualizer",
    "planner",
    "architect",
    "implementer",
    "reviewer",
    "researcher",
    "archivist",
    "writer",
];
const ROLE_SET = new Set(ROLES);
const LEGACY_ROLE_ALIASES = {
    director: "coder",
    "wiki-compiler": "archivist",
};
const ROLE_OVERRIDE_FIELDS = new Set(["model", "variant"]);
const SHARED_MCP_GUIDANCE = `## MCP Guidance

Use any available MCP whenever it materially improves the evidence; these are preferred evidence sources, not exclusive routing. Do not force unnecessary calls.
- CodeGraph provides codebase intelligence for structure, symbols and references, dependencies, impact, and locating paths.
- Context7 provides current, version-specific external library, framework, and API documentation plus supported interfaces; use it instead of guessing external behavior.
- Engram provides durable semantic/project memory for prior decisions, investigations, conventions, history, continuity, and useful durable discoveries or decisions. Use it only within the selected role's explicit permissions and boundaries.
- Engram is not authoritative transactional workflow state. It must not approve plans, change task status or scope, replace .aria/rdc/TASKS.md, or bypass the Plan tool's CAS/revision/approval checks. .aria/rdc/TASKS.md and the Plan tool remain authoritative for active plan, task, scope, and approval state.`;
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
export function parseOverrides(raw, filePath = "aria.json") {
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
        const role = ROLE_SET.has(key) ? key : LEGACY_ROLE_ALIASES[key];
        if (!role)
            fail(filePath, `roles.${key}`, key, "valid role");
        if (roles[role]) {
            fail(filePath, `roles.${key}`, key, `role override not duplicated via alias for ${role}`);
        }
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
        roles[role] = override;
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
/**
 * Canonical global config path: ~/.config/opencode/aria.json first, with the
 * pre-ARIA legacy filename as a read-only fallback. Returns undefined when
 * neither file exists.
 */
export function globalAriaConfigPath() {
    const ariaPath = resolve(homedir(), ".config", "opencode", "aria.json");
    if (existsSync(ariaPath))
        return ariaPath;
    const legacyPath = resolve(homedir(), ".config", "opencode", "review-driven-code.json");
    return existsSync(legacyPath) ? legacyPath : undefined;
}
/**
 * Validated read of the global overrides, or {} when no global config exists.
 */
export function readGlobalAriaOverrides() {
    const globalPath = globalAriaConfigPath();
    return globalPath
        ? parseOverrides(parseJSON(readFileSync(globalPath, "utf8"), globalPath), globalPath)
        : {};
}
/**
 * Validated read of the project-local overrides, or {} when no project config
 * exists. Shared by `resolveAriaConfig` and model configuration so both agree
 * on which project fields are pinned.
 *
 * Path discovery: an explicit `options.configPath` wins; otherwise prefer
 * `aria.json` and fall back to the legacy filename.
 */
export function readProjectAriaOverrides(worktree, options = {}) {
    const explicitPath = options.configPath ? resolve(worktree, options.configPath) : undefined;
    const discoveredAriaPath = resolve(worktree, "aria.json");
    const discoveredLegacyPath = resolve(worktree, "review-driven-code.json");
    const overridePath = explicitPath
        ?? (existsSync(discoveredAriaPath)
            ? discoveredAriaPath
            : (existsSync(discoveredLegacyPath) ? discoveredLegacyPath : undefined));
    return overridePath && existsSync(overridePath)
        ? parseOverrides(parseJSON(readFileSync(overridePath, "utf8"), overridePath), overridePath)
        : {};
}
/**
 * Model-aware resolution of the model/variant pair across override layers
 * (lowest to highest). The pair is owned by the highest layer that specifies
 * `model`: that layer's variant is used when supplied, otherwise the inherited
 * variant is cleared, so a model-only override never keeps a stale variant.
 * A layer that specifies only `variant` inherits the lower model and replaces
 * just the variant.
 */
function resolveRoleRoute(defaults, ...layers) {
    let model = defaults.model;
    let variant = defaults.variant;
    for (const layer of layers) {
        if (!layer)
            continue;
        if (layer.model !== undefined) {
            model = layer.model;
            variant = layer.variant;
        }
        else if (layer.variant !== undefined) {
            variant = layer.variant;
        }
    }
    return { model, variant };
}
export function resolveAriaConfig(worktree, options = {}, metaUrl = import.meta.url) {
    const defaults = loadDefaultConfig(metaUrl);
    const packageRoot = getPackageRoot(metaUrl);
    // Global config: ARIA is canonical; the pre-ARIA filename remains a read-only fallback.
    const globalOverrides = readGlobalAriaOverrides();
    // Project config: explicit path wins; otherwise prefer aria.json and fall back to the legacy filename.
    const overrides = readProjectAriaOverrides(worktree, options);
    const roles = Object.fromEntries(ROLES.map((role) => {
        const roleDefaults = defaults.roles[role];
        const globalOverride = globalOverrides.roles?.[role];
        const projectOverride = overrides.roles?.[role];
        const { model, variant } = resolveRoleRoute(roleDefaults, globalOverride, projectOverride);
        return [role, {
                ...roleDefaults,
                model,
                variant,
                promptText: role === "archivist" || role === "writer" || role === "researcher"
                    ? readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")
                    : withMcpGuidance(readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")),
            }];
    }));
    roles.coder.promptText = roles.coder.promptText.replace("{{routing}}", generateRouting({ roles }));
    // Interpolate package root and WIKI_DIR paths ONLY into the archivist prompt.
    if (roles["archivist"]) {
        const wikiDir = process.env.WIKI_DIR ?? "";
        roles["archivist"].promptText = roles["archivist"].promptText
            .replace(/\{\{packageRoot\}\}/g, packageRoot)
            .replace(/\{\{WIKI_DIR\}\}/g, wikiDir);
        // Ensure missing WIKI_DIR does not block startup: pass empty string.
    }
    return { roles };
}
export { ConfigValidationError };
//# sourceMappingURL=overrides.js.map