import { resolveAriaConfig } from "./overrides.js";
/**
 * Canonical defaults-ordered role list. Single source for route derivation,
 * shared by `aria routes` and the read-only doctor.
 */
export const ROLES = [
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
/**
 * Defaults-ordered ten-role route derivation. The layer precedence and
 * model/variant pair resolution live in `resolveAriaConfig`; this helper is
 * the single canonical derivation shared by `aria routes` and doctor.
 */
export function deriveRoutes(worktree = process.cwd()) {
    const config = resolveAriaConfig(worktree);
    return ROLES.map((role) => ({
        role,
        model: config.roles[role].model,
        variant: config.roles[role].variant,
    }));
}
function variantText(variant) {
    return variant ? ` (${variant})` : "";
}
export function formatRoutes(worktree = process.cwd()) {
    const lines = ["Resolved ARIA role routes:"];
    for (const route of deriveRoutes(worktree)) {
        lines.push(`${route.role}  ${route.model}${variantText(route.variant)}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=routes.js.map