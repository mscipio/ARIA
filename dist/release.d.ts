export declare const RELEASE_TOOL_NAME = "aria_release";
export declare const releaseToolInputSchema: Record<string, unknown>;
export declare function runReleaseCli(args: readonly string[], invocationDirectory: string): Promise<number>;
/** Registered native tool uses an absolute installed CLI and fixed command argv. */
export declare function createReleaseTool(packageRoot: string, projectDirectory: string | undefined): {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown, context: unknown) => Promise<{
        content: string;
        metadata: {
            title: string;
        };
    }>;
};
//# sourceMappingURL=release.d.ts.map