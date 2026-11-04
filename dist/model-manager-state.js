import { ROLES, resolveRoleRoute } from "./overrides.js";
export const SCOPES = ["global", "project"];
export function emptyPending() {
    return { global: {}, project: {} };
}
/** True when a layer entry sets at least one field. */
function entryIsSet(entry) {
    return !!entry && (entry.model !== undefined || entry.variant !== undefined);
}
function copyEntry(entry) {
    const copy = {};
    if (entry.model !== undefined)
        copy.model = entry.model;
    if (entry.variant !== undefined)
        copy.variant = entry.variant;
    return copy;
}
/** Equality of two layer entries, treating an unset entry as absent. */
export function sameEntry(a, b) {
    const left = entryIsSet(a) ? a : undefined;
    const right = entryIsSet(b) ? b : undefined;
    if (!left || !right)
        return left === right;
    return left.model === right.model && left.variant === right.variant;
}
/** Drop pending edits that equal the saved layer, so only real changes remain. */
export function normalizePending(saved, pending) {
    const out = emptyPending();
    for (const scope of SCOPES) {
        for (const role of ROLES) {
            const edit = pending[scope][role];
            if (edit === undefined)
                continue;
            const target = entryIsSet(edit) ? copyEntry(edit) : undefined;
            if (sameEntry(target, saved[scope][role]))
                continue;
            out[scope][role] = target ?? null;
        }
    }
    return out;
}
/** Layers with the pending edits applied, as they would be persisted. */
export function applyPending(saved, pending) {
    const apply = (scope) => {
        const next = { ...saved[scope] };
        for (const role of ROLES) {
            const edit = pending[scope][role];
            if (edit === undefined)
                continue;
            if (entryIsSet(edit))
                next[role] = copyEntry(edit);
            else
                delete next[role];
        }
        return next;
    };
    return { global: apply("global"), project: apply("project") };
}
/** Pending edits as an ordered list for display and summaries. */
export function pendingEntries(pending) {
    const out = [];
    for (const scope of SCOPES) {
        for (const role of ROLES) {
            const edit = pending[scope][role];
            if (edit !== undefined)
                out.push({ scope, role, edit });
        }
    }
    return out;
}
export function pendingCount(pending) {
    return pendingEntries(pending).length;
}
/**
 * Effective assignment per role using the runtime precedence. A project layer
 * that sets any field owns the assignment ("project"); otherwise a global
 * layer that sets any field ("global"); otherwise the packaged default.
 */
export function resolveEffective(defaults, layers) {
    return ROLES.map((role) => {
        const roleDefaults = defaults.roles[role];
        const globalEntry = layers.global[role];
        const projectEntry = layers.project[role];
        const { model, variant } = resolveRoleRoute(roleDefaults, globalEntry, projectEntry);
        const source = entryIsSet(projectEntry)
            ? "project"
            : entryIsSet(globalEntry)
                ? "global"
                : "default";
        return { role, model, variant, source };
    });
}
/** `provider/model` with an optional ` (variant)` suffix. */
export function describeRoute(model, variant) {
    return variant === undefined ? model : `${model} (${variant})`;
}
/** Short status for a route against the catalog; empty when nothing is wrong. */
export function routeStatus(route, models) {
    if (models === undefined)
        return "catalog unavailable";
    const model = models.find((candidate) => candidate.id === route.model);
    if (!model)
        return "not in OpenCode catalog";
    if (route.variant === undefined)
        return "";
    if (model.variantsObservable !== true)
        return "variant unverified";
    return model.variants.includes(route.variant) ? "" : "variant unsupported";
}
/** Case-insensitive substring filter over model identifiers; catalog order kept. */
export function filterModels(models, query) {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0)
        return [...models];
    return models.filter((model) => model.id.toLowerCase().includes(needle));
}
/**
 * Variant choices for a model. Variants are exactly what the catalog reports;
 * nothing is guessed. When metadata is unobservable only the no-variant choice
 * is offered, plus the current variant (explicitly unverified) when the model
 * is already the assigned one.
 */
export function variantChoices(model, currentVariant) {
    const options = [{ label: "default (no explicit variant)", variant: undefined }];
    if (model.variantsObservable !== true) {
        if (currentVariant !== undefined) {
            options.push({ label: `keep current: ${currentVariant} (unverified)`, variant: currentVariant });
        }
        return {
            options,
            notice: "Variant metadata is unavailable for this model, so variants cannot be verified. Only the no-variant choice is offered.",
        };
    }
    for (const variant of model.variants)
        options.push({ label: variant, variant });
    return {
        options,
        notice: model.variants.length === 0 ? "This model reports no reasoning variants." : undefined,
    };
}
/**
 * Save-time validation of pending edits against a fresh catalog. Returns human
 * readable errors; an empty list means every pending edit is safe to persist.
 */
export function validatePending(pending, models) {
    const errors = [];
    for (const { scope, role, edit } of pendingEntries(pending)) {
        if (edit === null)
            continue;
        const where = `${scope} ${role}`;
        const model = models.find((candidate) => candidate.id === edit.model);
        if (!model) {
            errors.push(`${where}: model ${edit.model} is no longer listed by OpenCode`);
            continue;
        }
        if (edit.variant === undefined)
            continue;
        if (model.variantsObservable !== true) {
            errors.push(`${where}: variant ${edit.variant} cannot be verified for ${edit.model}`);
        }
        else if (!model.variants.includes(edit.variant)) {
            errors.push(`${where}: variant ${edit.variant} is not supported by ${edit.model}`);
        }
    }
    return errors;
}
export function initialManagerState(scope = "global") {
    return {
        scope,
        roleIndex: 0,
        screen: { kind: "main" },
        pending: emptyPending(),
        notice: undefined,
        saving: false,
    };
}
/**
 * Printable text carried by an event. Terminals may deliver a fast or pasted
 * burst as one multi-character input, so any run of printable characters
 * counts; control sequences (escape codes, Enter, Tab, DEL) never do.
 */
function printableText(event) {
    if (event.input.length === 0)
        return undefined;
    for (const char of event.input) {
        if (char < " " || char === "\x7f")
            return undefined;
    }
    return event.input;
}
function withNotice(state, notice) {
    return { ...state, notice };
}
/** Record a pending edit for one scope and role, dropping it when it matches the saved layer. */
function setPending(state, ctx, scope, role, edit) {
    const next = {
        global: { ...state.pending.global },
        project: { ...state.pending.project },
    };
    next[scope][role] = edit;
    return { ...state, pending: normalizePending(ctx.saved, next) };
}
function clampCursor(cursor, length) {
    if (length <= 0)
        return 0;
    return Math.min(Math.max(cursor, 0), length - 1);
}
function effectiveFor(state, ctx, role) {
    const layers = applyPending(ctx.saved, state.pending);
    const route = resolveEffective(ctx.defaults, layers).find((candidate) => candidate.role === role);
    if (!route)
        throw new Error(`unknown ARIA role: ${role}`);
    return route;
}
function enterModelScreen(state, ctx, searching) {
    const role = ROLES[state.roleIndex];
    if (!role)
        return state;
    if (ctx.catalog.status === "loading") {
        return withNotice(state, { tone: "info", text: "Model catalog is still loading; try again in a moment." });
    }
    if (ctx.catalog.status === "failed") {
        return withNotice(state, {
            tone: "error",
            text: `Model catalog unavailable (${ctx.catalog.error}); editing is disabled. Press Esc to exit.`,
        });
    }
    const current = effectiveFor(state, ctx, role);
    const models = ctx.catalog.models;
    const cursor = Math.max(0, models.findIndex((model) => model.id === current.model));
    return {
        ...state,
        notice: undefined,
        screen: { kind: "model", role, query: "", searching, cursor },
    };
}
/**
 * Pure keyboard reducer. Returns the next state plus an optional effect for
 * the caller to perform (save with validation and persistence, or exit).
 */
export function reduceKey(state, event, ctx) {
    if (state.saving)
        return { state };
    switch (state.screen.kind) {
        case "main":
            return reduceMain(state, event, ctx);
        case "model":
            return { state: reduceModel(state, state.screen, event, ctx) };
        case "variant":
            return { state: reduceVariant(state, state.screen, event, ctx) };
    }
}
function reduceMain(state, event, ctx) {
    if (event.upArrow)
        return { state: withNotice({ ...state, roleIndex: clampCursor(state.roleIndex - 1, ROLES.length) }, undefined) };
    if (event.downArrow)
        return { state: withNotice({ ...state, roleIndex: clampCursor(state.roleIndex + 1, ROLES.length) }, undefined) };
    if (event.tab) {
        const scope = state.scope === "global" ? "project" : "global";
        return { state: withNotice({ ...state, scope }, { tone: "info", text: `Editing ${scope} scope.` }) };
    }
    if (event.returnKey)
        return { state: enterModelScreen(state, ctx, false) };
    const text = printableText(event);
    if (text !== undefined && text.startsWith("/")) {
        const entered = enterModelScreen(state, ctx, true);
        if (entered.screen.kind !== "model" || text.length === 1)
            return { state: entered };
        return { state: { ...entered, screen: { ...entered.screen, query: text.slice(1) } } };
    }
    if (event.input === "s" || event.input === "S") {
        if (pendingCount(state.pending) === 0) {
            return { state: withNotice(state, { tone: "info", text: "No pending changes to save." }) };
        }
        return { state: { ...state, saving: true, notice: { tone: "info", text: "Validating and saving..." } }, effect: { kind: "save" } };
    }
    if (event.input === "r" || event.input === "R")
        return { state: removeOverride(state, ctx) };
    if (event.escape) {
        const count = pendingCount(state.pending);
        if (count > 0) {
            return {
                state: { ...state, pending: emptyPending(), notice: { tone: "info", text: `Discarded ${count} pending change${count === 1 ? "" : "s"}. Nothing was written.` } },
            };
        }
        return { state, effect: { kind: "exit" } };
    }
    return { state };
}
/** Remove the active scope's override for the selected role (global: reset to packaged default). */
function removeOverride(state, ctx) {
    const role = ROLES[state.roleIndex];
    if (!role)
        return state;
    const pendingEdit = state.pending[state.scope][role];
    if (pendingEdit === null) {
        return withNotice(state, { tone: "info", text: `${role} already inherits in ${state.scope} scope (pending).` });
    }
    const saved = ctx.saved[state.scope][role];
    if (pendingEdit === undefined && !entryIsSet(saved)) {
        const where = state.scope === "project" ? "project override" : "global override";
        return withNotice(state, { tone: "info", text: `No ${where} for ${role}; nothing to remove.` });
    }
    const next = setPending(state, ctx, state.scope, role, null);
    const label = state.scope === "project" ? "inherit the global assignment" : "use the ARIA default";
    return withNotice(next, { tone: "ok", text: `${role}: ${state.scope} override removed (will ${label}).` });
}
function reduceModel(state, screen, event, ctx) {
    const models = ctx.catalog.status === "ready" ? ctx.catalog.models : [];
    const filtered = filterModels(models, screen.query);
    const setScreen = (next) => ({
        ...state,
        screen: { ...screen, ...next },
    });
    if (event.escape) {
        if (screen.searching || screen.query.length > 0)
            return setScreen({ query: "", searching: false, cursor: 0 });
        return { ...state, screen: { kind: "main" }, notice: undefined };
    }
    if (event.upArrow)
        return setScreen({ cursor: clampCursor(screen.cursor - 1, filtered.length) });
    if (event.downArrow)
        return setScreen({ cursor: clampCursor(screen.cursor + 1, filtered.length) });
    if (event.returnKey) {
        const chosen = filtered[clampCursor(screen.cursor, filtered.length)];
        if (!chosen)
            return withNotice(state, { tone: "error", text: "No models match the search." });
        const current = effectiveFor(state, ctx, screen.role);
        const sameModel = chosen.id === current.model;
        const variantCursor = sameModel
            ? Math.max(0, variantChoices(chosen, current.variant).options.findIndex((option) => option.variant === current.variant))
            : 0;
        return {
            ...state,
            screen: { kind: "variant", role: screen.role, model: chosen.id, cursor: variantCursor },
            notice: undefined,
        };
    }
    if (event.backspace && screen.searching)
        return setScreen({ query: screen.query.slice(0, -1), cursor: 0 });
    const text = printableText(event);
    if (screen.searching && text !== undefined)
        return setScreen({ query: screen.query + text, cursor: 0 });
    if (!screen.searching && text !== undefined && text.startsWith("/")) {
        return setScreen({ searching: true, query: screen.query + text.slice(1), cursor: 0 });
    }
    return state;
}
function reduceVariant(state, screen, event, ctx) {
    const catalogModel = ctx.catalog.status === "ready" ? ctx.catalog.models.find((model) => model.id === screen.model) : undefined;
    const currentRoute = effectiveFor(state, ctx, screen.role);
    const choices = catalogModel
        ? variantChoices(catalogModel, currentRoute.model === screen.model ? currentRoute.variant : undefined)
        : { options: [] };
    const back = {
        ...state,
        screen: { kind: "model", role: screen.role, query: "", searching: false, cursor: 0 },
        notice: undefined,
    };
    if (event.escape)
        return back;
    if (event.upArrow)
        return { ...state, screen: { ...screen, cursor: clampCursor(screen.cursor - 1, choices.options.length) } };
    if (event.downArrow)
        return { ...state, screen: { ...screen, cursor: clampCursor(screen.cursor + 1, choices.options.length) } };
    if (event.returnKey) {
        const option = choices.options[clampCursor(screen.cursor, choices.options.length)];
        if (!catalogModel || !option)
            return withNotice(state, { tone: "error", text: "Model is no longer available." });
        const edit = option.variant === undefined
            ? { model: screen.model }
            : { model: screen.model, variant: option.variant };
        const next = setPending({ ...state, screen: { kind: "main" } }, ctx, state.scope, screen.role, edit);
        const chosen = describeRoute(screen.model, edit.variant);
        if (next.pending[state.scope][screen.role] === undefined) {
            // Equal to the saved layer: nothing to save, and any earlier pending edit for this role is cleared.
            return withNotice(next, { tone: "info", text: `${screen.role}: ${chosen} already saved in ${state.scope} scope; no change.` });
        }
        return withNotice(next, { tone: "ok", text: `${screen.role}: ${state.scope} -> ${chosen} (pending, press S to save).` });
    }
    return state;
}
//# sourceMappingURL=model-manager-state.js.map