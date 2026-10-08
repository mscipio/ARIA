export type ExecutorOptions = {
    cwd?: string;
    /**
     * Per-call environment additions for the spawned process. Merged over a
     * copy of `process.env` only for that call (T011: `NPM_CONFIG_ALLOW_GIT`
     * travels this way; it is never assigned to `process.env` and never
     * persisted to any file). Absent means inherit the ambient environment.
     */
    env?: NodeJS.ProcessEnv;
};
export type Executor = (command: string, args: string[], options?: ExecutorOptions) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface DependencyFileOps {
    readText(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    sha256(path: string): Promise<string>;
}
export declare function sha256File(path: string): Promise<string>;
export type CommandResolution = {
    command: string;
    useComSpec: boolean;
};
/**
 * Resolve a command name to its executable path and ComSpec requirement.
 *
 * On non-Windows, returns the command as-is with `useComSpec: false`.
 *
 * On Windows:
 * - Commands with an extension (.exe, .cmd, .bat) or path separators are
 *   returned as-is.
 * - Otherwise, PATH directories are scanned for extensions parsed from
 *   `pathExt` (default ".cmd;.bat;.exe") in priority order.
 * - `.cmd`/`.bat` shims require ComSpec; native `.exe` does not.
 * - If nothing is found, the original command is returned to let execFile
 *   fail naturally with ENOENT.
 *
 * @param cmd Command name to resolve.
 * @param pathEnv Semicolon-separated PATH (default `process.env.PATH`).
 * @param pathExt Semicolon-separated extension list (default ".cmd;.bat;.exe").
 * @param platform Override `process.platform` for testing.
 * @param probe File-existence check (default `existsSync`).
 */
export declare function resolveCommand(cmd: string, pathEnv?: string, pathExt?: string, platform?: string, probe?: (path: string) => boolean): CommandResolution;
/**
 * Build the argument list for `cmd.exe /s /c` that safely passes `command`
 * and `args` through the CMD command-line parser.
 *
 * @returns `["/s", "/c", escapedCommandString]`
 */
export declare function buildComSpecArgs(command: string, args: string[]): string[];
declare const defaultExecutor: Executor;
/**
 * Optional ZotPilot MCP server presence observed by a fresh `opencode mcp
 * list` CLI run. ZotPilot is optional at runtime but expected for the
 * advertised researcher capability.
 *
 * T006 shared evidence gate (recorded 2026-10-08; feeds T014): installed
 * zotpilot 0.5.3 lives in a shared conda env
 * (`.../miniforge3/envs/zotpilot/bin/zotpilot`, not user-owned; `pip show`
 * confirms the install), so ownership is unknown/unsupported and `pip
 * install --upgrade` (previewed via read-only `zotpilot upgrade --dry-run`)
 * would mutate that shared env. `zotpilot upgrade --check` (read-only)
 * reports installed 0.5.3 == latest 0.5.3; register/install auto-detects
 * platforms with unknown side effects, and ZotPilot's own config
 * (`~/.config/zotpilot/config.json`, holds API secrets) plus ChromaDB state
 * (`~/.local/share/zotpilot/chroma`) are never ARIA-managed. No safe
 * V2/XDG-aware managed path is demonstrated, so ZotPilot stays non-managed:
 * this interface is detection-only (`opencode mcp list` parse here,
 * `zotpilot --version` probe in doctor.ts); `depsSync` never invokes a
 * `zotpilot` command. Unknown/uncertain ownership or safety stays
 * report-only with zero mutation.
 */
export interface ZotPilotMcpPresence {
    /** Server appears in `opencode mcp list` output. */
    listed: boolean;
    /** Listed status is "connected". */
    connected: boolean;
}
export interface DepsStatus {
    opencode: {
        version: string | null;
        found: boolean;
    };
    engram: {
        version: string | null;
        found: boolean;
        connected: boolean;
    };
    context7: {
        configured: boolean;
        connected: boolean;
    };
    codegraph: {
        version: string | null;
        found: boolean;
        connected: boolean;
    };
    /** Optional ZotPilot MCP presence/connectivity; absent when not listed. */
    zotpilot?: ZotPilotMcpPresence;
    /** True when `opencode mcp list` itself failed (no MCP status known). */
    mcpListFailed?: boolean;
}
export interface SyncResult {
    ok: boolean;
    engram: {
        action: string;
        version?: string;
        error?: string;
    };
    context7: {
        action: string;
        error?: string;
    };
    codegraph: {
        action: string;
        version?: string;
        error?: string;
    };
    health?: DepsStatus;
}
declare function discoverConfigPath(configDir?: string): string | null;
export declare function opencodeConfigPath(configDir?: string): string;
/** Normalize JSONC comments and trailing commas without changing quoted strings. */
declare function stripJsoncComments(raw: string): string;
declare function extractVersion(output: string): string | null;
declare function isCoreSemverTag(tag: string): boolean;
type EngramSource = "homebrew" | "unknown" | "missing";
declare function detectEngramSource(executor: Executor, fileOps?: DependencyFileOps): Promise<EngramSource>;
/**
 * Plugin ID registered by `engram setup opencode` as a UI side effect.
 * It is incompatible with the managed ARIA flow and must not remain
 * registered in the active OpenCode config after Engram handling.
 *
 * Single owner: this module. The upgrade adapter (T012) reuses
 * {@link cleanupIncompatibleStatusline} instead of duplicating logic.
 */
export declare const INCOMPATIBLE_STATUSLINE_PLUGIN = "opencode-subagent-statusline";
/** True only for the exact incompatible statusline entry; never matches objects or similar names. */
export declare function isIncompatibleStatuslineEntry(entry: unknown): boolean;
/**
 * Pure list normalization: remove exact statusline entries, preserve order
 * and every unrelated entry (including non-string values).
 */
export declare function stripIncompatibleStatusline(entries: unknown): {
    filtered: unknown[];
    removed: boolean;
};
export interface StatuslineCleanupResult {
    /** True when at least one file lost the incompatible entry. */
    removed: boolean;
    /** Absolute paths rewritten. */
    removedFrom: string[];
}
/**
 * Reusable detection: report which active-config plugin files still register
 * the incompatible statusline integration. Read-only, XDG-contained to
 * `openCodeGlobalDir(configDir)`. Parse failures and missing files count as
 * absent (fail-closed for detection: no mutation, no throw).
 */
export declare function detectIncompatibleStatusline(configDir?: string): Promise<{
    present: boolean;
    files: string[];
}>;
/**
 * Reusable normalization: remove the incompatible statusline entry from the
 * active OpenCode plugin files (`cli.json` `plugins`, `tui.json` `plugin`)
 * under `openCodeGlobalDir(configDir)`.
 *
 * - Only exact `"opencode-subagent-statusline"` string entries are removed;
 *   unrelated plugins, `$schema`, and all other keys are preserved.
 * - Missing files, non-object roots, non-array plugin fields, and invalid
 *   JSON are left untouched (fail-closed per file).
 * - Never touches `opencode.json`/`opencode.jsonc` (dual-file ambiguity is
 *   owned by setup-config T002) and never resolves outside the XDG-contained
 *   global dir.
 */
export declare function cleanupIncompatibleStatusline(configDir?: string): Promise<StatuslineCleanupResult>;
declare function detectEngram(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
declare function syncEngramHomebrew(executor: Executor, configDir?: string): Promise<SyncResult["engram"]>;
declare function syncEngramGitHub(executor: Executor, fileOps?: DependencyFileOps, configDir?: string): Promise<SyncResult["engram"]>;
export declare const CONTEXT7_REMOTE_URL = "https://mcp.context7.com/mcp";
export declare const CONTEXT7_NAME = "context7";
/** True for exactly the canonical remote entry (disabled entries never count). */
export declare function isCanonicalContext7Entry(entry: unknown): boolean;
declare function detectContext7(executor: Executor, configDir?: string): Promise<{
    configured: boolean;
    connected: boolean;
}>;
declare function syncContext7(executor: Executor, configDir?: string): Promise<SyncResult["context7"]>;
declare function detectCodeGraph(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
export interface McpStatus {
    engram: boolean;
    context7: boolean;
    codegraph: boolean;
    /** Optional ZotPilot presence/connectivity; absent when not listed. */
    zotpilot?: ZotPilotMcpPresence;
    /** True when `opencode mcp list` failed (no list output was available). */
    listFailed?: boolean;
}
export declare function parseMcpList(output: string): McpStatus;
declare function detectMcpConnectivity(executor: Executor): Promise<McpStatus>;
/**
 * Result of inspecting only the own top-level `subagent_depth` field of the
 * fully merged configuration printed by the read-only `opencode debug
 * config` CLI. Nested lookalike fields are never considered and no
 * configuration is mutated by this probe.
 *
 * - `value`: the merged config reports a finite numeric subagent_depth.
 * - `absent`: the merged config has no top-level subagent_depth field.
 * - `unavailable`: the probe or its output could not be evaluated;
 *   `reason` explains why.
 */
export type SubagentDepthProbe = {
    status: "value";
    depth: number;
} | {
    status: "absent";
} | {
    status: "unavailable";
    reason: string;
};
/**
 * Defensively parse the fully merged JSON printed by `opencode debug config`
 * and inspect only its own top-level `subagent_depth` field.
 *
 * Two supported shapes (pin stays OpenCode 2.0.23):
 * - a merged-config object with an own top-level `subagent_depth` field;
 * - an array of per-source config documents, where each document either
 *   carries an own top-level `subagent_depth` or nests the config under an
 *   own `config` object holding that field.
 */
export declare function parseSubagentDepth(output: string): SubagentDepthProbe;
/**
 * Read-only probe: run `opencode debug config` in the inspected worktree and
 * inspect the effective merged top-level `subagent_depth`. Never mutates
 * configuration.
 */
export declare function probeSubagentDepth(executor: Executor, worktree?: string): Promise<SubagentDepthProbe>;
declare function detectOpenCode(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
export declare function doctor(executor?: Executor, configDir?: string): Promise<DepsStatus>;
export declare function formatDoctor(version: string, status: DepsStatus): string;
export declare function doctorExitCode(status: DepsStatus): number;
export declare function depsSync(executor?: Executor, configDir?: string, fileOps?: DependencyFileOps): Promise<SyncResult>;
export declare function formatSyncResult(result: SyncResult): string;
export { defaultExecutor, detectEngram, detectEngramSource, detectCodeGraph, detectContext7, detectMcpConnectivity, detectOpenCode, syncContext7, syncEngramGitHub, syncEngramHomebrew, isCoreSemverTag, discoverConfigPath, stripJsoncComments, extractVersion, };
//# sourceMappingURL=deps.d.ts.map