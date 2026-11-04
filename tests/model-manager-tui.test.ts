import { PassThrough, Writable } from "node:stream";
import { createElement as h } from "react";
import { render, type Instance } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import type { CatalogModel } from "../src/model-manager-state";
import type { ModelManagerSnapshot, PersistOutcome } from "../src/model-manager-store";
import { ModelManagerApp } from "../src/model-manager-tui";

// Real Ink rendering and keyboard handling over a fake TTY. Every key is a
// raw terminal sequence written to stdin; frames are read back from stdout.

const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-6.1-sol", variants: ["low", "medium", "high", "xhigh"], variantsObservable: true },
  { id: "openai/gpt-6-luna", variants: [], variantsObservable: true },
  { id: "claude-agent/opus", variants: [], variantsObservable: false },
];

const KEYS = {
  down: "\x1b[B",
  up: "\x1b[A",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  backspace: "\x7f",
};

// Strips the CSI escape sequences Ink emits; the control character is the point.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

interface FakeTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  drain(): string;
}

function fakeTerminal(columns = 120): FakeTerminal {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  let frame = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frame += chunk.toString();
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows: 80 });
  return {
    stdin,
    stdout,
    drain: () => {
      const text = frame.replace(ANSI, "");
      frame = "";
      return text;
    },
  };
}

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SCREEN_TITLES = ["ARIA model manager", "Model for ", "Variant for "];

/**
 * Debug-mode Ink writes every intermediate frame, so one key press can emit
 * several frames. Only the most recent screen is what the user sees.
 */
function lastFrame(text: string): string {
  let start = -1;
  for (const title of SCREEN_TITLES) start = Math.max(start, text.lastIndexOf(title));
  return start < 0 ? text : text.slice(start);
}

function snapshot(saved: ModelManagerSnapshot["saved"] = { global: {}, project: {} }): ModelManagerSnapshot {
  return {
    worktree: "/work/project",
    defaults: loadDefaultConfig(),
    saved,
    paths: {
      global: { target: "/cfg/opencode/aria.json", source: undefined },
      project: { target: "/work/project/aria.json", source: undefined },
    },
  };
}

interface Harness {
  term: FakeTerminal;
  app: Instance;
  finished: { outcome: PersistOutcome | undefined; called: boolean };
  save: ReturnType<typeof vi.fn>;
  /** Send raw keys, then return the last rendered frame without ANSI. */
  press(...keys: string[]): Promise<string>;
  /** Latest frame after waiting for the renderer to settle. */
  frame(): Promise<string>;
}

const harnesses: Harness[] = [];

function mount(options: {
  snap?: ModelManagerSnapshot;
  discover?: () => Promise<CatalogModel[]>;
  save?: (pending: unknown) => Promise<PersistOutcome>;
  initialScope?: "global" | "project";
} = {}): Harness {
  const term = fakeTerminal();
  const finished = { outcome: undefined as PersistOutcome | undefined, called: false };
  const defaultSave = async (): Promise<PersistOutcome> => ({
    status: "saved",
    message: "saved",
    changed: { global: [], project: [] },
    regenerated: false,
  });
  const save = vi.fn(options.save ?? defaultSave);
  const app = render(
    h(ModelManagerApp, {
      snapshot: options.snap ?? snapshot(),
      discover: options.discover ?? (async () => CATALOG),
      save,
      onFinish: (outcome: PersistOutcome | undefined) => {
        finished.called = true;
        finished.outcome = outcome;
      },
      initialScope: options.initialScope,
    }),
    { stdin: term.stdin, stdout: term.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const harness: Harness = {
    term,
    app,
    finished,
    save,
    async press(...keys: string[]) {
      for (const key of keys) {
        term.stdin.write(key);
        await tick();
      }
      await tick();
      return lastFrame(term.drain());
    },
    async frame() {
      await tick();
      return lastFrame(term.drain());
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.app.unmount();
});

/** Type a string one character at a time, as a user would. */
function typed(text: string): string[] {
  return [...text];
}

describe("terminal rendering", () => {
  it("shows every ARIA agent with its model, variant, source, scope, and key hints", async () => {
    const h = mount({ snap: snapshot({ global: {}, project: { planner: { model: "openai/gpt-6-luna" } } }) });
    const text = await h.frame();
    expect(text).toContain("ARIA model manager");
    expect(text).toContain("editing scope: GLOBAL");
    expect(text).toContain("3 models enabled and available");
    for (const role of ["coder", "explorer", "visualizer", "planner", "implementer", "reviewer", "researcher", "archivist", "writer", "scientist"]) {
      expect(text).toContain(role);
    }
    expect(text).toMatch(/planner\s+openai\/gpt-6-luna\s+-\s+project/);
    expect(text).toMatch(/coder\s+opencode-go\/muse-spark-1\.3-contributor\s+xhigh\s+default/);
    expect(text).toContain("No pending changes.");
    expect(text).toContain("S save");
  });

  it("moves the selection with the arrow keys", async () => {
    const h = mount();
    await h.frame();
    const after = await h.press(KEYS.down, KEYS.down);
    expect(after).toMatch(/>\s+visualizer/);
    const back = await h.press(KEYS.up, KEYS.up, KEYS.up, KEYS.up);
    expect(back).toMatch(/>\s+coder/);
  });

  it("reports a catalog failure and refuses to edit", async () => {
    const h = mount({ discover: async () => Promise.reject(new Error("opencode not found")) });
    const text = await h.frame();
    expect(text).toContain("Model catalog unavailable: opencode not found");
    const afterEnter = await h.press(KEYS.enter);
    expect(afterEnter).toContain("Model catalog unavailable");
    expect(afterEnter).toContain("editing is disabled");
    expect(afterEnter).not.toContain("Model for coder");
  });
});

describe("keyboard editing", () => {
  it("searches models with /, chooses a variant, and marks the row as pending", async () => {
    const h = mount();
    await h.frame();
    const picker = await h.press(KEYS.enter);
    expect(picker).toContain("Model for coder · GLOBAL scope");
    expect(picker).toContain("Press / to search models.");

    const searching = await h.press("/", ...typed("gpt-6.1"));
    expect(searching).toContain("Search: gpt-6.1_");
    expect(searching).toContain("openai/gpt-6.1-sol");
    expect(searching).not.toContain("openai/gpt-6-luna");

    const variant = await h.press(KEYS.enter);
    expect(variant).toContain("Variant for openai/gpt-6.1-sol");
    expect(variant).toContain("default (no explicit variant)");
    expect(variant).toContain("xhigh");

    const chosen = await h.press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
    expect(chosen).toContain("Pending changes (1, not saved yet):");
    expect(chosen).toContain("coder [global]: (inherit) -> openai/gpt-6.1-sol (high)");
    expect(chosen).toMatch(/\*\s+coder/);
  });

  it("accepts a pasted or fast-typed burst in the search box as one chunk", async () => {
    const h = mount();
    await h.frame();
    // One raw chunk, as a terminal delivers a paste: the whole query must land.
    const text = await h.press(KEYS.enter, "/gpt-6.1-sol");
    expect(text).toContain("Search: gpt-6.1-sol_");
    expect(text).toContain("1 of 3 models shown");
  });

  it("keeps typed letters inside the search box instead of triggering commands", async () => {
    const h = mount();
    await h.frame();
    const typedText = await h.press(KEYS.enter, "/", ...typed("sr"));
    expect(typedText).toContain("Search: sr_");
    // `S` and `R` are commands on the main table only; no save or removal happened.
    expect(h.save).not.toHaveBeenCalled();
    expect(typedText).not.toContain("Pending changes (");
  });

  it("Esc clears a search, then backs out of the picker to the table", async () => {
    const h = mount();
    await h.frame();
    await h.press(KEYS.enter, "/", ...typed("luna"));
    const cleared = await h.press(KEYS.esc);
    expect(cleared).toContain("Press / to search models.");
    const back = await h.press(KEYS.esc);
    expect(back).toContain("ARIA model manager");
    expect(back).toContain("editing scope: GLOBAL");
  });

  it("does not offer variants for a model that reports no variant metadata", async () => {
    const h = mount();
    await h.frame();
    const variant = await h.press(KEYS.enter, "/", ...typed("opus"), KEYS.enter);
    expect(variant).toContain("Variant for claude-agent/opus");
    expect(variant).toContain("Variant metadata is unavailable");
    expect(variant).not.toContain("xhigh");
  });
});

describe("several agents, save, and cancel", () => {
  it("accumulates several pending changes and saves them together with one action", async () => {
    const h = mount();
    await h.frame();
    // coder -> openai/gpt-6-luna (no variants)
    await h.press(KEYS.enter, "/", ...typed("luna"), KEYS.enter, KEYS.enter);
    // explorer -> openai/gpt-6.1-sol with xhigh
    await h.press(KEYS.down, KEYS.enter, "/", ...typed("sol"), KEYS.enter);
    const beforeVariant = await h.press(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
    expect(beforeVariant).toContain("Pending changes (2, not saved yet):");

    await h.press("S");
    expect(h.save).toHaveBeenCalledTimes(1);
    const pending = h.save.mock.calls[0]?.[0] as { global: Record<string, unknown> };
    expect(Object.keys(pending.global).sort()).toEqual(["coder", "explorer"]);
    expect(pending.global.explorer).toEqual({ model: "openai/gpt-6.1-sol", variant: "xhigh" });
    expect(h.finished.called).toBe(true);
    expect(h.finished.outcome?.status).toBe("saved");
  });

  it("Esc on the table with no changes exits without calling save", async () => {
    const h = mount();
    await h.frame();
    await h.press(KEYS.esc);
    expect(h.finished.called).toBe(true);
    expect(h.finished.outcome).toBeUndefined();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("Esc discards pending changes first and stays open; a second Esc exits without saving", async () => {
    const h = mount();
    await h.frame();
    await h.press(KEYS.enter, "/", ...typed("luna"), KEYS.enter, KEYS.enter);
    const discarded = await h.press(KEYS.esc);
    expect(discarded).toContain("Discarded 1 pending change. Nothing was written.");
    expect(discarded).toContain("No pending changes.");
    expect(h.finished.called).toBe(false);
    await h.press(KEYS.esc);
    expect(h.finished.called).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("S with no pending changes does not save", async () => {
    const h = mount();
    await h.frame();
    const text = await h.press("S");
    expect(text).toContain("No pending changes to save.");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("keeps the pending changes visible and open when saving fails", async () => {
    const h = mount({
      save: async () => ({ status: "failed", error: "model catalog unavailable (boom); nothing was written." }),
    });
    await h.frame();
    await h.press(KEYS.enter, "/", ...typed("luna"), KEYS.enter, KEYS.enter);
    const failed = await h.press("S");
    expect(failed).toContain("model catalog unavailable (boom); nothing was written.");
    expect(failed).toContain("Pending changes (1, not saved yet):");
    expect(h.finished.called).toBe(false);
  });
});

describe("scopes and removal", () => {
  it("Tab switches to project scope, where R removes the project override and inherits global", async () => {
    const h = mount({
      snap: snapshot({
        global: { coder: { model: "openai/gpt-6-luna" } },
        project: { coder: { model: "openai/gpt-6.1-sol", variant: "low" } },
      }),
    });
    const before = await h.frame();
    expect(before).toMatch(/coder\s+openai\/gpt-6\.1-sol\s+low\s+project/);

    const project = await h.press(KEYS.tab);
    expect(project).toContain("editing scope: PROJECT");
    const removed = await h.press("R");
    expect(removed).toContain("coder [project]: openai/gpt-6.1-sol (low) -> remove override");
    expect(removed).toMatch(/coder\s+openai\/gpt-6-luna\s+-\s+global/);

    await h.press("S");
    const pending = h.save.mock.calls[0]?.[0] as { project: Record<string, unknown> };
    expect(pending.project).toEqual({ coder: null });
  });

  it("R on a role without an override reports that nothing needs removing", async () => {
    const h = mount();
    await h.frame();
    const text = await h.press("R");
    expect(text).toContain("nothing to remove");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("starts in the requested scope", async () => {
    const h = mount({ initialScope: "project" });
    expect(await h.frame()).toContain("editing scope: PROJECT");
  });
});

describe("cancel via Esc is independent of the keyboard path", () => {
  it("does not write while the picker is open and Esc returns to the table unchanged", async () => {
    const h = mount();
    await h.frame();
    await h.press(KEYS.enter, KEYS.esc);
    await h.press(KEYS.esc);
    expect(h.finished.called).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });
});
