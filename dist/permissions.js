import { isAbsolute, join, relative } from "node:path";
import { getPackageRoot } from "./defaults.js";
/**
 * T004 — Canonical V2 permission/model/delegation parity source.
 *
 * V1 (`src/register.ts`) grouped effects by tool (`permission: { bash: ... }`);
 * V2 uses one ordered `permissions: Rule[]` where the last matching rule wins
 * (opencode.ai/v2/docs/agents, opencode.ai/v2/docs/permissions, and
 * `@opencode/schema@2.0.23` `Session.Info` field doc: "Evaluated after the
 * agent's rules; the last matching rule wins."). Construction below is
 * intentional: broad rules precede exceptions, deny follows broader allows
 * where deny must prevail (e.g. `read * allow` then `read *.env ask`), and
 * allow follows deny where allow must prevail (e.g. `read *.env.* ask` then
 * `read *.env.example allow`). Never assume inherent deny precedence.
 *
 * V1→V2 renames (opencode.ai/v2/docs/migrate-v1: "`bash` is now `shell`,
 * `task` is now `subagent`, and `write` and `patch` are now `edit`"):
 * `bash`→`shell`, `task`→`subagent`. Explicit MCP/tool actions keep their
 * `<server>_<tool>` form with resource `*` (opencode.ai/v2/docs/tools,
 * opencode.ai/v2/docs/mcp-servers). Never emit legacy `bash`/`task`/`plan`/
 * `todowrite` (nor `list`/`lsp`/`doom_loop`, where `lsp`/`doom_loop` are
 * explicitly "not current V2 Core permission actions" per
 * opencode.ai/v2/docs/permissions) without 2.0.23 evidence.
 *
 * Native evaluation merges the permissive 2.0.23 builtin
 * (`Agent.Info.default`: `{action:"*",resource:"*",effect:"allow"}` first,
 * then external/`.env` asks) with the configured agent rules appended after
 * (`core/agent.ts` `Info.default()` + `config/plugin/agent.ts` push at
 * 0fd7e282). Under last-match-wins an unmatched action would therefore fall
 * through to the builtin allow-all (repro: scientist `engram_mem_save` or an
 * unknown action evaluates to `allow` merged but `ask` isolated). Every role
 * below therefore emits an explicit first-position
 * `{action:"*",resource:"*",effect:"ask"}` fallback: it sits after the
 * builtin allow-all so it overrides the native default for unmatched
 * operations, while every later specific rule still overrides it (so no
 * intended allow/deny is shadowed and no later blanket allow is emitted).
 * Every security-relevant field stays explicit per agent so denied
 * specialist MCP boundaries are preserved.
 */
// Verified ZotPilot MCP inventory (same 22 IDs as V1 `src/register.ts`,
// zotpilot 0.5.3 live tools/list 2026-08-13): 14 research/read (allow) and
// 8 mutation (ask). No wildcard grant; unlisted tools fall back to ask.
const ZOTPILOT_READ = [
    "zotpilot_search_papers",
    "zotpilot_search_topic",
    "zotpilot_search_boolean",
    "zotpilot_search_formulas",
    "zotpilot_advanced_search",
    "zotpilot_search_academic_databases",
    "zotpilot_browse_library",
    "zotpilot_get_paper_details",
    "zotpilot_get_notes",
    "zotpilot_get_annotations",
    "zotpilot_get_citations",
    "zotpilot_get_passage_context",
    "zotpilot_get_index_stats",
    "zotpilot_get_paper_for_tutor",
];
const ZOTPILOT_MUTATION = [
    "zotpilot_index_library",
    "zotpilot_index_formulas",
    "zotpilot_ingest_by_identifiers",
    "zotpilot_create_note",
    "zotpilot_manage_tags",
    "zotpilot_manage_collections",
    "zotpilot_annotate_pdf",
    "zotpilot_save_reading_persona",
];
/**
 * Explicit first-position fallback overriding the native builtin allow-all.
 * Placed before every specific rule so later allows/denies still prevail
 * under last-match-wins; never emit a later blanket allow.
 */
function fallbackAskRule() {
    return { action: "*", resource: "*", effect: "ask" };
}
/**
 * V2 path semantics (opencode.ai/v2/docs/permissions Actions + Directories):
 * `read`/`edit` resources are Location-relative internal paths or canonical
 * absolute external paths; a path outside both the active Location and its
 * non-root project worktree needs `external_directory` approval first.
 * External targets therefore scope as canonical absolute paths, internal
 * targets as worktree-relative paths. Backslashes are normalized to slashes
 * (matching is whole-value `*`/`?` wildcards).
 */
function scopeBase(worktree, target) {
    const normalizedTarget = target.replaceAll("\\", "/");
    const rel = relative(worktree, target).replaceAll("\\", "/");
    if (rel === "")
        return "*";
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
        return normalizedTarget;
    return rel;
}
function scopeResources(worktree, target) {
    const base = scopeBase(worktree, target);
    if (base === "*")
        return ["*"];
    return [base, `${base}/**`];
}
/** Protected `.env`: broad allow, then ask, then example-allow exception. */
function protectedReadRules() {
    return [
        { action: "read", resource: "*", effect: "allow" },
        // Intentionally `ask` (not V1 `deny`) to match the 2.0.23 builtin
        // (`Agent.Info.default`: `read *.env ask`) and the approved T004
        // wording ("*.env.example allow after *.env.* ask"). Note: weaker
        // than V1 deny (user approval can grant); documented risk.
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "read", resource: "*.env.*", effect: "ask" },
        { action: "read", resource: "*.env.example", effect: "allow" },
    ];
}
/** Implementer edit: broad allow with `.env` ask gates (mirrors V1). */
function protectedEditRules() {
    return [
        { action: "edit", resource: "*", effect: "allow" },
        { action: "edit", resource: "*.env", effect: "ask" },
        { action: "edit", resource: "*.env.*", effect: "ask" },
        { action: "edit", resource: "*.env.example", effect: "allow" },
    ];
}
function denyRule(action) {
    return { action, resource: "*", effect: "deny" };
}
function allowRule(action) {
    return { action, resource: "*", effect: "allow" };
}
/** Skill deny-by-default with explicit allows after (allows prevail). */
function skillRules(...allowed) {
    return [{ action: "skill", resource: "*", effect: "deny" }, ...allowed.map((name) => ({
            action: "skill",
            resource: name,
            effect: "allow",
        }))];
}
/** Subagent deny-by-default with explicit allows after. */
function subagentRules(...allowed) {
    return [{ action: "subagent", resource: "*", effect: "deny" }, ...allowed.map((agent) => ({
            action: "subagent",
            resource: agent,
            effect: "allow",
        }))];
}
const CODING_MCP = [
    { action: "engram_*", resource: "*", effect: "allow" },
    { action: "context7_*", resource: "*", effect: "allow" },
    { action: "codegraph_*", resource: "*", effect: "allow" },
];
// Implementer shell: broad allow first, then deny-list after so denies
// prevail (last-match-wins). Mirrors V1 `bash` object verbatim.
const IMPLEMENTER_SHELL_DENIES = [
    "rm",
    "rm *",
    "rmdir",
    "rmdir *",
    "del",
    "del *",
    "Remove-Item*",
    "npm publish*",
    "pnpm publish*",
    "yarn publish*",
    "bun publish*",
];
function implementerShellRules() {
    return [
        { action: "shell", resource: "*", effect: "allow" },
        ...IMPLEMENTER_SHELL_DENIES.map((resource) => ({
            action: "shell",
            resource,
            effect: "deny",
        })),
    ];
}
/**
 * Unscoped (deny-by-default) archivist Rule[] for managed files.
 *
 * Global agent files cannot embed worktree-relative read/edit scopes (the
 * worktree varies per project); files stay deny-by-default (safe) and the
 * scoped expansion below applies at runtime when `WIKI_DIR` + worktree are
 * known. Python allowlist needs no worktree (absolute `pipelineRun`) but is
 * also runtime-only so files never promise access the file cannot scope.
 */
function archivistBaseRules() {
    return [
        fallbackAskRule(),
        denyRule("read"),
        denyRule("edit"),
        denyRule("glob"),
        denyRule("grep"),
        denyRule("shell"),
        denyRule("webfetch"),
        denyRule("websearch"),
        denyRule("question"),
        denyRule("external_directory"),
        ...skillRules("aria-wiki-lookup", "aria-wiki-archive", "aria-wiki-compile"),
        ...subagentRules(),
    ];
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
export function getArchivistScopedPermissions(worktree) {
    const wikiDir = process.env.WIKI_DIR;
    if (!wikiDir)
        return archivistBaseRules();
    const packageRoot = getPackageRoot();
    const pipelineRoot = join(packageRoot, "wiki-pipeline");
    const pipelineRun = join(pipelineRoot, "run.py");
    const wikiScopes = scopeResources(worktree, wikiDir);
    const pipelineScopes = scopeResources(worktree, pipelineRoot);
    return [
        fallbackAskRule(),
        // Read scope: deny first, then scoped allows after.
        { action: "read", resource: "*", effect: "deny" },
        ...wikiScopes.map((resource) => ({
            action: "read",
            resource,
            effect: "allow",
        })),
        ...pipelineScopes.map((resource) => ({
            action: "read",
            resource,
            effect: "allow",
        })),
        // Edit scope: deny first, then wiki allows after (pipeline read-only).
        { action: "edit", resource: "*", effect: "deny" },
        ...wikiScopes.map((resource) => ({
            action: "edit",
            resource,
            effect: "allow",
        })),
        denyRule("glob"),
        denyRule("grep"),
        // Shell: deny first, then exact python allowlist after (never wildcards).
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: `python ${pipelineRun} archive-opencode`, effect: "allow" },
        { action: "shell", resource: `python ${pipelineRun} archive-engram`, effect: "allow" },
        { action: "shell", resource: `python ${pipelineRun} archive-all`, effect: "allow" },
        { action: "shell", resource: `python ${pipelineRun} lint`, effect: "allow" },
        { action: "shell", resource: `python ${pipelineRun} primer`, effect: "allow" },
        denyRule("webfetch"),
        denyRule("websearch"),
        denyRule("question"),
        // External directories stay absolute.
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "external_directory", resource: `${wikiDir}/**`, effect: "allow" },
        { action: "external_directory", resource: `${pipelineRoot}/**`, effect: "allow" },
        ...skillRules("aria-wiki-lookup", "aria-wiki-archive", "aria-wiki-compile"),
        ...subagentRules(),
    ];
}
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
export function getPermissionsForRole(role) {
    switch (role) {
        case "coder":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                allowRule("webfetch"),
                allowRule("websearch"),
                // Coder coordinates via questions; other roles deny (V1: coder had
                // no `question` entry so default-allowed, others explicit-deny).
                { action: "question", resource: "*", effect: "allow" },
                denyRule("external_directory"),
                ...CODING_MCP,
                // Shell: V1 `bash: deny` → V2 `shell * deny`.
                denyRule("shell"),
                // Delegation: deny first, then the 9 V1 `TASK_PERMISSIONS` allows
                // after (writer intentionally excluded, as in V1).
                ...subagentRules("explorer", "visualizer", "planner", "architect", "implementer", "reviewer", "researcher", "archivist", "scientist"),
                // Skills: broad allow first, then adversarial-review deny after so
                // the deny prevails (preserves V1 default-allow + explicit deny).
                { action: "skill", resource: "*", effect: "allow" },
                { action: "skill", resource: "rdc-adversarial-review", effect: "deny" },
            ];
        case "explorer":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                denyRule("webfetch"),
                denyRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                denyRule("shell"),
                ...subagentRules(),
                ...skillRules("rdc-code-exploration"),
            ];
        case "visualizer":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                denyRule("glob"),
                denyRule("grep"),
                denyRule("webfetch"),
                denyRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                denyRule("shell"),
                ...subagentRules(),
                ...skillRules("rdc-visual-analysis"),
            ];
        case "planner":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                allowRule("webfetch"),
                allowRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                denyRule("shell"),
                ...subagentRules(),
                ...skillRules("rdc-implementation-planning", "rdc-testing-discipline"),
            ];
        case "architect":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                allowRule("webfetch"),
                allowRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                denyRule("shell"),
                ...subagentRules(),
                ...skillRules("rdc-plan-review", "rdc-scope-assessment", "rdc-testing-discipline"),
            ];
        case "implementer":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                ...protectedEditRules(),
                allowRule("glob"),
                allowRule("grep"),
                denyRule("webfetch"),
                denyRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                ...implementerShellRules(),
                ...subagentRules(),
                ...skillRules("rdc-code-implementation", "rdc-testing-discipline"),
            ];
        case "reviewer":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                allowRule("webfetch"),
                allowRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                ...CODING_MCP,
                // Reviewer shell is unrestricted for inspection (V1 `bash: allow`).
                allowRule("shell"),
                ...subagentRules(),
                ...skillRules("rdc-implementation-review", "rdc-adversarial-review", "rdc-testing-discipline"),
            ];
        case "researcher":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                allowRule("webfetch"),
                allowRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                // Researcher MCP: Context7 only (no Engram/CodeGraph), plus the
                // 22 verified ZotPilot tools (14 allow, 8 ask). No wildcards.
                { action: "context7_*", resource: "*", effect: "allow" },
                ...ZOTPILOT_READ.map((tool) => ({
                    action: tool,
                    resource: "*",
                    effect: "allow",
                })),
                ...ZOTPILOT_MUTATION.map((tool) => ({
                    action: tool,
                    resource: "*",
                    effect: "ask",
                })),
                // Shell deny-by-default with only the zotpilot executable family
                // approval-gated (never allowed, never the primary MCP interface).
                { action: "shell", resource: "*", effect: "deny" },
                { action: "shell", resource: "zotpilot", effect: "ask" },
                { action: "shell", resource: "zotpilot *", effect: "ask" },
                // Delegation: scientist only (deny first, allow after).
                ...subagentRules("scientist"),
                ...skillRules("aria-research-evidence", "aria-zotero-tutor"),
            ];
        case "archivist":
            return archivistBaseRules();
        case "writer":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                denyRule("glob"),
                denyRule("grep"),
                denyRule("webfetch"),
                denyRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                // No MCP authority (writing-only).
                denyRule("shell"),
                ...subagentRules("archivist", "researcher", "scientist"),
                ...skillRules("aria-academic-writing", "aria-writing-anti-ai", "aria-review-response", "aria-paper-self-review", "aria-document-design"),
            ];
        case "scientist":
            return [
                fallbackAskRule(),
                ...protectedReadRules(),
                denyRule("edit"),
                allowRule("glob"),
                allowRule("grep"),
                denyRule("webfetch"),
                denyRule("websearch"),
                denyRule("question"),
                denyRule("external_directory"),
                // No MCP authority of any kind.
                denyRule("shell"),
                ...subagentRules("researcher", "writer", "coder"),
                ...skillRules("aria-research-planning", "aria-results-analysis"),
            ];
    }
}
function escapeRegExp(value) {
    return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
function patternToRegExp(pattern) {
    return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}
function actionMatches(ruleAction, requestedAction) {
    if (ruleAction === "*")
        return true;
    if (ruleAction.includes("*"))
        return patternToRegExp(ruleAction).test(requestedAction);
    return ruleAction === requestedAction;
}
function resourceMatches(ruleResource, requestedResource) {
    if (ruleResource === "*")
        return true;
    if (ruleResource.includes("*"))
        return patternToRegExp(ruleResource).test(requestedResource);
    return ruleResource === requestedResource;
}
/**
 * 2.0.23-style evaluator for tests: last matching rule wins
 * (`Array.findLast`-equivalent reverse scan); no match falls back to `ask`
 * ("If no rule matches, OpenCode uses `ask`"). Supports `*` wildcards in
 * both fields (including `prefix_*` MCP actions and glob-like resources).
 */
export function evaluatePermission(rules, action, resource) {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (!rule)
            continue;
        if (actionMatches(rule.action, action) && resourceMatches(rule.resource, resource)) {
            return rule.effect;
        }
    }
    return "ask";
}
/**
 * Desired default `experimental.subagent_depth: 3` only when absent.
 *
 * Preserves every explicit value including 0/1/2/>=3 (and only fills
 * `undefined`/`null`); never emits top-level `subagent_depth` (V1 key).
 * Runtime wiring of this default is T008 work; this helper is the
 * canonical T004 source with ordering-free semantics.
 */
export function applyExperimentalSubagentDepthDefault(config) {
    const depth = config.experimental?.subagent_depth;
    if (depth === undefined || depth === null) {
        config.experimental ??= {};
        config.experimental.subagent_depth = 3;
    }
    return config;
}
//# sourceMappingURL=permissions.js.map