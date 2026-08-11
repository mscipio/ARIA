import { resolveReviewDrivenCodeConfig } from "./overrides.js";
const ROLES = [
    "director",
    "explorer",
    "visualizer",
    "planner",
    "architect",
    "implementer",
    "reviewer",
    "wiki-compiler",
];
function variantText(variant) {
    return variant ? ` (${variant})` : "";
}
export function formatRoutes(worktree = process.cwd()) {
    const config = resolveReviewDrivenCodeConfig(worktree);
    const lines = ["Resolved RDC role routes:"];
    for (const role of ROLES) {
        const roleConfig = config.roles[role];
        lines.push(`${role}  ${roleConfig.model}${variantText(roleConfig.variant)}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=routes.js.map