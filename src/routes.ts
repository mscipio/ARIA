import { resolveAriaConfig } from "./overrides.js";
import type { RoleName } from "./types.js";

/**
 * Canonical defaults-ordered role list. Single source for route derivation,
 * shared by `aria models` and the read-only doctor.
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
 * the single canonical derivation shared by `aria models` and doctor.
 */
export function deriveRoutes(worktree: string = process.cwd()): ResolvedRoute[] {
  const config = resolveAriaConfig(worktree);
  return ROLES.map((role) => ({
    role,
    model: config.roles[role].model,
    variant: config.roles[role].variant,
  }));
}

/**
 * Compact role/model/effort table from the existing resolved routes. The
 * effort column is the resolved variant (`-` when the route carries none),
 * so representative output always reflects the resolved configuration.
 */
export function formatRoutes(worktree: string = process.cwd()): string {
  const lines = ["role  model  effort"];
  for (const route of deriveRoutes(worktree)) {
    lines.push(`${route.role}  ${route.model}  ${route.variant ?? "-"}`);
  }
  return lines.join("\n");
}
