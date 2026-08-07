import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
import type {
  ReviewDrivenCodePluginOptions,
  ReviewDrivenCodeProjectOverrides,
  ResolvedReviewDrivenCodeConfig,
  RoleName,
  RoleOverride,
} from "./types.js";

const ROLES: RoleName[] = [
  "director",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
];
const ROLE_SET = new Set<string>(ROLES);
const ROLE_OVERRIDE_FIELDS = new Set(["model", "variant"]);

class ConfigValidationError extends Error {
  constructor(path: string, got: unknown, want: string) {
    super(`review-driven-code.json: ${path}: expected ${want}, got ${typeOf(got)}`);
    this.name = "ConfigValidationError";
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fail(path: string, got: unknown, want: string): never {
  throw new ConfigValidationError(path, got, want);
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

export function parseOverrides(raw: unknown): ReviewDrivenCodeProjectOverrides {
  if (!isObject(raw)) fail("(root)", raw, "object");
  const rootKeys = Object.keys(raw);
  if (rootKeys.length > 1 || (rootKeys.length === 1 && rootKeys[0] !== "roles")) {
    fail("(root)", rootKeys.join(", "), "'roles'");
  }

  const rolesValue = (raw as Record<string, unknown>).roles;
  if (rolesValue === undefined) return {};
  if (!isObject(rolesValue)) fail("roles", rolesValue, "object");

  const roles: Partial<Record<RoleName, RoleOverride>> = {};
  for (const [key, value] of Object.entries(rolesValue)) {
    if (!ROLE_SET.has(key)) fail(`roles.${key}`, key, "valid role");
    if (!isObject(value)) fail(`roles.${key}`, value, "object");

    const roleKeys = Object.keys(value);
    for (const field of roleKeys) {
      if (!ROLE_OVERRIDE_FIELDS.has(field)) {
        fail(`roles.${key}.${field}`, field, "'model' or 'variant'");
      }
    }

    const override: RoleOverride = {};
    const rawRole = value as Record<string, unknown>;
    if ("model" in rawRole) {
      if (!isModelIdentifier(rawRole.model)) {
        fail(`roles.${key}.model`, rawRole.model, "model identifier in provider/model format");
      }
      override.model = rawRole.model as string;
    }
    if ("variant" in rawRole) {
      if (!isString(rawRole.variant)) {
        fail(`roles.${key}.variant`, rawRole.variant, "non-empty string");
      }
      override.variant = rawRole.variant as string;
    }
    roles[key as RoleName] = override;
  }

  return { roles };
}

function formatRoutingVariant(variant: string | undefined): string {
  return variant ? ` [${variant}]` : "";
}

function generateRouting(resolved: ResolvedReviewDrivenCodeConfig): string {
  return ROLES.map((role) => {
    const config = resolved.roles[role];
    return `- ${role}: \`${role}\` → ${config.model}${formatRoutingVariant(config.variant)}`;
  }).join("\n");
}

export function resolveReviewDrivenCodeConfig(
  worktree: string,
  options: ReviewDrivenCodePluginOptions = {},
  metaUrl: string = import.meta.url,
): ResolvedReviewDrivenCodeConfig {
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
      promptText: readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8"),
    }];
  })) as ResolvedReviewDrivenCodeConfig["roles"];

  roles.director.promptText = roles.director.promptText.replace(
    "{{routing}}",
    generateRouting({ roles }),
  );

  return { roles };
}

export { ConfigValidationError };
