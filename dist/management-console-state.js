export const MENU_ITEMS = [
    { id: "models", label: "Models & Agents", hint: "model and reasoning-variant assignments" },
    { id: "setup", label: "Setup & Repair", hint: "installation, registration, managed config" },
    { id: "doctor", label: "Doctor", hint: "diagnostics and configuration validation" },
    { id: "plugins", label: "Plugins & MCPs", hint: "installed integrations, versions, status" },
    { id: "updates", label: "Updates", hint: "ARIA and managed dependency upgrades" },
];
const TOOL_TITLES = {
    setup: "Setup & Repair",
    doctor: "Doctor",
    plugins: "Plugins & MCPs",
    updates: "Updates",
};
const ACTION_SCREEN = {
    inspect: "setup",
    setup: "setup",
    doctor: "doctor",
    plugins: "plugins",
    "check-aria": "updates",
    "apply-aria": "updates",
    "check-deps": "updates",
    "apply-deps": "updates",
    "check-optional": "setup",
    "apply-optional": "setup",
};
const MUTATING_ACTIONS = new Set(["setup", "apply-aria", "apply-deps", "apply-optional"]);
const CONFIRM_LINES = {
    setup: [
        "Run ARIA setup and reconciliation.",
        "This may register the ARIA plugin, write the global OpenCode config and managed agent files,",
        "and install missing dependencies. Existing unrelated configuration is preserved.",
    ],
    "apply-aria": [
        "Apply the ARIA update shown above.",
        "This replaces the ARIA plugin registration with the target release and hands off to it.",
    ],
    "apply-deps": [
        "Apply the managed dependency upgrades shown above.",
        "Unknown or unmanaged components stay report-only, and missing installs are not created here.",
    ],
    "apply-optional": [
        "Install the optional dependencies listed above, with your consent.",
        "Required dependencies are already present. Existing installs are left untouched.",
    ],
};
export const PANEL_WRAP_WIDTH = 72;
const PAGE = 10;
export function initialConsoleState(status) {
    return {
        screen: "menu",
        menuCursor: 0,
        status,
        cursor: { setup: 0, doctor: 0, plugins: 0, updates: 0 },
    };
}
export function toolTitle(screen) {
    return TOOL_TITLES[screen];
}
/** Plain-text wrapping for panel lines, so scroll bounds equal displayed rows. */
export function wrapPlain(text, width = PANEL_WRAP_WIDTH) {
    if (text.length <= width)
        return [text];
    const out = [];
    let rest = text;
    while (rest.length > width) {
        let cut = rest.lastIndexOf(" ", width);
        if (cut <= 0)
            cut = width;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, "");
    }
    out.push(rest);
    return out;
}
export function summarizeFindings(findings) {
    const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
    for (const finding of findings)
        counts[finding.severity] += 1;
    return counts;
}
function listCount(state, screen) {
    if (screen === "setup")
        return 4;
    if (screen === "updates")
        return 2;
    if (screen === "doctor")
        return state.findings ? state.findings.length : 1;
    return state.entries ? state.entries.length : 1;
}
function clamp(value, length) {
    if (length <= 0)
        return 0;
    return Math.min(Math.max(value, 0), length - 1);
}
function setCursor(state, screen, value) {
    return { ...state, cursor: { ...state.cursor, [screen]: value } };
}
function startRun(state, action) {
    if (state.running) {
        return { state: { ...state, notice: { tone: "info", text: "Another operation is still running; wait for it to finish." } } };
    }
    const screen = ACTION_SCREEN[action];
    const running = { screen, action, mutating: MUTATING_ACTIONS.has(action), startedAt: Date.now() };
    return {
        state: { ...state, running, confirm: undefined, notice: undefined },
        effect: { kind: "run", screen, action },
    };
}
function requestConfirm(state, screen, action) {
    if (state.running) {
        return { state: { ...state, notice: { tone: "info", text: "Another operation is still running; wait for it to finish." } } };
    }
    return { state: { ...state, confirm: { screen, action, lines: CONFIRM_LINES[action] ?? [] }, notice: undefined } };
}
function findingPanel(finding) {
    const lines = [
        `Severity: ${finding.severity}`,
        `Area: ${finding.area}`,
        `Title: ${finding.title}`,
        "",
        ...(finding.detail ? wrapPlain(finding.detail) : ["(no further detail)"]),
    ];
    return { screen: "doctor", title: "Finding detail", lines, scroll: 0 };
}
function entryPanel(entry) {
    const lines = [
        `Kind: ${entry.kind}`,
        `Name: ${entry.name}`,
        `ARIA component: ${entry.component ?? "not an ARIA dependency"}`,
        `Installed: ${entry.version ?? "unknown"}`,
        `Runtime: ${entry.runtime}`,
        `Ownership: ${entry.ownership}`,
        `Source: ${entry.source ?? "effective OpenCode config"}`,
        `Mechanism: ${entry.mechanism ?? "none"}`,
        `Action: ${entry.action}`,
        `Blocker: ${entry.blocker ?? "none"}`,
    ];
    return { screen: "plugins", title: "Integration detail", lines: lines.flatMap((line) => wrapPlain(line)), scroll: 0 };
}
function activate(state, screen) {
    const index = state.cursor[screen];
    if (screen === "setup") {
        if (index === 0)
            return startRun(state, "inspect");
        if (index === 1)
            return requestConfirm(state, "setup", "setup");
        if (index === 2)
            return startRun(state, "check-optional");
        if (!state.lastResult)
            return { state: { ...state, notice: { tone: "info", text: "No setup operation has run in this session yet." } } };
        return {
            state: {
                ...state,
                panel: { screen: "setup", title: state.lastResult.title, lines: state.lastResult.lines, scroll: 0 },
                notice: undefined,
            },
        };
    }
    if (screen === "updates")
        return startRun(state, index === 0 ? "check-aria" : "check-deps");
    if (screen === "doctor") {
        if (!state.findings)
            return startRun(state, "doctor");
        const finding = state.findings[index];
        if (!finding)
            return { state };
        return { state: { ...state, panel: findingPanel(finding), notice: undefined } };
    }
    if (!state.entries)
        return startRun(state, "plugins");
    const entry = state.entries[index];
    if (!entry)
        return { state };
    return { state: { ...state, panel: entryPanel(entry), notice: undefined } };
}
function reduceMenu(state, key) {
    const count = MENU_ITEMS.length;
    if (key.upArrow)
        return { state: { ...state, menuCursor: clamp(state.menuCursor - 1, count) } };
    if (key.downArrow)
        return { state: { ...state, menuCursor: clamp(state.menuCursor + 1, count) } };
    if (key.returnKey) {
        const item = MENU_ITEMS[state.menuCursor];
        if (!item)
            return { state };
        if (item.id === "models")
            return { state, effect: { kind: "open-models" } };
        return { state: { ...state, screen: item.id, notice: undefined } };
    }
    if (key.input === "q" || key.input === "Q")
        return { state, effect: { kind: "exit" } };
    if (key.escape)
        return { state: { ...state, notice: { tone: "info", text: "Press Q to quit the console." } } };
    return { state };
}
function reduceConfirm(state, key) {
    const confirm = state.confirm;
    if (!confirm)
        return { state };
    if (key.input === "y" || key.input === "Y")
        return startRun(state, confirm.action);
    if (key.input === "n" || key.input === "N" || key.escape) {
        return { state: { ...state, confirm: undefined, notice: { tone: "info", text: "Cancelled. Nothing was changed." } } };
    }
    return { state };
}
function reducePanel(state, screen, key) {
    const panel = state.panel;
    if (!panel)
        return { state };
    const last = Math.max(0, panel.lines.length - 1);
    const scrollTo = (value) => ({
        state: { ...state, panel: { ...panel, scroll: Math.min(Math.max(value, 0), last) } },
    });
    if (key.upArrow)
        return scrollTo(panel.scroll - 1);
    if (key.downArrow)
        return scrollTo(panel.scroll + 1);
    if (key.pageUp)
        return scrollTo(panel.scroll - PAGE);
    if (key.pageDown)
        return scrollTo(panel.scroll + PAGE);
    if (key.escape)
        return { state: { ...state, panel: undefined, notice: undefined } };
    if ((key.input === "a" || key.input === "A") && panel.offer) {
        return requestConfirm(state, screen, panel.offer);
    }
    return { state };
}
function reduceList(state, screen, key) {
    const index = state.cursor[screen];
    const count = listCount(state, screen);
    if (key.upArrow)
        return { state: setCursor(state, screen, clamp(index - 1, count)) };
    if (key.downArrow)
        return { state: setCursor(state, screen, clamp(index + 1, count)) };
    if (key.returnKey)
        return activate(state, screen);
    if ((key.input === "r" || key.input === "R") && (screen === "doctor" || screen === "plugins")) {
        return startRun(state, screen === "doctor" ? "doctor" : "plugins");
    }
    if (key.escape)
        return { state: { ...state, screen: "menu", notice: undefined } };
    return { state };
}
function reduceTool(state, screen, key) {
    if (state.confirm && state.confirm.screen === screen)
        return reduceConfirm(state, key);
    if (state.running) {
        if (key.escape) {
            if (state.running.mutating) {
                return { state: { ...state, notice: { tone: "info", text: "An operation is changing configuration; wait for it to finish." } } };
            }
            return { state: { ...state, screen: "menu", notice: { tone: "info", text: "Read-only check continues in the background." } } };
        }
        return { state };
    }
    if (state.panel && state.panel.screen === screen)
        return reducePanel(state, screen, key);
    return reduceList(state, screen, key);
}
function applyOutcome(state, outcome) {
    const base = { ...state, running: undefined };
    const screen = ACTION_SCREEN[outcome.action];
    const failText = outcome.lines[0] ?? "The operation failed.";
    if (outcome.action === "doctor") {
        if (!outcome.ok || !outcome.findings) {
            return {
                ...base,
                panel: { screen, title: "Doctor failed", lines: outcome.lines.length > 0 ? outcome.lines : [failText], scroll: 0 },
                notice: { tone: "error", text: `Diagnostics failed: ${failText}` },
            };
        }
        const counts = summarizeFindings(outcome.findings);
        return {
            ...base,
            findings: outcome.findings,
            cursor: { ...state.cursor, doctor: 0 },
            notice: {
                tone: counts.FAIL > 0 ? "error" : counts.WARN > 0 ? "info" : "ok",
                text: `Diagnostics: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP. Press R to rerun.`,
            },
        };
    }
    if (outcome.action === "plugins") {
        if (!outcome.ok || !outcome.entries) {
            return {
                ...base,
                panel: { screen, title: "Inventory failed", lines: outcome.lines.length > 0 ? outcome.lines : [failText], scroll: 0 },
                notice: { tone: "error", text: `Inventory failed: ${failText}` },
            };
        }
        return {
            ...base,
            entries: outcome.entries,
            cursor: { ...state.cursor, plugins: 0 },
            notice: { tone: "ok", text: `Loaded ${outcome.entries?.length ?? 0} integrations (local probes only).` },
        };
    }
    if (outcome.action === "check-aria" || outcome.action === "check-deps" || outcome.action === "check-optional") {
        const applyAction = outcome.action === "check-aria"
            ? "apply-aria"
            : outcome.action === "check-deps"
                ? "apply-deps"
                : "apply-optional";
        if (!outcome.ok) {
            return {
                ...base,
                panel: { screen, title: "Update check failed", lines: outcome.lines.length > 0 ? outcome.lines : [failText], scroll: 0 },
                notice: { tone: "error", text: `Update check failed: ${failText}` },
            };
        }
        const offer = outcome.applicable ? applyAction : undefined;
        return {
            ...base,
            panel: {
                screen,
                title: outcome.action === "check-aria"
                    ? "ARIA update preview"
                    : outcome.action === "check-deps"
                        ? "Dependency upgrade preview"
                        : "Optional dependencies",
                lines: outcome.lines.flatMap((line) => wrapPlain(line)),
                scroll: 0,
                offer,
            },
            notice: offer
                ? { tone: "info", text: "Preview ready. Press A to apply (asks for confirmation), Esc to close." }
                : { tone: "info", text: "Nothing to apply from this preview." },
        };
    }
    // inspect, setup, apply-*: operations whose output is the result text.
    const title = outcome.action === "inspect"
        ? "Installation status"
        : outcome.action === "setup"
            ? "Setup result"
            : outcome.action === "apply-optional"
                ? "Optional install result"
                : "Update result";
    const lines = outcome.lines.flatMap((line) => wrapPlain(line));
    return {
        ...base,
        lastResult: { title, lines },
        panel: { screen, title, lines, scroll: 0 },
        notice: outcome.ok
            ? { tone: "ok", text: `${title}: completed.` }
            : { tone: "error", text: `${title}: ${failText}` },
    };
}
export function reduceConsole(state, event) {
    switch (event.type) {
        case "key": {
            const key = event.key;
            // Ctrl chords are owned by the host (Ctrl+C exits safely).
            if (key.ctrl)
                return { state };
            if (state.screen === "menu")
                return reduceMenu(state, key);
            if (state.screen === "models")
                return { state };
            return reduceTool(state, state.screen, key);
        }
        case "result":
            return { state: applyOutcome(state, event.outcome) };
        case "models-open":
            return { state: { ...state, screen: "models", notice: undefined } };
        case "models-closed":
            return { state: { ...state, screen: "menu", notice: event.notice, status: event.status } };
    }
}
/** Title shown in the header for the current screen. */
export function screenTitle(screen) {
    if (screen === "menu")
        return "ARIA Management Console";
    if (screen === "models")
        return "ARIA Management Console › Models & Agents";
    return `ARIA Management Console › ${toolTitle(screen)}`;
}
/** Whether a key press belongs to the console (vs. the embedded Model Manager). */
export function consoleOwnsKeys(state) {
    return state.screen !== "models";
}
//# sourceMappingURL=management-console-state.js.map