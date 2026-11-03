export declare const SHIP_TOOL_NAME = "aria_ship";
export declare const shipToolInputSchema: Record<string, unknown>;
type ShipInput = {
    paths: string[];
    message: string;
    push?: boolean;
};
/** Strict CLI parser shared by direct `aria ship` and the native tool. */
export declare function parseShipArgs(args: readonly string[]): ShipInput;
/** Execute the strict CLI form in the current project invocation directory. */
export declare function runShipCli(args: readonly string[], invocationDirectory: string): Promise<number>;
/** Create a fixed-argv Node launcher; all repository validation lives in the CLI implementation. */
export declare function createShipTool(packageRoot: string, projectDirectory: string | undefined): {
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
export {};
//# sourceMappingURL=ship.d.ts.map