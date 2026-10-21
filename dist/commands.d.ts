declare const NAMES: readonly ["aria-push", "aria-release"];
export type CommandName = typeof NAMES[number];
export declare function parseManagedHeader(text: string): {
    version: string;
    checksum: string;
} | null;
export declare function isAriaManaged(text: string): boolean;
export declare function verifyManagedContent(text: string): boolean;
export declare function generateCommandFiles(version?: string): Record<CommandName, string>;
export declare function defaultCommandsDir(explicit?: string): string;
export interface CommandInstallResult {
    dir: string;
    version: string;
    written: CommandName[];
    unchanged: CommandName[];
    tampered: CommandName[];
    backups: Partial<Record<CommandName, string>>;
    previousContents: Partial<Record<CommandName, string>>;
}
export declare function rollbackCommandInstall(dir: string, r: CommandInstallResult): Promise<void>;
export declare function installCommandFiles(options?: {
    dir?: string;
    version?: string;
}): Promise<CommandInstallResult>;
export declare function reconcileManagedCommands(options?: {
    dir?: string;
    version?: string;
}): Promise<CommandInstallResult>;
export {};
//# sourceMappingURL=commands.d.ts.map