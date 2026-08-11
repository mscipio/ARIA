import { resolveReviewDrivenCodeConfig } from "./overrides.js";
import type { RoleName } from "./types.js";

const ROLES: RoleName[] = [
  "director",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
];

function variantText(variant: string | undefined): string {
  return variant ? ` (${variant})` : "";
}

export function formatRoutes(worktree: string = process.cwd()): string {
  const config = resolveReviewDrivenCodeConfig(worktree);
  const lines = ["Resolved RDC role routes:"];
  for (const role of ROLES) {
    const roleConfig = config.roles[role];
    lines.push(`${role}  ${roleConfig.model}${variantText(roleConfig.variant)}`);
  }
  return lines.join("\n");
}