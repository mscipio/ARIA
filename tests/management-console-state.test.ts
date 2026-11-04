import { describe, expect, it } from "vitest";

import type { DoctorFinding } from "../src/doctor";
import {
  initialConsoleState,
  reduceConsole,
  summarizeFindings,
  wrapPlain,
  type ActionOutcome,
  type ConsoleEffect,
  type ConsoleKey,
  type ConsoleState,
  type MenuStatus,
} from "../src/management-console-state";
import type { IntegrationEntry } from "../src/integrations";

const STATUS: MenuStatus = {
  version: "1.3.4-rc.7",
  globalConfig: true,
  projectConfig: false,
  managedAgents: 10,
  totalAgents: 10,
};

const KEY = {
  down: { input: "", downArrow: true } satisfies ConsoleKey,
  up: { input: "", upArrow: true } satisfies ConsoleKey,
  enter: { input: "", returnKey: true } satisfies ConsoleKey,
  esc: { input: "", escape: true } satisfies ConsoleKey,
  pageDown: { input: "", pageDown: true } satisfies ConsoleKey,
  char: (input: string): ConsoleKey => ({ input }),
};

function key(state: ConsoleState, k: ConsoleKey): { state: ConsoleState; effect?: ConsoleEffect } {
  return reduceConsole(state, { type: "key", key: k });
}

/** Feed keys, collecting every effect the reducer requested. */
function run(start: ConsoleState, keys: ConsoleKey[]): { state: ConsoleState; effects: ConsoleEffect[] } {
  let state = start;
  const effects: ConsoleEffect[] = [];
  for (const k of keys) {
    const result = key(state, k);
    state = result.state;
    if (result.effect) effects.push(result.effect);
  }
  return { state, effects };
}

function onScreen(screen: "setup" | "doctor" | "plugins" | "updates"): ConsoleState {
  const start = initialConsoleState(STATUS);
  const index = { setup: 1, doctor: 2, plugins: 3, updates: 4 }[screen];
  const keys = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
  return run(start, keys).state;
}

function finding(severity: DoctorFinding["severity"], title: string, detail?: string): DoctorFinding {
  return { severity, area: "config", title, detail };
}

function entry(name: string, ownership: IntegrationEntry["ownership"]): IntegrationEntry {
  return {
    kind: "mcp",
    name,
    component: null,
    required: null,
    version: "1.0.0",
    source: null,
    runtime: "connected",
    ownership,
    mechanism: null,
    action: "none (not an ARIA dependency)",
    blocker: null,
  };
}

describe("menu navigation", () => {
  it("starts on Models & Agents and clamps the cursor at both ends", () => {
    const start = initialConsoleState(STATUS);
    expect(start.menuCursor).toBe(0);
    expect(run(start, [KEY.up, KEY.up]).state.menuCursor).toBe(0);
    expect(run(start, Array.from({ length: 9 }, () => KEY.down)).state.menuCursor).toBe(4);
  });

  it("opens each tool screen on Enter without requesting any service", () => {
    const expected = ["models", "setup", "doctor", "plugins", "updates"] as const;
    expected.forEach((_, index) => {
      const keys = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
      const { effects } = run(initialConsoleState(STATUS), keys);
      if (index === 0) {
        expect(effects).toEqual([{ kind: "open-models" }]);
      } else {
        expect(effects).toEqual([]);
      }
    });
    expect(onScreen("setup").screen).toBe("setup");
    expect(onScreen("doctor").screen).toBe("doctor");
    expect(onScreen("plugins").screen).toBe("plugins");
    expect(onScreen("updates").screen).toBe("updates");
  });

  it("quits only from the main menu with Q, and Esc on the menu does not exit", () => {
    expect(run(initialConsoleState(STATUS), [KEY.esc]).effects).toEqual([]);
    expect(run(initialConsoleState(STATUS), [KEY.char("q")]).effects).toEqual([{ kind: "exit" }]);
    expect(run(initialConsoleState(STATUS), [KEY.char("Q")]).effects).toEqual([{ kind: "exit" }]);
  });

  it("ignores Ctrl chords (the host owns Ctrl+C) and keys while the Model Manager owns input", () => {
    const menu = initialConsoleState(STATUS);
    expect(reduceConsole(menu, { type: "key", key: { input: "q", ctrl: true } }).effect).toBeUndefined();
    const models = reduceConsole(menu, { type: "models-open" }).state;
    expect(reduceConsole(models, { type: "key", key: KEY.char("q") }).effect).toBeUndefined();
    expect(reduceConsole(models, { type: "key", key: KEY.esc }).state.screen).toBe("models");
  });

  it("returns from Models with a notice and refreshed status", () => {
    const opened = reduceConsole(initialConsoleState(STATUS), { type: "models-open" }).state;
    const closed = reduceConsole(opened, {
      type: "models-closed",
      notice: { tone: "info", text: "Models & Agents closed. No changes were written." },
      status: { ...STATUS, projectConfig: true },
    }).state;
    expect(closed.screen).toBe("menu");
    expect(closed.notice?.text).toContain("No changes were written");
    expect(closed.status.projectConfig).toBe(true);
  });
});

describe("opening screens never runs external work", () => {
  it("Doctor and Plugins wait for an explicit Enter/R, and Updates wait for an explicit check", () => {
    expect(run(initialConsoleState(STATUS), [KEY.down, KEY.down, KEY.enter]).effects).toEqual([]);
    expect(run(initialConsoleState(STATUS), [KEY.down, KEY.down, KEY.down, KEY.enter]).effects).toEqual([]);
    expect(run(initialConsoleState(STATUS), [KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter]).effects).toEqual([]);
  });

  it("Setup offers inspection without running a mutation", () => {
    const { effects } = run(onScreen("setup"), [KEY.enter]);
    expect(effects).toEqual([{ kind: "run", screen: "setup", action: "inspect" }]);
  });
});

describe("confirmation before mutation", () => {
  it("Run setup asks first and makes no request until Y", () => {
    const asked = run(onScreen("setup"), [KEY.down, KEY.enter]);
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirm).toMatchObject({ screen: "setup", action: "setup" });
    expect(asked.state.confirm?.lines.join(" ")).toContain("register the ARIA plugin");
  });

  it("N and Esc cancel with zero requests and say nothing changed", () => {
    const asked = run(onScreen("setup"), [KEY.down, KEY.enter]).state;
    const no = run(asked, [KEY.char("n")]);
    expect(no.effects).toEqual([]);
    expect(no.state.confirm).toBeUndefined();
    expect(no.state.notice?.text).toBe("Cancelled. Nothing was changed.");
    const esc = run(asked, [KEY.esc]);
    expect(esc.effects).toEqual([]);
    expect(esc.state.confirm).toBeUndefined();
  });

  it("Y is the only key that starts a setup mutation", () => {
    const asked = run(onScreen("setup"), [KEY.down, KEY.enter]).state;
    expect(run(asked, [KEY.enter]).effects).toEqual([]);
    expect(run(asked, [KEY.char("x")]).effects).toEqual([]);
    const confirmed = run(asked, [KEY.char("y")]);
    expect(confirmed.effects).toEqual([{ kind: "run", screen: "setup", action: "setup" }]);
    expect(confirmed.state.running).toMatchObject({ action: "setup", mutating: true });
  });

  it("applying an update requires previewing, A, then Y; cancel at each step performs nothing", () => {
    const updates = onScreen("updates");
    const checking = run(updates, [KEY.enter]);
    expect(checking.effects).toEqual([{ kind: "run", screen: "updates", action: "check-aria" }]);

    const previewed = reduceConsole(checking.state, {
      type: "result",
      outcome: { action: "check-aria", ok: true, lines: ["Installed: 1.0.0", "Available: 1.1.0"], applicable: true },
    }).state;
    expect(previewed.panel?.offer).toBe("apply-aria");

    const asked = run(previewed, [KEY.char("a")]);
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirm).toMatchObject({ action: "apply-aria" });

    const declined = run(asked.state, [KEY.char("n")]);
    expect(declined.effects).toEqual([]);

    const applied = run(asked.state, [KEY.char("y")]);
    expect(applied.effects).toEqual([{ kind: "run", screen: "updates", action: "apply-aria" }]);
  });

  it("does not offer apply when the preview is not applicable", () => {
    const checking = run(onScreen("updates"), [KEY.enter]).state;
    const previewed = reduceConsole(checking, {
      type: "result",
      outcome: { action: "check-aria", ok: true, lines: ["already current"], applicable: false },
    }).state;
    expect(previewed.panel?.offer).toBeUndefined();
    expect(run(previewed, [KEY.char("a")]).state.confirm).toBeUndefined();
  });
});

describe("running operations", () => {
  it("allows only one operation at a time", () => {
    const busy = run(onScreen("doctor"), [KEY.enter]).state;
    const second = run(busy, [KEY.char("r")]);
    expect(second.effects).toEqual([]);
    expect(second.state.running).toMatchObject({ screen: "doctor", action: "doctor" });
  });

  it("refuses to leave during a configuration change, but allows leaving a read-only check", () => {
    const mutating = run(onScreen("setup"), [KEY.down, KEY.enter, KEY.char("y")]).state;
    const blocked = run(mutating, [KEY.esc]);
    expect(blocked.state.screen).toBe("setup");
    expect(blocked.state.notice?.text).toContain("wait for it to finish");

    const readOnly = run(onScreen("doctor"), [KEY.enter]).state;
    const left = run(readOnly, [KEY.esc]);
    expect(left.state.screen).toBe("menu");
    expect(left.state.running).toBeDefined();
  });

  it("keeps a background read-only result for the screen it belongs to", () => {
    const readOnly = run(onScreen("doctor"), [KEY.enter]).state;
    const left = run(readOnly, [KEY.esc]).state;
    const done = reduceConsole(left, {
      type: "result",
      outcome: { action: "doctor", ok: true, lines: [], findings: [finding("PASS", "ok")] },
    }).state;
    expect(done.running).toBeUndefined();
    expect(done.findings).toHaveLength(1);
  });
});

describe("Doctor", () => {
  it("reports counts and sets the findings list after a run", () => {
    const outcome: ActionOutcome = {
      action: "doctor",
      ok: true,
      lines: [],
      findings: [finding("PASS", "a"), finding("WARN", "b"), finding("FAIL", "c"), finding("SKIP", "d")],
    };
    const done = reduceConsole(run(onScreen("doctor"), [KEY.enter]).state, { type: "result", outcome }).state;
    expect(done.findings).toHaveLength(4);
    expect(done.notice).toMatchObject({ tone: "error" });
    expect(done.notice?.text).toBe("Diagnostics: 1 PASS, 1 WARN, 1 FAIL, 1 SKIP. Press R to rerun.");
    expect(summarizeFindings(done.findings ?? [])).toEqual({ PASS: 1, WARN: 1, FAIL: 1, SKIP: 1 });
  });

  it("opens a finding detail on Enter, scrolls it, and closes it with Esc back to the list", () => {
    const detail = "x ".repeat(120);
    const loaded = {
      ...onScreen("doctor"),
      findings: [finding("WARN", "first"), finding("FAIL", "second", detail)],
    };
    const moved = run(loaded, [KEY.down, KEY.enter]);
    expect(moved.state.panel).toMatchObject({ screen: "doctor", title: "Finding detail" });
    expect(moved.state.panel?.lines[0]).toBe("Severity: FAIL");
    expect(moved.state.panel!.lines.length).toBeGreaterThan(5);
    const scrolled = run(moved.state, [KEY.pageDown]);
    expect(scrolled.state.panel?.scroll).toBeGreaterThan(0);
    const closed = run(scrolled.state, [KEY.esc]);
    expect(closed.state.panel).toBeUndefined();
    expect(closed.state.screen).toBe("doctor");
  });

  it("reruns only on an explicit R", () => {
    const loaded = { ...onScreen("doctor"), findings: [finding("PASS", "a")] };
    expect(run(loaded, [KEY.char("r")]).effects).toEqual([{ kind: "run", screen: "doctor", action: "doctor" }]);
    expect(run(loaded, [KEY.down]).effects).toEqual([]);
  });
});

describe("Plugins & MCPs", () => {
  it("lists rows after load and shows row detail with its status", () => {
    const loaded = reduceConsole(run(onScreen("plugins"), [KEY.enter]).state, {
      type: "result",
      outcome: { action: "plugins", ok: true, lines: [], entries: [entry("engram", "external")] },
    }).state;
    expect(loaded.entries).toHaveLength(1);
    const opened = run(loaded, [KEY.enter]).state;
    expect(opened.panel?.lines).toContain("Ownership: external");
  });
});

describe("result handling", () => {
  it("turns a failed mutation into a visible error panel and error notice", () => {
    const busy = run(onScreen("setup"), [KEY.down, KEY.enter, KEY.char("y")]).state;
    const failed = reduceConsole(busy, {
      type: "result",
      outcome: { action: "setup", ok: false, lines: ["Setup stopped at stage: registration."] },
    }).state;
    expect(failed.running).toBeUndefined();
    expect(failed.panel).toMatchObject({ screen: "setup", title: "Setup result" });
    expect(failed.notice?.tone).toBe("error");
    expect(failed.lastResult?.lines).toEqual(["Setup stopped at stage: registration."]);
  });

  it("shows the last result from the setup screen", () => {
    const withResult: ConsoleState = {
      ...onScreen("setup"),
      lastResult: { title: "Setup result", lines: ["Setup completed."] },
    };
    const shown = run(withResult, [KEY.down, KEY.down, KEY.down, KEY.enter]).state;
    expect(shown.panel?.lines).toEqual(["Setup completed."]);
  });

  it("reports a failed update check without offering apply", () => {
    const checking = run(onScreen("updates"), [KEY.enter]).state;
    const failed = reduceConsole(checking, {
      type: "result",
      outcome: { action: "check-aria", ok: false, lines: ["git ls-remote failed"] },
    }).state;
    expect(failed.panel?.title).toBe("Update check failed");
    expect(failed.panel?.offer).toBeUndefined();
  });
});

describe("helpers", () => {
  it("wraps long text into bounded rows and keeps short text intact", () => {
    expect(wrapPlain("short")).toEqual(["short"]);
    const wrapped = wrapPlain("word ".repeat(60), 40);
    expect(wrapped.every((line) => line.length <= 40)).toBe(true);
    expect(wrapped.join(" ").replace(/\s+/g, " ").trim()).toBe("word ".repeat(60).trim());
  });
});

describe("optional dependency installs (check, then confirm)", () => {
  it("checks first and asks before installing; N performs no request", () => {
    const checking = run(onScreen("setup"), [KEY.down, KEY.down, KEY.enter]);
    expect(checking.effects).toEqual([{ kind: "run", screen: "setup", action: "check-optional" }]);

    const previewed = reduceConsole(checking.state, {
      type: "result",
      outcome: { action: "check-optional", ok: true, lines: ["Optional dependencies not installed: quota."], applicable: true },
    }).state;
    expect(previewed.panel?.offer).toBe("apply-optional");

    const asked = run(previewed, [KEY.char("a")]);
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirm).toMatchObject({ screen: "setup", action: "apply-optional" });

    const declined = run(asked.state, [KEY.char("n")]);
    expect(declined.effects).toEqual([]);
    expect(declined.state.notice?.text).toBe("Cancelled. Nothing was changed.");
  });

  it("runs the optional install only after Y", () => {
    const previewed = reduceConsole(run(onScreen("setup"), [KEY.down, KEY.down, KEY.enter]).state, {
      type: "result",
      outcome: { action: "check-optional", ok: true, lines: ["quota"], applicable: true },
    }).state;
    const confirmed = run(run(previewed, [KEY.char("a")]).state, [KEY.char("y")]);
    expect(confirmed.effects).toEqual([{ kind: "run", screen: "setup", action: "apply-optional" }]);
    expect(confirmed.state.running).toMatchObject({ action: "apply-optional", mutating: true });
  });

  it("offers no install when nothing optional is applicable", () => {
    const previewed = reduceConsole(run(onScreen("setup"), [KEY.down, KEY.down, KEY.enter]).state, {
      type: "result",
      outcome: { action: "check-optional", ok: true, lines: ["All optional dependencies are already present."], applicable: false },
    }).state;
    expect(previewed.panel?.offer).toBeUndefined();
    expect(run(previewed, [KEY.char("a")]).state.confirm).toBeUndefined();
  });
});
