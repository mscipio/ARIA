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
function parseMap(value, path, valid, parse) {
    if (value === undefined)
        return undefined;
    if (!isObject(value))
        fail(path, value, "object");
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (!valid.has(key))
            fail(`${path}.${key}`, key, "valid role");
        result[key] = parse(item, `${path}.${key}`);
    }
    return result;
}
export function parseOverrides(raw) {
    if (!isObject(raw))
        fail("(root)", raw, "object");
    const allowed = new Set(["models", "variants"]);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key))
            fail(key, raw[key], "models or variants");
    }
    const parseModel = (value, path) => isModelIdentifier(value) ? value : fail(path, value, "model identifier in provider/model format");
    const parseVariant = (value, path) => isString(value) ? value : fail(path, value, "string");
    const models = parseMap(raw.models, "models", ROLE_SET, parseModel);
    const variants = parseMap(raw.variants, "variants", ROLE_SET, parseVariant);
    return {
        ...(models ? { models } : {}),
        ...(variants ? { variants } : {}),
    };
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
        return [role, {
                ...roleDefaults,
                model: overrides.models?.[role] ?? roleDefaults.model,
                variant: overrides.variants?.[role] ?? roleDefaults.variant,
                promptText: readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8"),
            }];
    }));
    roles.director.promptText = roles.director.promptText.replace("{{routing}}", ROLES.filter((role) => role !== "director").map((role) => `- ${role}: \`${role}\``).join("\n"));
    return { roles };
}
export { ConfigValidationError };
//# sourceMappingURL=overrides.js.map