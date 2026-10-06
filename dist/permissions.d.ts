import type { RoleName } from "./types.js";
export interface AgentRule {
    action: string;
    resource: string;
    effect: "allow" | "deny" | "ask";
}
/**
 * Scoped archivist Rule[] for runtime use when `WIKI_DIR` is set.
 *
 * V2 path semantics (opencode.ai/v2/docs/permissions Actions + Directories):
 * `read`/`edit` take Location-relative internal paths or canonical absolute
 * external paths; `external_directory` stays absolute. External wiki/pipeline
 * roots therefore scope as absolute paths (repro `/tmp/aria-wiki/page.md`
 * denied under the old worktree-relative scope), internal roots as
 * worktree-relative paths. `shell` uses the absolute python pipeline
 * allowlist (never `python *`). Returns the deny-by-default base when
 * `WIKI_DIR` is absent.
 */
export declare function getArchivistScopedPermissions(worktree: string): AgentRule[];
/**
 * Canonical V2 Rule[] per role, ordered last-match-wins.
 *
 * Every role starts with an explicit `{action:"*",resource:"*",effect:"ask"}`
 * fallback (first position) overriding the native builtin allow-all; later
 * specific rules still prevail. Archivist here is the unscoped
 * deny-by-default base for managed files; use
 * `getArchivistScopedPermissions(worktree)` at runtime when `WIKI_DIR` is
 * set. No legacy `bash`/`task`/`plan`/`todowrite`/`list`/`lsp`/`doom_loop`
 * actions are emitted.
 */
export declare function getPermissionsForRole(role: RoleName): AgentRule[];
/**
 * 2.0.23-style evaluator for tests: last matching rule wins
 * (`Array.findLast`-equivalent reverse scan); no match falls back to `ask`
 * ("If no rule matches, OpenCode uses `ask`"). Supports `*` wildcards in
 * both fields (including `prefix_*` MCP actions and glob-like resources).
 */
export declare function evaluatePermission(rules: readonly AgentRule[], action: string, resource: string): "allow" | "deny" | "ask";
interface ExperimentalDepthConfig {
    experimental?: {
        subagent_depth?: number | null | undefined;
    } | undefined;
}
/**
 * Desired default `experimental.subagent_depth: 3` only when absent.
 *
 * Preserves every explicit value including 0/1/2/>=3 (and only fills
 * `undefined`/`null`); never emits top-level `subagent_depth` (V1 key).
 * Runtime wiring of this default is T008 work; this helper is the
 * canonical T004 source with ordering-free semantics.
 */
export declare function applyExperimentalSubagentDepthDefault<T extends ExperimentalDepthConfig>(config: T): T;
export {};
//# sourceMappingURL=permissions.d.ts.map