export declare const GIT_READ_TOOL_NAME = "git_read";
export declare const gitReadToolInputSchema: Record<string, unknown>;
type GitReadResult = {
    content: string;
    metadata: {
        title: string;
    };
};
export declare function sanitizedGitEnv(): NodeJS.ProcessEnv;
/** Resolve invocation subdirectories to a verified normal or linked worktree root. */
export declare function resolveGitProjectDirectory(projectDirectory: string): {
    root: string;
    gitDir: string;
    commonDir: string;
};
/** Create a fixed-command, project-rooted, role-authorized native V2 read tool. */
export declare function createGitReadTool(projectDirectory: string | undefined): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown, context: unknown) => Promise<GitReadResult>;
};
export {};
//# sourceMappingURL=git-tool.d.ts.map