import type { DoctorFinding } from "./doctor.js";
import type { CatalogModel, PendingChanges } from "./model-manager-state.js";
import type { ModelManagerSnapshot, PersistOutcome } from "./model-manager-store.js";
import type { IntegrationEntry } from "./integrations.js";
/**
 * Pure state for the ARIA Management Console: a menu plus four tool screens
 * (Setup, Doctor, Plugins, Updates) that wrap existing ARIA services, and the
 * embedded Model Manager. Nothing here performs I/O. Effects are returned for
 * the host to run, and results come back as events, so the confirmation,
 * cancellation, and running-state rules are testable without a terminal.
 */
export type ConsoleScreen = "menu" | "models" | "setup" | "doctor" | "plugins" | "updates";
export type ToolScreen = "setup" | "doctor" | "plugins" | "updates";
export type ActionId = "inspect" | "setup" | "doctor" | "plugins" | "check-aria" | "apply-aria" | "check-deps" | "apply-deps" | "check-optional" | "apply-optional";
export declare const MENU_ITEMS: ReadonlyArray<{
    id: Exclude<ConsoleScreen, "menu">;
    label: string;
    hint: string;
}>;
export interface MenuStatus {
    /** Running ARIA package version, or null when it cannot be read. */
    version: string | null;
    globalConfig: boolean;
    projectConfig: boolean;
    /** Managed agent files present for this version's role set (0..total). */
    managedAgents: number;
    totalAgents: number;
}
export interface Notice {
    tone: "info" | "ok" | "error";
    text: string;
}
export interface Panel {
    screen: ToolScreen;
    title: string;
    lines: string[];
    scroll: number;
    /** Mutating action offered by `a` after the preview has been read. */
    offer?: ActionId;
}
export interface Confirm {
    screen: ToolScreen;
    action: ActionId;
    lines: string[];
}
export interface Running {
    screen: ToolScreen;
    action: ActionId;
    mutating: boolean;
    startedAt: number;
}
export interface ActionOutcome {
    action: ActionId;
    ok: boolean;
    lines: string[];
    findings?: DoctorFinding[];
    entries?: IntegrationEntry[];
    /** For check actions: true when the matching apply action may be offered. */
    applicable?: boolean;
}
export interface ConsoleState {
    screen: ConsoleScreen;
    menuCursor: number;
    status: MenuStatus;
    notice?: Notice;
    cursor: Record<ToolScreen, number>;
    panel?: Panel;
    confirm?: Confirm;
    running?: Running;
    lastResult?: {
        title: string;
        lines: string[];
    };
    findings?: DoctorFinding[];
    entries?: IntegrationEntry[];
}
export interface ConsoleKey {
    input: string;
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    returnKey?: boolean;
    escape?: boolean;
    ctrl?: boolean;
}
export type ConsoleEvent = {
    type: "key";
    key: ConsoleKey;
} | {
    type: "result";
    outcome: ActionOutcome;
} | {
    type: "models-open";
} | {
    type: "models-closed";
    notice: Notice;
    status: MenuStatus;
};
export type ConsoleEffect = {
    kind: "run";
    screen: ToolScreen;
    action: ActionId;
} | {
    kind: "open-models";
} | {
    kind: "exit";
};
export interface ReduceResult {
    state: ConsoleState;
    effect?: ConsoleEffect;
}
export declare const PANEL_WRAP_WIDTH = 72;
export declare function initialConsoleState(status: MenuStatus): ConsoleState;
export declare function toolTitle(screen: ToolScreen): string;
/** Plain-text wrapping for panel lines, so scroll bounds equal displayed rows. */
export declare function wrapPlain(text: string, width?: number): string[];
export declare function summarizeFindings(findings: readonly DoctorFinding[]): Record<DoctorFinding["severity"], number>;
export declare function reduceConsole(state: ConsoleState, event: ConsoleEvent): ReduceResult;
/** Title shown in the header for the current screen. */
export declare function screenTitle(screen: ConsoleScreen): string;
/** Whether a key press belongs to the console (vs. the embedded Model Manager). */
export declare function consoleOwnsKeys(state: ConsoleState): boolean;
/**
 * Services the console calls. Every member wraps an existing ARIA capability;
 * tests substitute fakes so navigation and confirmation can be exercised
 * without touching OpenCode or the file system.
 */
export interface ConsoleServices {
    menuStatus(): MenuStatus;
    loadModelSnapshot(): ModelManagerSnapshot;
    discoverModels(): Promise<CatalogModel[]>;
    saveModels(pending: PendingChanges): Promise<PersistOutcome>;
    run(action: ActionId): Promise<ActionOutcome>;
}
//# sourceMappingURL=management-console-state.d.ts.map