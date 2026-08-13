import { resolveAriaConfig } from "./overrides.js";
import type { RoleName } from "./types.js";

const ROLES: RoleName[] = [
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

function variantText(variant: string | undefined): string {
  return variant ? ` (${variant})` : "";
}

export function formatRoutes(worktree: string = process.cwd()): string {
  const config = resolveAriaConfig(worktree);
  const lines = ["Resolved ARIA role routes:"];
  for (const role of ROLES) {
    const roleConfig = config.roles[role];
    lines.push(`${role}  ${roleConfig.model}${variantText(roleConfig.variant)}`);
  }
  return lines.join("\n");
}