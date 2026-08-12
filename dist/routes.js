import { resolveAriaConfig } from "./overrides.js";
const ROLES = [
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
function variantText(variant) {
    return variant ? ` (${variant})` : "";
}
export function formatRoutes(worktree = process.cwd()) {
    const config = resolveAriaConfig(worktree);
    const lines = ["Resolved ARIA role routes:"];
    for (const role of ROLES) {
        const roleConfig = config.roles[role];
        lines.push(`${role}  ${roleConfig.model}${variantText(roleConfig.variant)}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=routes.js.map