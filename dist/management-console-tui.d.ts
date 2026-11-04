import { type ReactElement } from "react";
import { type Line } from "./model-manager-tui.js";
import { type ConsoleServices, type ConsoleState, type MenuStatus } from "./management-console-state.js";
/**
 * Ink view for the ARIA Management Console. Every decision is made by
 * `reduceConsole`; this module maps keys to events, performs the effects the
 * reducer requests through the injected services, and renders the state with
 * the same line vocabulary as the Model Manager.
 */
export interface ManagementConsoleAppProps {
    services: ConsoleServices;
    initialStatus: MenuStatus;
    /** Closes the console. Never abandons a configuration change (see Ctrl+C handling). */
    onExit: () => void;
}
/** Pure line builder for one console state (exported for tests). */
export declare function consoleLines(state: ConsoleState, width: number, height: number): Line[];
export declare function ManagementConsoleApp(props: ManagementConsoleAppProps): ReactElement;
//# sourceMappingURL=management-console-tui.d.ts.map