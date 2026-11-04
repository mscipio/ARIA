import { type ReactElement } from "react";
import { type CatalogModel, type CatalogState, type ManagerState, type PendingChanges } from "./model-manager-state.js";
import type { ModelManagerSnapshot, PersistOutcome } from "./model-manager-store.js";
/**
 * Ink view for `aria models`. Every decision is made by the pure reducer in
 * `model-manager-state.ts`; this component maps terminal keys to events,
 * renders the resulting state, and runs the save effect.
 */
export interface ModelManagerTuiProps {
    snapshot: ModelManagerSnapshot;
    /** Fresh OpenCode catalog (rejects when the catalog cannot be read). */
    discover: () => Promise<CatalogModel[]>;
    /** Validate pending edits against a fresh catalog and persist them atomically. */
    save: (pending: PendingChanges) => Promise<PersistOutcome>;
    /** Called once when the manager closes: a persist outcome, or undefined when cancelled. */
    onFinish: (outcome: PersistOutcome | undefined) => void;
    /** Initial configuration scope. */
    initialScope?: "global" | "project";
    /**
     * Hosted inside the Management Console: finishing reports through
     * `onFinish` only and never exits the surrounding Ink application.
     */
    embedded?: boolean;
}
export interface Line {
    text: string;
    color?: string;
    bold?: boolean;
    dim?: boolean;
}
export declare function fit(text: string, width: number): string;
export declare function linesFor(state: ManagerState, snapshot: ModelManagerSnapshot, catalog: CatalogState, width: number): Line[];
export declare function renderLines(lines: Line[]): ReactElement;
/** Interactive manager root component. */
export declare function ModelManagerApp(props: ModelManagerTuiProps): ReactElement;
//# sourceMappingURL=model-manager-tui.d.ts.map