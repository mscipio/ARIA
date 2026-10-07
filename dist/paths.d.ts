/**
 * Canonical OpenCode global directory: `$XDG_CONFIG_HOME/opencode` when
 * XDG_CONFIG_HOME is set, else `~/.config/opencode`. An explicit non-empty
 * directory wins over both; empty/whitespace values count as unset.
 */
export declare function openCodeGlobalDir(explicit?: string): string;
export declare function assertContained(root: string, candidate: string, label: string): void;
export declare function canonicalWorktree(worktree: string): Promise<string>;
export declare function ensureSafeDirectory(root: string, target: string, create: boolean): Promise<string>;
export declare function safeProjectFile(worktree: string, file: string, options?: {
    createParent?: boolean;
    allowMissing?: boolean;
}): Promise<{
    root: string;
    path: string;
}>;
export declare function verifySafeParent(root: string, filePath: string): Promise<void>;
export declare function withFileLock<T>(target: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
//# sourceMappingURL=paths.d.ts.map