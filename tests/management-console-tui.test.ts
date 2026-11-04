import { PassThrough, Writable } from "node:stream";
import { createElement as h } from "react";
import { render, type Instance } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { ManagementConsoleApp, consoleLines } from "../src/management-console-tui";
import { runManagementConsole, NON_TERMINAL_HELP_NOTE } from "../src/management-console";
import type { ActionId, ActionOutcome, ConsoleServices, MenuStatus } from "../src/management-console-state";
import type { CatalogModel } from "../src/model-manager-state";
import type { ModelManagerSnapshot, PersistOutcome } from "../src/model-manager-store";

// Real Ink rendering and keyboard handling over a fake TTY, with spy services.
// Every service call is recorded so the tests can prove what did and did not run.

const STATUS: MenuStatus = { version: "1.3.4-rc.7", globalConfig: true, projectConfig: false, managedAgents: 10, totalAgents: 10 };
const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-6.1-sol", variants: ["low", "high"], variantsObservable: true },
  { id: "openai/gpt-6-luna", variants: [], variantsObservable: true },
];

const KEYS = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", ctrlC: "\x03", pageDown: "\x1b[6~" };
// Strips the CSI escape sequences Ink emits; the control character is the point.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function snapshot(): ModelManagerSnapshot {
  return {
    worktree: "/work/project",
    defaults: loadDefaultConfig(),
    saved: { global: {}, project: {} },
    paths: {
      global: { target: "/cfg/opencode/aria.json", source: undefined },
      project: { target: "/work/project/aria.json", source: undefined },
    },
  };
}

function defaultOutcome(action: ActionId): ActionOutcome {
  switch (action) {
    case "inspect":
      return { action, ok: true, lines: ["ARIA plugin registration: 1.3.4-rc.7", "Managed agent files: 10 of 10 present"] };
    case "setup":
      return { action, ok: true, lines: ["Registration: already registered", "Setup completed."] };
    case "doctor":
      return {
        action,
        ok: true,
        lines: [],
        findings: [
          { severity: "PASS", area: "package", title: "version readable" },
          { severity: "WARN", area: "routes/models", title: "variant metadata unobservable", detail: "gpt-6-luna reports no variants" },
          { severity: "FAIL", area: "config", title: "project config invalid", detail: "roles.coder.model: expected provider/model" },
          { severity: "SKIP", area: "zotpilot", title: "live tools outside a session" },
        ],
      };
    case "plugins":
      return {
        action,
        ok: true,
        lines: [],
        entries: [
          { kind: "mcp", name: "playwright", component: "playwright", required: true, version: "0.0.83", source: null, runtime: "connected", ownership: "aria-managed", mechanism: "pinned", action: "none (up to date with the ARIA target)", blocker: null },
          { kind: "mcp", name: "engram", component: "engram", required: true, version: "3.4.0", source: null, runtime: "connected", ownership: "external", mechanism: "release", action: "report-only", blocker: "Engram observed" },
          { kind: "plugin", name: "@slkiser/opencode-quota.server", component: "quota", required: false, version: "6.1.0", source: "@slkiser/opencode-quota", runtime: "listed", ownership: "unverified", mechanism: "plugin", action: "report-only", blocker: "Quota 6.1.0 is outside ARIA's supported Quota 5.x major" },
        ],
      };
    case "check-optional":
      return { action, ok: true, lines: ["Optional dependencies not installed: quota."], applicable: true };
    case "apply-optional":
      return { action, ok: true, lines: ["Quota installed"] };
    case "check-aria":
      return { action, ok: true, lines: ["Installed ARIA: 1.2.0", "Available ARIA: 1.3.4-rc.7"], applicable: true };
    case "check-deps":
      return { action, ok: true, lines: ["ARIA dependency upgrade proposal (read-only)"], applicable: false };
    case "apply-aria":
    case "apply-deps":
      return { action, ok: true, lines: ["Upgrade: complete"] };
  }
}

interface Spy {
  services: ConsoleServices;
  calls: string[];
  overrides: Partial<Record<ActionId, () => Promise<ActionOutcome>>>;
  saves: number;
}

function spyServices(overrides: Spy["overrides"] = {}): Spy {
  const spy: Spy = { services: undefined as unknown as ConsoleServices, calls: [], overrides, saves: 0 };
  spy.services = {
    menuStatus: () => STATUS,
    loadModelSnapshot: () => {
      spy.calls.push("loadModels");
      return snapshot();
    },
    discoverModels: async () => {
      spy.calls.push("discoverModels");
      return CATALOG;
    },
    saveModels: async (): Promise<PersistOutcome> => {
      spy.saves += 1;
      spy.calls.push("saveModels");
      return { status: "saved", message: "saved", changed: { global: [], project: [] }, regenerated: false };
    },
    run: async (action: ActionId) => {
      spy.calls.push(action);
      const custom = spy.overrides[action];
      return custom ? custom() : defaultOutcome(action);
    },
  };
  return spy;
}

interface FakeTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  rawModes: boolean[];
  drain(): string;
}

function fakeTerminal(): FakeTerminal {
  const rawModes: boolean[] = [];
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
      return stdin;
    },
    ref: () => stdin,
    unref: () => stdin,
  });
  let frame = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frame += chunk.toString();
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 110, rows: 30 });
  return {
    stdin,
    stdout,
    rawModes,
    drain: () => {
      const text = frame.replace(ANSI, "");
      frame = "";
      return text;
    },
  };
}

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const TITLES = ["ARIA Management Console", "ARIA model manager"];

/** Debug-mode Ink emits every intermediate frame; the user sees only the newest screen. */
function lastFrame(text: string): string {
  let start = -1;
  for (const title of TITLES) start = Math.max(start, text.lastIndexOf(title));
  return start < 0 ? text : text.slice(start);
}

interface Harness {
  term: FakeTerminal;
  app: Instance;
  exits: Array<{ force: boolean }>;
  press(...keys: string[]): Promise<string>;
  frame(): Promise<string>;
}

const harnesses: Harness[] = [];

function mount(spy: Spy, props: { initialStatus?: MenuStatus } = {}): Harness {
  const term = fakeTerminal();
  const exits: Array<{ force: boolean }> = [];
  const app = render(
    h(ManagementConsoleApp, {
      services: spy.services,
      initialStatus: props.initialStatus ?? STATUS,
      onExit: () => {
        exits.push({ force: false });
      },
    }),
    { stdin: term.stdin, stdout: term.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  // The newest screen persists between reads, as on a real terminal.
  let screen = "";
  const refresh = (): string => {
    const fresh = term.drain();
    if (fresh.length > 0) screen = lastFrame(fresh);
    return screen;
  };
  const harness: Harness = {
    term,
    app,
    exits,
    async press(...keys: string[]) {
      for (const key of keys) {
        term.stdin.write(key);
        await tick();
      }
      await tick(60);
      return refresh();
    },
    async frame() {
      await tick();
      return refresh();
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.app.unmount();
  vi.restoreAllMocks();
});

describe("launch and main menu", () => {
  it("renders the menu with version and status and makes no service call on launch", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    const text = await h1.frame();
    expect(text).toContain("ARIA Management Console   v1.3.4-rc.7");
    expect(text).toContain("managed agents: 10/10");
    for (const label of ["Models & Agents", "Setup & Repair", "Doctor", "Plugins & MCPs", "Updates"]) {
      expect(text).toContain(label);
    }
    expect(spy.calls).toEqual([]);
  });

  it("navigates with arrows and opens sections with Enter, then Esc returns to the menu", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    const onSetup = await h1.press(KEYS.down, KEYS.enter);
    expect(onSetup).toContain("ARIA Management Console › Setup & Repair");
    expect(onSetup).toContain("Inspect installation status");
    expect(spy.calls).toEqual([]);
    const back = await h1.press(KEYS.esc);
    expect(back).toMatch(/>\s+Setup & Repair/);
  });

  it("Q quits from the main menu; Ctrl+C exits safely when idle", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press("q");
    expect(h1.exits).toEqual([{ force: false }]);

    const h2 = mount(spy);
    await h2.frame();
    await h2.press(KEYS.ctrlC);
    expect(h2.exits).toEqual([{ force: false }]);
  });
});

describe("Doctor", () => {
  it("does not run on open; Enter runs once, shows all four severities, and details scroll with Esc", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    const opened = await h1.press(KEYS.down, KEYS.down, KEYS.enter);
    expect(opened).toContain("Run diagnostics");
    expect(spy.calls).toEqual([]);

    const ran = await h1.press(KEYS.enter);
    expect(spy.calls).toEqual(["doctor"]);
    expect(ran).toContain("PASS 1   WARN 1   FAIL 1   SKIP 1");
    expect(ran).toContain("[FAIL] config: project config invalid");

    const detail = await h1.press(KEYS.down, KEYS.enter);
    expect(detail).toContain("Finding detail");
    expect(detail).toContain("Severity: WARN");
    expect(detail).toContain("gpt-6-luna reports no variants");

    const closed = await h1.press(KEYS.esc);
    expect(closed).toContain("PASS 1   WARN 1   FAIL 1   SKIP 1");
    expect(spy.calls).toEqual(["doctor"]);
  });

  it("shows a visible error when diagnostics fail", async () => {
    const spy = spyServices({
      doctor: async () => ({ action: "doctor", ok: false, lines: ["doctor probe crashed"] }),
    });
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.down, KEYS.enter);
    const failed = await h1.press(KEYS.enter);
    expect(failed).toContain("Diagnostics failed");
    expect(failed).toContain("doctor probe crashed");
  });
});

describe("Setup & Repair", () => {
  it("asks before running setup, and N cancels with no setup call", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.enter);
    const asked = await h1.press(KEYS.down, KEYS.enter);
    expect(asked).toContain("Confirmation required");
    expect(asked).toContain("register the ARIA plugin");
    expect(spy.calls).toEqual([]);

    const cancelled = await h1.press("n");
    expect(cancelled).toContain("Cancelled. Nothing was changed.");
    expect(spy.calls).toEqual([]);
  });

  it("runs setup only after Y and shows the result", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.enter, KEYS.down, KEYS.enter);
    const done = await h1.press("y");
    expect(spy.calls).toEqual(["setup"]);
    expect(done).toContain("Setup result");
    expect(done).toContain("Setup completed.");
  });
});

describe("Updates", () => {
  it("previews, then applies only after A and Y; N at confirmation performs nothing", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter, KEYS.enter);
    const preview = await h1.frame();
    expect(preview).toContain("ARIA update preview");
    expect(preview).toContain("Available ARIA: 1.3.4-rc.7");
    expect(spy.calls).toEqual(["check-aria"]);

    const asked = await h1.press("a");
    expect(asked).toContain("Confirmation required");
    expect(spy.calls).toEqual(["check-aria"]);

    await h1.press("n");
    expect(spy.calls).toEqual(["check-aria"]);

    await h1.press("a", "y");
    expect(spy.calls).toEqual(["check-aria", "apply-aria"]);
  });

  it("does not offer apply when nothing is applicable", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter, KEYS.down, KEYS.enter);
    const text = await h1.frame();
    expect(text).toContain("Dependency upgrade preview");
    const after = await h1.press("a");
    expect(after).not.toContain("Confirmation required");
    expect(spy.calls).toEqual(["check-deps"]);
  });
});

describe("Models & Agents (embedded Model Manager)", () => {
  it("opens the existing Model Manager and Esc returns to the menu when nothing is pending", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    const models = await h1.press(KEYS.enter);
    expect(models).toContain("ARIA model manager");
    expect(models).toContain("No pending changes.");
    expect(spy.calls).toContain("loadModels");

    const back = await h1.press(KEYS.esc);
    expect(back).toContain("Models & Agents");
    expect(back).toContain("ARIA Management Console   v1.3.4-rc.7");
    expect(spy.saves).toBe(0);
    expect(h1.exits).toEqual([]);
  });

  it("Esc with pending edits discards them first (nothing saved), and the next Esc returns", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.enter, "/", "l", "u", "n", "a");
    await h1.press(KEYS.enter, KEYS.enter);
    const discarded = await h1.press(KEYS.esc);
    expect(discarded).toContain("Discarded 1 pending change. Nothing was written.");
    expect(spy.saves).toBe(0);
    expect(discarded).toContain("ARIA model manager");

    const back = await h1.press(KEYS.esc);
    expect(back).toContain("ARIA Management Console   v1.3.4-rc.7");
    expect(spy.saves).toBe(0);
  });

  it("returns to the menu with the save result after a successful save", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.enter, "/", "l", "u", "n", "a");
    await h1.press(KEYS.enter, KEYS.enter);
    await h1.press("S");
    await tick(200);
    const text = await h1.frame();
    expect(spy.saves).toBe(1);
    expect(text).toContain("Models & Agents: saved");
    expect(text).toContain("ARIA Management Console   v1.3.4-rc.7");
    expect(h1.exits).toEqual([]);
  });

  it("Ctrl+C inside the embedded Model Manager exits the console without writing and does not type into search", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.enter, "/", "l", "u");
    await h1.press(KEYS.ctrlC);
    expect(h1.exits).toEqual([{ force: false }]);
    expect(spy.saves).toBe(0);
  });
});

describe("Ctrl+C never interrupts a configuration change", () => {
  it("refuses to close during a setup run, warns, and closes only after it finishes", async () => {
    let release: (outcome: ActionOutcome) => void = () => undefined;
    const pending = new Promise<ActionOutcome>((resolve) => {
      release = resolve;
    });
    const spy = spyServices({ setup: () => pending });
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.enter, KEYS.down, KEYS.enter, "y");
    const warned = await h1.press(KEYS.ctrlC);
    expect(warned).toContain("cannot be interrupted safely. Ctrl+C is ignored until it finishes.");
    expect(h1.exits).toEqual([]);
    await h1.press(KEYS.ctrlC);
    expect(h1.exits).toEqual([]);
    release(defaultOutcome("setup"));
    await tick(120);
    await h1.press(KEYS.ctrlC);
    expect(h1.exits).toEqual([{ force: false }]);
  });

  it("refuses Ctrl+C while a model save is in progress, and never writes a partial result", async () => {
    let finish: (outcome: PersistOutcome) => void = () => undefined;
    const spy = spyServices();
    spy.services.saveModels = () =>
      new Promise<PersistOutcome>((resolve) => {
        finish = resolve;
      });
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.enter, "/", "l", "u", "n", "a");
    await h1.press(KEYS.enter, KEYS.enter);
    await h1.press("S");
    const during = await h1.press(KEYS.ctrlC);
    expect(during).toContain("Validating and saving");
    expect(h1.exits).toEqual([]);
    finish({ status: "saved", message: "saved", changed: { global: [], project: [] }, regenerated: false });
    await tick(120);
    await h1.press(KEYS.ctrlC);
    expect(h1.exits).toEqual([{ force: false }]);
  });

  it("Esc during a configuration change does not leave the screen", async () => {
    const pending = new Promise<ActionOutcome>(() => undefined);
    const spy = spyServices({ setup: () => pending });
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.enter, KEYS.down, KEYS.enter, "y");
    const text = await h1.press(KEYS.esc);
    expect(text).toContain("An operation is changing configuration; wait for it to finish.");
    expect(text).toContain("Setup & Repair");
  });
});

describe("pure line rendering", () => {
  it("keeps the panel window bounded and reports the visible range", () => {
    const state = {
      screen: "doctor" as const,
      menuCursor: 0,
      status: STATUS,
      cursor: { setup: 0, doctor: 0, plugins: 0, updates: 0 },
      panel: {
        screen: "doctor" as const,
        title: "Finding detail",
        lines: Array.from({ length: 60 }, (_, i) => `line ${i}`),
        scroll: 0,
      },
    };
    const lines = consoleLines(state, 100, 24).map((line) => line.text);
    expect(lines.some((text) => text.startsWith("lines 1-"))).toBe(true);
    expect(lines.filter((text) => text.startsWith("line ")).length).toBeLessThan(20);
  });
});

describe("runManagementConsole", () => {
  it("refuses to launch without a terminal and prints the help note", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: false });
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: false });
    const spy = spyServices();
    const code = await runManagementConsole({ worktree: "/work", binaryUrl: "file:///x/bin/aria.mjs", services: spy.services, stdin, stdout });
    expect(code).toBe(1);
    expect(errors).toHaveBeenCalledWith(NON_TERMINAL_HELP_NOTE);
    expect(spy.calls).toEqual([]);
  });

  it("restores raw mode on exit and returns 0 after Q", async () => {
    const term = fakeTerminal();
    const spy = spyServices();
    const pendingCode = runManagementConsole({
      worktree: "/work",
      binaryUrl: "file:///x/bin/aria.mjs",
      services: spy.services,
      stdin: term.stdin,
      stdout: term.stdout,
    });
    await tick(120);
    term.stdin.write("q");
    const code = await pendingCode;
    expect(code).toBe(0);
    expect(term.rawModes.length).toBeGreaterThan(0);
    expect(term.rawModes[term.rawModes.length - 1]).toBe(false);
    expect(spy.calls).toEqual([]);
  });
});

describe("readMenuStatus (cheap, file-system only)", () => {
  it("counts managed agent files and config presence inside the isolated config root", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readMenuStatus } = await import("../src/management-console");
    const { ROLES } = await import("../src/overrides");

    const root = await mkdtemp(join(tmpdir(), "aria-console-status-"));
    const worktree = join(root, "project");
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    try {
      await mkdir(join(root, "xdg", "opencode", "agents"), { recursive: true });
      await mkdir(worktree, { recursive: true });
      await writeFile(join(root, "xdg", "opencode", "aria.json"), "{}\n");
      await writeFile(join(worktree, "aria.json"), "{}\n");
      // Install genuine managed files (production ownership rule), then keep only three.
      const { regenerateManagedAgents } = await import("../src/model-config");
      await regenerateManagedAgents(worktree, { dir: join(root, "xdg", "opencode", "agents") });
      for (const role of ROLES.slice(3)) {
        await rm(join(root, "xdg", "opencode", "agents", `${role}.md`), { force: true });
      }
      await writeFile(join(root, "xdg", "opencode", "agents", "custom.md"), "user-owned\n");

      const status = readMenuStatus(worktree);
      expect(status.globalConfig).toBe(true);
      expect(status.projectConfig).toBe(true);
      expect(status.managedAgents).toBe(3);
      expect(status.totalAgents).toBe(ROLES.length);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("dependency views (Setup optional, Plugins & MCPs)", () => {
  it("Setup offers optional installs as an explicit, checked action and asks before running it", async () => {
    const spy = spyServices({
      "check-optional": async () => ({ action: "check-optional", ok: true, lines: ["Optional dependencies not installed: quota."], applicable: true }),
    });
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.enter);
    const listed = await h1.frame();
    expect(listed).toContain("Install optional dependencies");
    const checked = await h1.press(KEYS.down, KEYS.down, KEYS.enter);
    expect(checked).toContain("Optional dependencies");
    expect(spy.calls).toEqual(["check-optional"]);
    const asked = await h1.press("a");
    expect(asked).toContain("Confirmation required");
    expect(asked).toContain("Install the optional dependencies listed above");
    await h1.press("n");
    expect(spy.calls).toEqual(["check-optional"]);
  });

  it("Plugins & MCPs lists plugins and MCP servers with kind and ARIA ownership", async () => {
    const spy = spyServices();
    const h1 = mount(spy);
    await h1.frame();
    await h1.press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
    const loaded = await h1.press(KEYS.enter);
    expect(spy.calls).toEqual(["plugins"]);
    expect(loaded).toMatch(/mcp\s+playwright\s+0\.0\.83\s+connected\s+ARIA-managed/);
    expect(loaded).toMatch(/mcp\s+engram\s+3\.4\.0\s+connected\s+external/);
    expect(loaded).toMatch(/plugin\s+@slkiser\/opencode-quota\.server\s+6\.1\.0\s+listed\s+unverified/);
    const detail = await h1.press(KEYS.down, KEYS.down, KEYS.enter);
    expect(detail).toContain("Integration detail");
    expect(detail).toContain("Blocker: Quota 6.1.0 is outside");
  });
});
