import { type Executor } from "./deps.js";
import { type IntegrationInventory } from "./integrations.js";
import type { ActionOutcome, ConsoleServices, MenuStatus } from "./management-console-state.js";
/**
 * Entry point and service adapters for the ARIA Management Console (bare
 * `aria` in an interactive terminal). The adapters call the same functions the
 * explicit CLI commands use (`setup`, `runDoctor`, `checkUpgradeInventory`,
 * `runUpgrade`, `runDepsUpgrades`, the Model Manager save path), so the console
 * is a presentation layer and adds no second backend.
 */
export declare const NON_TERMINAL_HELP_NOTE = "aria: no interactive terminal; showing command help instead of the management console.";
/** Cheap, file-system-only status for the menu (no subprocess, no network). */
export declare function readMenuStatus(worktree: string): MenuStatus;
export interface ConsoleServiceOptions {
    worktree: string;
    /** `import.meta.url` of the invoking bin, used by setup to resolve the package. */
    binaryUrl: string;
    /** Command executor seam (defaults to the real process executor). */
    executor?: Executor;
}
/** Read-only preview for optional installs: refused while required components are missing. */
export declare function optionalPreview(integrations: IntegrationInventory): ActionOutcome;
/** Real services: each member calls the existing ARIA capability. */
export declare function createConsoleServices(options: ConsoleServiceOptions): ConsoleServices;
export interface ManagementConsoleOptions extends ConsoleServiceOptions {
    services?: ConsoleServices;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
}
/**
 * Run the console until the user quits. Returns the process exit code.
 * Terminal state is restored by Ink on unmount; the unmount is also done in a
 * finally block so an error during rendering still leaves the terminal clean.
 */
export declare function runManagementConsole(options: ManagementConsoleOptions): Promise<number>;
//# sourceMappingURL=management-console.d.ts.map