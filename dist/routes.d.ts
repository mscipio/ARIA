import type { RoleName } from "./types.js";
/**
 * Canonical defaults-ordered role list. Single source for route derivation,
 * shared by `aria models` and the read-only doctor.
 */
export declare const ROLES: RoleName[];
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
export declare function deriveRoutes(worktree?: string): ResolvedRoute[];
/**
 * Compact role/model/effort table from the existing resolved routes. The
 * effort column is the resolved variant (`-` when the route carries none),
 * so representative output always reflects the resolved configuration.
 */
export declare function formatRoutes(worktree?: string): string;
//# sourceMappingURL=routes.d.ts.map