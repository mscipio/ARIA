import { createElement as h, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ROLES } from "./overrides.js";
import { applyPending, describeRoute, filterModels, initialManagerState, pendingCount, pendingEntries, reduceKey, resolveEffective, routeStatus, variantChoices, } from "./model-manager-state.js";
const MODEL_LIST_ROWS = 10;
const MIN_MODEL_COLUMN = 24;
const SOURCE_COLUMN = 8;
const VARIANT_COLUMN = 10;
const ROLE_COLUMN = 11;
function pad(text, width) {
    return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}
export function fit(text, width) {
    if (text.length <= width)
        return text;
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
function noticeColor(tone) {
    if (tone === "ok")
        return "green";
    if (tone === "error")
        return "red";
    if (tone === "info")
        return "yellow";
    return undefined;
}
function windowStart(cursor, length, size) {
    return Math.min(Math.max(0, cursor - Math.floor(size / 2)), Math.max(0, length - size));
}
function catalogLine(catalog) {
    if (catalog.status === "loading")
        return { text: "Loading OpenCode model catalog...", dim: true };
    if (catalog.status === "failed") {
        return { text: `Model catalog unavailable: ${catalog.error}. Editing is disabled; press Esc to exit.`, color: "red" };
    }
    return { text: `${catalog.models.length} models enabled and available in this OpenCode environment.`, dim: true };
}
function scopeLabel(state) {
    return state.scope === "global" ? "GLOBAL" : "PROJECT";
}
/** Lines of the main assignment table. */
function mainLines(state, snapshot, catalog, width) {
    const models = catalog.status === "ready" ? catalog.models : undefined;
    const preview = resolveEffective(snapshot.defaults, applyPending(snapshot.saved, state.pending));
    const longest = Math.max(MIN_MODEL_COLUMN, ...preview.map((route) => route.model.length));
    const modelWidth = Math.min(longest, Math.max(MIN_MODEL_COLUMN, width - (ROLE_COLUMN + VARIANT_COLUMN + SOURCE_COLUMN + 30)));
    const count = pendingCount(state.pending);
    const lines = [
        { text: `ARIA model manager   editing scope: ${scopeLabel(state)}  (Tab to switch)`, bold: true },
        { text: fit(`global   ${snapshot.paths.global.source ?? `(none; writes ${snapshot.paths.global.target})`}`, width), dim: true },
        { text: fit(`project  ${snapshot.paths.project.source ?? `(none; writes ${snapshot.paths.project.target})`}`, width), dim: true },
        catalogLine(catalog),
        { text: "" },
        { text: `    ${pad("ROLE", ROLE_COLUMN)} ${pad("MODEL", modelWidth)} ${pad("VARIANT", VARIANT_COLUMN)} ${pad("SOURCE", SOURCE_COLUMN)} STATUS`, dim: true },
    ];
    ROLES.forEach((role, index) => {
        const route = preview[index];
        if (!route)
            return;
        const selected = index === state.roleIndex;
        const changed = pendingEntries(state.pending).some((entry) => entry.role === role);
        const marker = `${selected ? ">" : " "} ${changed ? "*" : " "}`;
        const variantText = route.variant ?? "-";
        const status = routeStatus(route, models);
        const text = `${marker} ${pad(role, ROLE_COLUMN)} ${pad(fit(route.model, modelWidth), modelWidth)} ${pad(variantText, VARIANT_COLUMN)} ${pad(route.source, SOURCE_COLUMN)} ${status}`;
        lines.push({
            text: fit(text, width),
            color: selected ? "cyan" : changed ? "yellow" : undefined,
            bold: selected,
        });
    });
    lines.push({ text: "" });
    if (count > 0) {
        lines.push({ text: `Pending changes (${count}, not saved yet):`, color: "yellow", bold: true });
        for (const { scope, role, edit } of pendingEntries(state.pending)) {
            const baseline = snapshot.saved[scope][role];
            const from = baseline && (baseline.model !== undefined || baseline.variant !== undefined)
                ? describeRoute(baseline.model ?? "(inherited)", baseline.variant)
                : "(inherit)";
            const to = edit === null ? "remove override" : describeRoute(edit.model ?? "(unset)", edit.variant);
            lines.push({ text: fit(`  ${role} [${scope}]: ${from} -> ${to}`, width), color: "yellow" });
        }
    }
    else {
        lines.push({ text: "No pending changes.", dim: true });
    }
    if (state.notice)
        lines.push({ text: fit(state.notice.text, width), color: noticeColor(state.notice.tone) });
    lines.push({ text: "" });
    lines.push({
        text: "↑/↓ role   Enter model   / search   Tab scope   R remove override   S save   Esc discard/exit",
        dim: true,
    });
    return lines;
}
/** Lines of the searchable model picker for the selected role. */
function modelLines(state, screen, snapshot, catalog, width) {
    const effective = resolveEffective(snapshot.defaults, applyPending(snapshot.saved, state.pending))
        .find((route) => route.role === screen.role);
    const lines = [
        { text: `Model for ${screen.role} · ${scopeLabel(state)} scope`, bold: true },
        { text: fit(`currently: ${effective ? describeRoute(effective.model, effective.variant) : "-"} (${effective?.source ?? "default"})`, width), dim: true },
        { text: "" },
    ];
    const searchText = screen.searching || screen.query.length > 0
        ? `Search: ${screen.query}${screen.searching ? "_" : ""}`
        : "Press / to search models.";
    lines.push({ text: searchText, color: screen.searching ? "yellow" : undefined });
    if (catalog.status !== "ready") {
        lines.push({ text: catalogLine(catalog).text, color: catalog.status === "failed" ? "red" : undefined, dim: catalog.status === "loading" });
    }
    else {
        const filtered = filterModels(catalog.models, screen.query);
        const cursor = Math.min(screen.cursor, Math.max(0, filtered.length - 1));
        const start = windowStart(cursor, filtered.length, MODEL_LIST_ROWS);
        const visible = filtered.slice(start, start + MODEL_LIST_ROWS);
        if (filtered.length === 0)
            lines.push({ text: "  No models match the search.", color: "red" });
        visible.forEach((model, offset) => {
            const index = start + offset;
            const selected = index === cursor;
            const current = effective?.model === model.id ? "  (current)" : "";
            lines.push({
                text: fit(`${selected ? ">" : " "} ${model.id}${current}`, width),
                color: selected ? "cyan" : undefined,
                bold: selected,
            });
        });
        lines.push({ text: `${filtered.length} of ${catalog.models.length} models shown`, dim: true });
    }
    lines.push({ text: "" });
    if (state.notice)
        lines.push({ text: fit(state.notice.text, width), color: noticeColor(state.notice.tone) });
    lines.push({ text: "↑/↓ choose   Enter pick   / search   Esc back (Esc clears search first)", dim: true });
    return lines;
}
/** Lines of the reasoning-variant selector for the chosen model. */
function variantLines(state, screen, snapshot, catalog, width) {
    const effective = resolveEffective(snapshot.defaults, applyPending(snapshot.saved, state.pending))
        .find((route) => route.role === screen.role);
    const model = catalog.status === "ready" ? catalog.models.find((candidate) => candidate.id === screen.model) : undefined;
    const choices = model
        ? variantChoices(model, effective?.model === screen.model ? effective.variant : undefined)
        : { options: [], notice: "Model is no longer listed." };
    const lines = [
        { text: fit(`Variant for ${screen.model}`, width), bold: true },
        { text: `${screen.role} · ${scopeLabel(state)} scope`, dim: true },
        { text: "" },
    ];
    choices.options.forEach((option, index) => {
        const selected = index === screen.cursor;
        const current = effective?.model === screen.model && option.variant === effective.variant ? "  (current)" : "";
        lines.push({
            text: fit(`${selected ? ">" : " "} ${option.label}${current}`, width),
            color: selected ? "cyan" : undefined,
            bold: selected,
        });
    });
    if (choices.notice)
        lines.push({ text: fit(choices.notice, width), color: "yellow" });
    lines.push({ text: "" });
    if (state.notice)
        lines.push({ text: fit(state.notice.text, width), color: noticeColor(state.notice.tone) });
    lines.push({ text: "↑/↓ choose   Enter apply   Esc back", dim: true });
    return lines;
}
export function linesFor(state, snapshot, catalog, width) {
    switch (state.screen.kind) {
        case "main":
            return mainLines(state, snapshot, catalog, width);
        case "model":
            return modelLines(state, state.screen, snapshot, catalog, width);
        case "variant":
            return variantLines(state, state.screen, snapshot, catalog, width);
    }
}
export function renderLines(lines) {
    return h(Box, { flexDirection: "column" }, ...lines.map((line, index) => h(Text, { key: index, color: line.color, bold: line.bold, dimColor: line.dim, wrap: "truncate-end" }, line.text.length > 0 ? line.text : " ")));
}
function describeFailure(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Interactive manager root component. */
export function ModelManagerApp(props) {
    const app = useApp();
    const { stdout } = useStdout();
    const [catalog, setCatalog] = useState({ status: "loading" });
    const [state, setState] = useState(() => initialManagerState(props.initialScope ?? "global"));
    const stateRef = useRef(state);
    const catalogRef = useRef(catalog);
    const finishedRef = useRef(false);
    useEffect(() => {
        let alive = true;
        props.discover().then((models) => {
            if (!alive)
                return;
            catalogRef.current = { status: "ready", models };
            setCatalog(catalogRef.current);
        }, (error) => {
            if (!alive)
                return;
            catalogRef.current = { status: "failed", error: describeFailure(error) };
            setCatalog(catalogRef.current);
        });
        return () => {
            alive = false;
        };
        // Discovery runs once per mounted manager; `props.discover` is stable for its lifetime.
    }, []);
    const commit = (next) => {
        stateRef.current = next;
        setState(next);
    };
    const finish = (outcome) => {
        if (finishedRef.current)
            return;
        finishedRef.current = true;
        props.onFinish(outcome);
        if (!props.embedded)
            app.exit();
    };
    const runSave = async () => {
        const outcome = await props.save(stateRef.current.pending).catch((error) => ({ status: "failed", error: describeFailure(error) }));
        if (outcome.status === "failed") {
            commit({ ...stateRef.current, saving: false, notice: { tone: "error", text: outcome.error } });
            return;
        }
        finish(outcome);
    };
    useInput((input, key) => {
        // Ctrl chords belong to the host (Ctrl+C exits); they must never edit the search text.
        if (key.ctrl)
            return;
        const event = {
            input,
            upArrow: key.upArrow,
            downArrow: key.downArrow,
            returnKey: key.return,
            escape: key.escape,
            tab: key.tab,
            backspace: key.backspace || key.delete,
        };
        const context = {
            defaults: props.snapshot.defaults,
            saved: props.snapshot.saved,
            catalog: catalogRef.current,
        };
        const result = reduceKey(stateRef.current, event, context);
        commit(result.state);
        if (result.effect?.kind === "exit")
            finish(undefined);
        if (result.effect?.kind === "save")
            void runSave();
    });
    const width = Math.max(40, stdout.columns ?? 100);
    return renderLines(linesFor(state, props.snapshot, catalog, width));
}
//# sourceMappingURL=model-manager-tui.js.map