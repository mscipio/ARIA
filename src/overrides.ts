import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
import type {
  AriaPluginOptions,
  AriaProjectOverrides,
  ResolvedAriaConfig,
  RoleName,
  RoleOverride,
} from "./types.js";

const ROLES: RoleName[] = [
  "coder",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "archivist",
  "writer",
];
const ROLE_SET = new Set<string>(ROLES);
const LEGACY_ROLE_ALIASES: Record<string, RoleName> = {
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

function withMcpGuidance(promptText: string): string {
  const normalized = promptText.trimEnd();
  const returnMarker = "\nReturn:\n";
  if (normalized.includes(returnMarker)) {
    return `${normalized.replace(returnMarker, `\n${SHARED_MCP_GUIDANCE}\n\nReturn:\n`)}\n`;
  }
  return `${normalized}\n\n${SHARED_MCP_GUIDANCE}\n`;
}

class ConfigValidationError extends Error {
  constructor(filePath: string, path: string, got: unknown, want: string) {
    super(`${filePath}: ${path}: expected ${want}, got ${typeOf(got)}`);
    this.name = "ConfigValidationError";
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseJSON(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function fail(filePath: string, path: string, got: unknown, want: string): never {
  throw new ConfigValidationError(filePath, path, got, want);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelIdentifier(value: unknown): value is string {
  return isString(value) && /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value);
}

export function parseOverrides(raw: unknown, filePath = "aria.json"): AriaProjectOverrides {
  if (!isObject(raw)) fail(filePath, "(root)", raw, "object");
  const rootKeys = Object.keys(raw);
  if (rootKeys.length > 1 || (rootKeys.length === 1 && rootKeys[0] !== "roles")) {
    fail(filePath, "(root)", rootKeys.join(", "), "'roles'");
  }

  const rolesValue = (raw as Record<string, unknown>).roles;
  if (rolesValue === undefined) return {};
  if (!isObject(rolesValue)) fail(filePath, "roles", rolesValue, "object");

  const roles: Partial<Record<RoleName, RoleOverride>> = {};
  for (const [key, value] of Object.entries(rolesValue)) {
    const role = ROLE_SET.has(key) ? key as RoleName : LEGACY_ROLE_ALIASES[key];
    if (!role) fail(filePath, `roles.${key}`, key, "valid role");
    if (roles[role]) {
      fail(filePath, `roles.${key}`, key, `role override not duplicated via alias for ${role}`);
    }
    if (!isObject(value)) fail(filePath, `roles.${key}`, value, "object");

    const roleKeys = Object.keys(value);
    for (const field of roleKeys) {
      if (!ROLE_OVERRIDE_FIELDS.has(field)) {
        fail(filePath, `roles.${key}.${field}`, field, "'model' or 'variant'");
      }
    }

    const override: RoleOverride = {};
    const rawRole = value as Record<string, unknown>;
    if ("model" in rawRole) {
      if (!isModelIdentifier(rawRole.model)) {
        fail(filePath, `roles.${key}.model`, rawRole.model, "model identifier in provider/model format");
      }
      override.model = rawRole.model as string;
    }
    if ("variant" in rawRole) {
      if (!isString(rawRole.variant)) {
        fail(filePath, `roles.${key}.variant`, rawRole.variant, "non-empty string");
      }
      override.variant = rawRole.variant as string;
    }
    roles[role] = override;
  }

  return { roles };
}

function formatRoutingVariant(variant: string | undefined): string {
  return variant ? ` [${variant}]` : "";
}

function generateRouting(resolved: ResolvedAriaConfig): string {
  return ROLES.map((role) => {
    const config = resolved.roles[role];
    return `- ${role}: \`${role}\` → ${config.model}${formatRoutingVariant(config.variant)}`;
  }).join("\n");
}

export function resolveAriaConfig(
  worktree: string,
  options: AriaPluginOptions = {},
  metaUrl: string = import.meta.url,
): ResolvedAriaConfig {
  const defaults = loadDefaultConfig(metaUrl);
  const packageRoot = getPackageRoot(metaUrl);

  // Global config: ARIA is canonical; the pre-ARIA filename remains a read-only fallback.
  const globalAriaPath = resolve(homedir(), ".config", "opencode", "aria.json");
  const globalLegacyPath = resolve(homedir(), ".config", "opencode", "review-driven-code.json");
  const globalPath = existsSync(globalAriaPath)
    ? globalAriaPath
    : (existsSync(globalLegacyPath) ? globalLegacyPath : undefined);
  const globalOverrides = globalPath
    ? parseOverrides(parseJSON(readFileSync(globalPath, "utf8"), globalPath), globalPath)
    : {};

  // Project config: explicit path wins; otherwise prefer aria.json and fall back to the legacy filename.
  const explicitPath = options.configPath ? resolve(worktree, options.configPath) : undefined;
  const discoveredAriaPath = resolve(worktree, "aria.json");
  const discoveredLegacyPath = resolve(worktree, "review-driven-code.json");
  const overridePath = explicitPath
    ?? (existsSync(discoveredAriaPath)
      ? discoveredAriaPath
      : (existsSync(discoveredLegacyPath) ? discoveredLegacyPath : undefined));
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
      promptText: role === "archivist" || role === "writer"
        ? readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")
        : withMcpGuidance(readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8")),
    }];
  })) as ResolvedAriaConfig["roles"];

  roles.coder.promptText = roles.coder.promptText.replace(
    "{{routing}}",
    generateRouting({ roles }),
  );

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
