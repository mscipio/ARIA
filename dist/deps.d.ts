export type Executor = (command: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface DependencyFileOps {
    readText(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    sha256(path: string): Promise<string>;
}
export declare function sha256File(path: string): Promise<string>;
declare const defaultExecutor: Executor;
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
declare function isCoreSemverTag(tag: string): boolean;
type EngramSource = "homebrew" | "unknown" | "missing";
declare function detectEngramSource(executor: Executor, fileOps?: DependencyFileOps): Promise<EngramSource>;
declare function detectEngram(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
declare function syncEngramHomebrew(executor: Executor): Promise<SyncResult["engram"]>;
declare function syncEngramGitHub(executor: Executor, fileOps?: DependencyFileOps): Promise<SyncResult["engram"]>;
declare function detectContext7(executor: Executor, configDir?: string): Promise<{
    configured: boolean;
    connected: boolean;
}>;
declare function detectCodeGraph(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
export interface McpStatus {
    engram: boolean;
    context7: boolean;
    codegraph: boolean;
}
export declare function parseMcpList(output: string): McpStatus;
declare function detectMcpConnectivity(executor: Executor): Promise<McpStatus>;
declare function detectOpenCode(executor: Executor): Promise<{
    found: boolean;
    version: string | null;
}>;
export declare function doctor(executor?: Executor, configDir?: string): Promise<DepsStatus>;
export declare function formatDoctor(version: string, status: DepsStatus): string;
export declare function doctorExitCode(status: DepsStatus): number;
export declare function depsSync(executor?: Executor, configDir?: string, fileOps?: DependencyFileOps): Promise<SyncResult>;
export declare function formatSyncResult(result: SyncResult): string;
export { defaultExecutor, detectEngram, detectEngramSource, detectCodeGraph, detectContext7, detectMcpConnectivity, detectOpenCode, syncEngramGitHub, syncEngramHomebrew, isCoreSemverTag, discoverConfigPath, stripJsoncComments, };
//# sourceMappingURL=deps.d.ts.map