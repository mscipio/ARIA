/**
 * Permission rules for ARIA roles.
 *
 * Semantics verified against OpenCode v2.3.0 source (packages/core/src/permission.ts,
 * util/wildcard.ts, tool.ts, tool/mcp.ts, tool/plugin/*, schema/src/agent.ts):
 *
 * - Rules are ordered; the LAST matching rule wins; no match asks. A new agent starts from
 *   `* * allow` plus `.env` read asks. User config (`permissions`, `agents.<id>.permissions`) is
 *   appended AFTER these rules, and `policies` can still deny on top.
 * - A tool is removed from the model's tool list when the last rule matching its name (any
 *   resource) is `deny` with resource `*` ("wholly disabled"). Code Mode is the `execute` tool and
 *   only exposes tools that survive the same filter.
 * - Per-call checks happen only where a tool calls `permission.assert`. Native file, shell, web,
 *   skill, subagent, question and todo tools do; every MCP tool does, with action
 *   `<server>_<tool>`. Some built-in `opencode_*` tools and any third-party plugin tool may not, so
 *   an `ask` rule alone would not stop them: ARIA's tool gate (tool-gate.ts) asserts on their
 *   behalf before they run.
 * - Paths are matched lexically (relative inside the project, absolute outside). Symlinks are
 *   handled by guard.ts. Shell resources are command text: policy, not a sandbox.
 */

export type Effect = "allow" | "ask" | "deny";

export interface Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: Effect;
}

export const allow = (action: string, resource = "*"): Rule => ({ action, resource, effect: "allow" });
export const ask = (action: string, resource = "*"): Rule => ({ action, resource, effect: "ask" });
export const deny = (action: string, resource = "*"): Rule => ({ action, resource, effect: "deny" });

/** OpenCode v2.3.0 wildcard matching (packages/core/src/util/wildcard.ts), used by the guard and diagnostics. */
export function matches(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

/** Credential material nobody reads or edits by default. */
export const SECRET_PATHS: readonly string[] = [
  "*/.ssh/*", ".ssh/*", "*/.gnupg/*", ".gnupg/*", "*/.aws/*", ".aws/*", "*/.azure/*", ".azure/*",
  "*/.config/gcloud/*", "*/.kube/config", "*/.docker/config.json", "*/.npmrc", ".npmrc", "*/.pypirc", ".pypirc",
  "*id_rsa*", "*id_ed25519*", "*id_ecdsa*", "*id_dsa*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", "*.keystore", "*.jks",
  "*/.netrc", ".netrc", "*/.git-credentials", ".git-credentials", "*/.config/gh/hosts.yml",
  "*/.local/share/opencode/auth.json", "*/.config/opencode/auth.json",
];

/** Files that define an agent's own authority or instructions. */
export const AUTHORITY_PATHS: readonly string[] = [
  "opencode.json", "opencode.jsonc", "*/opencode.json", "*/opencode.jsonc",
  ".opencode/*", "*/.opencode/*", ".claude/*", "*/.claude/*", ".agents/*", "*/.agents/*",
  "*AGENTS.md", "*CLAUDE.md", ".git/config", ".git/hooks/*", ".gitattributes",
];

/** Reading: allowed, `.env` gated, credentials denied. Read and write are separate decisions. */
export function readRules(): Rule[] {
  return [
    allow("read"),
    ask("read", "*.env"),
    ask("read", "*.env.*"),
    allow("read", "*.env.example"),
    ...SECRET_PATHS.map((p) => deny("read", p)),
  ];
}

export const searchRules = (): Rule[] => [allow("glob"), allow("grep")];

/** Outside-the-project access needs a decision, for every role that can read at all. */
export const externalRules = (): Rule[] => [ask("external_directory")];

/**
 * Editing for a write-capable role (`edit` covers the edit, write and patch tools). External
 * absolute paths are denied (POSIX `/*`, Windows `X:/*`); the user opens specific directories in
 * their own config. Authority files ask; `.aria/scratch` ownership is enforced by the guard.
 */
export function editRules(): Rule[] {
  return [
    allow("edit"),
    deny("edit", "/*"),
    deny("edit", "?:/*"),
    ask("edit", "*.env"),
    ask("edit", "*.env.*"),
    allow("edit", "*.env.example"),
    ...AUTHORITY_PATHS.map((p) => ask("edit", p)),
    ...SECRET_PATHS.map((p) => deny("edit", p)),
  ];
}

/** Commands that change history, install software, build distributables or delete recursively. */
const SHELL_ASK: readonly string[] = [
  "git push *", "git * push *", "git commit *", "git * commit *", "git reset --hard *", "git clean *",
  "git rebase *", "git checkout -- *", "git restore *", "git stash drop *", "git stash clear *",
  "git branch -D *", "git tag *", "git config *", "git remote *", "git filter-branch *", "git filter-repo *",
  "npm install *", "npm i *", "npm ci *", "npm uninstall *", "npm update *", "npm link *", "npm exec *", "npx *",
  "pnpm add *", "pnpm install *", "pnpm i *", "pnpm remove *", "pnpm update *", "pnpm dlx *",
  "yarn add *", "yarn install *", "yarn remove *", "bun add *", "bun install *", "bunx *",
  "pip install *", "pip3 install *", "pip uninstall *", "python -m pip *", "python3 -m pip *", "py -m pip *",
  "conda install *", "conda create *", "conda remove *", "conda update *", "conda env *", "mamba *", "micromamba *",
  "uv add *", "uv sync *", "uv pip *", "uv tool *", "uvx *", "poetry add *", "poetry install *", "pipx *",
  "cargo install *", "cargo add *", "go install *", "gem install *", "brew *", "apt *", "apt-get *",
  "dnf *", "yum *", "pacman *", "winget *", "choco *", "scoop *", "curl * | *", "wget * | *",
  "npm run build *", "npm run compile *", "npm run pack *", "npm pack *", "pnpm build *", "pnpm pack *",
  "yarn build *", "python -m build *", "python3 -m build *", "pyinstaller *", "docker *", "podman *",
  "rm -*", "rm * -*", "rmdir *", "find * -delete*", "find * -exec rm*", "Remove-Item *", "rd /s *", "rmdir /s *", "del *",
  "chmod -R *", "chown *", "mv * /*", "cp * /*", "ln -s *", "dd *", "mkfs*", "truncate *",
  "crontab *", "systemctl *", "launchctl *", "schtasks *", "ssh *", "scp *", "rsync *",
  "opencode *",
];

/** Publishing, deploying, privilege escalation: never. */
const SHELL_DENY: readonly string[] = [
  "npm publish *", "pnpm publish *", "yarn publish *", "yarn npm publish *", "cargo publish *", "bun publish *",
  "twine upload *", "python -m twine upload *", "python3 -m twine upload *", "uv publish *", "poetry publish *",
  "docker push *", "podman push *", "gh release *", "gh pr merge *", "gh repo delete *",
  "vercel *", "netlify deploy *", "terraform apply *", "terraform destroy *", "kubectl apply *", "kubectl delete *",
  "helm install *", "helm upgrade *", "ansible-playbook *",
  "sudo *", "su *", "doas *", "runas *", "pkexec *",
];

/**
 * Shell for a coding role: allowed, with narrow ask/deny rules on the command text. This is a
 * practical policy for an authorized agent, not containment: `sh -c`, interpreters, compound
 * commands and scripts can do anything the user can. Only OS isolation is a boundary.
 */
export function shellRules(): Rule[] {
  return [allow("shell"), ...SHELL_ASK.map((c) => ask("shell", c)), ...SHELL_DENY.map((c) => deny("shell", c))];
}

export const skillRules = (...ids: string[]): Rule[] => [deny("skill"), ...ids.map((id) => allow("skill", id))];

export const subagentRules = (...ids: string[]): Rule[] => [deny("subagent"), ...ids.map((id) => allow("subagent", id))];

/**
 * Built-in OpenCode tools that do not assert per call (v2.3.0 tool/plugin/opencode.ts,
 * schedule.ts, artifact.ts). ARIA's tool gate asserts these names; this decides the answer.
 */
export function opencodeToolRules(): Rule[] {
  return [
    allow("opencode_models"),
    allow("opencode_session_rename"),
    allow("opencode_worktree_list"),
    allow("opencode_artifact_read"),
    allow("opencode_artifact_create"),
    allow("opencode_artifact_update"),
    ask("opencode_artifact_delete"),
    ask("opencode_session_move"),
    ask("opencode_worktree_create"),
    ask("opencode_schedule_*"),
    allow("opencode_schedule_list"),
    allow("opencode_list_mcp_resources"),
    allow("opencode_read_mcp_resource"),
    allow("opencode_watch_mcp_event"),
  ];
}

/**
 * The coding policy shared by `aria` and `scientist`. Unknown actions ASK (instead of OpenCode's
 * allow-all), so a newly connected MCP server or plugin tool cannot act silently; normal
 * development (read, search, edit inside the project, shell, todo, web reads, Code Mode) runs
 * without prompts.
 */
export function codingRules(): Rule[] {
  return [
    ask("*"),
    allow("todowrite"),
    allow("question"),
    allow("execute"),
    allow("webfetch"),
    allow("websearch"),
    allow("experimental_image_generate"),
    ...searchRules(),
    ...externalRules(),
    ...readRules(),
    ...editRules(),
    ...shellRules(),
    ...opencodeToolRules(),
    allow("aria_git"),
    allow("aria_status"),
    deny("aria_review_verdict"),
    allow("context7_*"),
  ];
}

/**
 * Read-only base: everything denied (and therefore hidden, including Code Mode, shell and any MCP
 * or plugin tool), then reading and searching inside the project. No scratch, no plan edits.
 */
export function readOnlyRules(): Rule[] {
  return [deny("*"), ...externalRules(), ...readRules(), ...searchRules(), allow("aria_git"), allow("aria_status")];
}

/** Read-only documentation lookups (Context7 tools only read public docs). */
export const docsRules = (): Rule[] => [allow("context7_*"), allow("webfetch"), allow("websearch")];

/**
 * Zotero via zotero-mcp (github.com/54yyyu/zotero-mcp, PyPI `zotero-mcp-server`), tool names
 * taken from its source at commit 71df195 (2026-11-14). OpenCode names MCP tools
 * `<server>_<tool>`; the server name defaults to `zotero` and can be changed with the plugin
 * option `zoteroServer`. Tools not listed here (e.g. added by a newer release) stay denied for the
 * researcher until classified.
 */
export const ZOTERO_READ: readonly string[] = [
  "search", "fetch",
  "zotero_search_items", "zotero_advanced_search", "zotero_search_by_tag", "zotero_search_by_citation_key",
  "zotero_search_collections", "zotero_semantic_search", "zotero_get_search_database_status",
  "zotero_get_item_metadata", "zotero_get_item_fulltext", "zotero_get_item_children", "zotero_get_item_related",
  "zotero_get_attachment_path", "zotero_get_annotations", "zotero_get_notes", "zotero_get_tags", "zotero_get_recent",
  "zotero_get_collections", "zotero_get_collection_items", "zotero_list_libraries", "zotero_list_feeds",
  "zotero_get_feed_items", "zotero_get_pdf_outline", "zotero_read_pdf_pages", "zotero_get_page_layout",
  "zotero_synthesize_annotations", "zotero_export_bibliography", "zotero_find_duplicates",
  "zotero_find_related_papers", "zotero_library_coverage", "zotero_write_capabilities",
  "scite_check_retractions", "scite_enrich_item", "scite_enrich_search",
];

/** Tools that change the library, its index, the active library, or write authority: always a human decision. */
export const ZOTERO_MUTATE: readonly string[] = [
  "zotero_add_item", "zotero_update_item", "zotero_batch_update", "zotero_delete_item", "zotero_attach_file",
  "zotero_set_item_parent", "zotero_set_item_collections", "zotero_add_item_relation", "zotero_remove_item_relation",
  "zotero_copy_items_between_libraries", "zotero_merge_duplicates",
  "zotero_create_collection", "zotero_update_collection", "zotero_delete_collection", "zotero_manage_collection",
  "zotero_manage_note", "zotero_create_annotation", "zotero_update_annotation", "zotero_delete_annotation",
  "zotero_update_search_database", "zotero_switch_library", "zotero_authorize_local_writes",
];

/** OpenCode's MCP namespace for a server name (tool/runtime.ts `normalizedName` + `.` → `_`). */
export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_").replaceAll(".", "_");

export function zoteroRules(server: string): Rule[] {
  const ns = mcpNamespace(server);
  return [...ZOTERO_READ.map((t) => allow(`${ns}_${t}`)), ...ZOTERO_MUTATE.map((t) => ask(`${ns}_${t}`))];
}
