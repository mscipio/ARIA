import { resolveAriaConfig } from "./overrides.js";
import type { RoleName } from "./types.js";

/**
 * Canonical defaults-ordered role list. Single source for route derivation,
 * shared by `aria routes` and the read-only doctor.
 */
export const ROLES: RoleName[] = [
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
  "scientist",
];

/** A structured resolved route for one role. */
export interface ResolvedRoute {
  role: RoleName;
  model: string;
  variant?: string;
}

/**
 * Defaults-ordered eleven-role route derivation. The layer precedence and
 * model/variant pair resolution live in `resolveAriaConfig`; this helper is
 * the single canonical derivation shared by `aria routes` and doctor.
 */
export function deriveRoutes(worktree: string = process.cwd()): ResolvedRoute[] {
  const config = resolveAriaConfig(worktree);
  return ROLES.map((role) => ({
    role,
    model: config.roles[role].model,
    variant: config.roles[role].variant,
  }));
}

function variantText(variant: string | undefined): string {
  return variant ? ` (${variant})` : "";
}

export function formatRoutes(worktree: string = process.cwd()): string {
  const lines = ["Resolved ARIA role routes:"];
  for (const route of deriveRoutes(worktree)) {
    lines.push(`${route.role}  ${route.model}${variantText(route.variant)}`);
  }
  return lines.join("\n");
}
