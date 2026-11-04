import type { AriaDefaults, RoleName, RoleOverride } from "./types.js";
/**
 * Pure model-manager state for `aria models`: layered assignments, pending
 * edits, effective (preview) resolution, catalog filtering, variant choices,
 * save-time validation, and the keyboard reducer. No I/O happens here, so the
 * terminal UI and the persistence layer both build on tested logic.
 *
 * Layers mirror `resolveAriaConfig`: packaged defaults, then the global
 * `aria.json` overrides, then the project `aria.json` overrides. A layer entry
 * owns its model/variant pair atomically (a model without a variant clears the
 * inherited variant), via the same `resolveRoleRoute` the runtime uses.
 */
export type ConfigScope = "global" | "project";
export declare const SCOPES: readonly ConfigScope[];
/** Where an effective assignment comes from (highest contributing layer). */
export type AssignmentSource = "default" | "global" | "project";
export type RoleEntries = Partial<Record<RoleName, RoleOverride>>;
export interface ScopedEntries {
    global: RoleEntries;
    project: RoleEntries;
}
/** A pending edit: the full model/variant pair to set, or `null` to remove the scope's override. */
export type PendingEdit = RoleOverride | null;
export type PendingScope = Partial<Record<RoleName, PendingEdit>>;
export interface PendingChanges {
    global: PendingScope;
    project: PendingScope;
}
/** The subset of an OpenCode catalog entry the manager needs. */
export interface CatalogModel {
    id: string;
    variants: string[];
    /** True when variant metadata was observed; absent/false means unverifiable. */
    variantsObservable?: boolean;
}
export declare function emptyPending(): PendingChanges;
/** Equality of two layer entries, treating an unset entry as absent. */
export declare function sameEntry(a: RoleOverride | undefined | null, b: RoleOverride | undefined | null): boolean;
/** Drop pending edits that equal the saved layer, so only real changes remain. */
export declare function normalizePending(saved: ScopedEntries, pending: PendingChanges): PendingChanges;
/** Layers with the pending edits applied, as they would be persisted. */
export declare function applyPending(saved: ScopedEntries, pending: PendingChanges): ScopedEntries;
/** Pending edits as an ordered list for display and summaries. */
export declare function pendingEntries(pending: PendingChanges): Array<{
    scope: ConfigScope;
    role: RoleName;
    edit: PendingEdit;
}>;
export declare function pendingCount(pending: PendingChanges): number;
export interface EffectiveRoute {
    role: RoleName;
    model: string;
    variant: string | undefined;
    source: AssignmentSource;
}
/**
 * Effective assignment per role using the runtime precedence. A project layer
 * that sets any field owns the assignment ("project"); otherwise a global
 * layer that sets any field ("global"); otherwise the packaged default.
 */
export declare function resolveEffective(defaults: AriaDefaults, layers: ScopedEntries): EffectiveRoute[];
/** `provider/model` with an optional ` (variant)` suffix. */
export declare function describeRoute(model: string, variant: string | undefined): string;
/** Short status for a route against the catalog; empty when nothing is wrong. */
export declare function routeStatus(route: {
    model: string;
    variant: string | undefined;
}, models: CatalogModel[] | undefined): string;
/** Case-insensitive substring filter over model identifiers; catalog order kept. */
export declare function filterModels<T extends CatalogModel>(models: readonly T[], query: string): T[];
export interface VariantOption {
    label: string;
    variant: string | undefined;
}
export interface VariantChoices {
    options: VariantOption[];
    notice?: string;
}
/**
 * Variant choices for a model. Variants are exactly what the catalog reports;
 * nothing is guessed. When metadata is unobservable only the no-variant choice
 * is offered, plus the current variant (explicitly unverified) when the model
 * is already the assigned one.
 */
export declare function variantChoices(model: CatalogModel, currentVariant: string | undefined): VariantChoices;
/**
 * Save-time validation of pending edits against a fresh catalog. Returns human
 * readable errors; an empty list means every pending edit is safe to persist.
 */
export declare function validatePending(pending: PendingChanges, models: CatalogModel[]): string[];
export type Screen = {
    kind: "main";
} | {
    kind: "model";
    role: RoleName;
    query: string;
    searching: boolean;
    cursor: number;
} | {
    kind: "variant";
    role: RoleName;
    model: string;
    cursor: number;
};
export interface Notice {
    tone: "info" | "ok" | "error";
    text: string;
}
export interface ManagerState {
    scope: ConfigScope;
    roleIndex: number;
    screen: Screen;
    pending: PendingChanges;
    notice: Notice | undefined;
    saving: boolean;
}
export type CatalogState = {
    status: "loading";
} | {
    status: "ready";
    models: CatalogModel[];
} | {
    status: "failed";
    error: string;
};
export interface KeyEvent {
    input: string;
    upArrow?: boolean;
    downArrow?: boolean;
    returnKey?: boolean;
    escape?: boolean;
    tab?: boolean;
    backspace?: boolean;
}
export type ManagerEffect = {
    kind: "save";
} | {
    kind: "exit";
};
export interface ReducerContext {
    defaults: AriaDefaults;
    /** Layers as loaded from disk (the baseline pending edits are compared against). */
    saved: ScopedEntries;
    catalog: CatalogState;
}
export declare function initialManagerState(scope?: ConfigScope): ManagerState;
/**
 * Pure keyboard reducer. Returns the next state plus an optional effect for
 * the caller to perform (save with validation and persistence, or exit).
 */
export declare function reduceKey(state: ManagerState, event: KeyEvent, ctx: ReducerContext): {
    state: ManagerState;
    effect?: ManagerEffect;
};
//# sourceMappingURL=model-manager-state.d.ts.map