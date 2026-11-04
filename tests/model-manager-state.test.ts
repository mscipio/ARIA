import { describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { ROLES, resolveRoleRoute } from "../src/overrides";
import {
  applyPending,
  describeRoute,
  emptyPending,
  filterModels,
  initialManagerState,
  normalizePending,
  pendingCount,
  reduceKey,
  resolveEffective,
  routeStatus,
  sameEntry,
  validatePending,
  variantChoices,
  type CatalogModel,
  type CatalogState,
  type KeyEvent,
  type ManagerState,
  type PendingChanges,
  type ReducerContext,
  type ScopedEntries,
} from "../src/model-manager-state";

const defaults = loadDefaultConfig();

const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-6.1-sol", variants: ["low", "medium", "high", "xhigh"], variantsObservable: true },
  { id: "openai/gpt-6-luna", variants: [], variantsObservable: true },
  { id: "claude-agent/opus", variants: [], variantsObservable: false },
  { id: "opencode-go/muse-spark-1.3-contributor", variants: ["high", "xhigh"], variantsObservable: true },
];

const EMPTY: ScopedEntries = { global: {}, project: {} };

function ctxWith(saved: ScopedEntries = EMPTY, catalog: CatalogState = { status: "ready", models: CATALOG }): ReducerContext {
  return { defaults, saved, catalog };
}

const KEY = {
  down: { input: "", downArrow: true } satisfies KeyEvent,
  up: { input: "", upArrow: true } satisfies KeyEvent,
  enter: { input: "", returnKey: true } satisfies KeyEvent,
  esc: { input: "", escape: true } satisfies KeyEvent,
  tab: { input: "", tab: true } satisfies KeyEvent,
  backspace: { input: "", backspace: true } satisfies KeyEvent,
  char: (input: string): KeyEvent => ({ input }),
};

/** Feed a sequence of keys through the reducer, returning the final state and any effects. */
function run(start: ManagerState, keys: KeyEvent[], ctx: ReducerContext = ctxWith()) {
  let state = start;
  const effects: string[] = [];
  for (const key of keys) {
    const result = reduceKey(state, key, ctx);
    state = result.state;
    if (result.effect) effects.push(result.effect.kind);
  }
  return { state, effects };
}

describe("effective resolution", () => {
  it("matches the runtime resolver for every role across layers", () => {
    const layers: ScopedEntries = {
      global: { coder: { model: "openai/gpt-6-luna" }, reviewer: { model: "openai/gpt-6.1-sol", variant: "low" } },
      project: { reviewer: { variant: "high" }, planner: { model: "claude-agent/opus" } },
    };
    const effective = resolveEffective(defaults, layers);
    for (const route of effective) {
      const runtime = resolveRoleRoute(defaults.roles[route.role], layers.global[route.role], layers.project[route.role]);
      expect(route.model).toBe(runtime.model);
      expect(route.variant).toBe(runtime.variant);
    }
    expect(effective.map((route) => route.role)).toEqual([...ROLES]);
  });

  it("labels the source as the highest layer that sets any field", () => {
    const layers: ScopedEntries = {
      global: { coder: { model: "openai/gpt-6-luna" } },
      project: { planner: { variant: "low" } },
    };
    const byRole = Object.fromEntries(resolveEffective(defaults, layers).map((route) => [route.role, route]));
    expect(byRole.coder?.source).toBe("global");
    expect(byRole.planner?.source).toBe("project");
    expect(byRole.explorer?.source).toBe("default");
  });

  it("a project model-only override clears the inherited variant (pair semantics)", () => {
    const layers: ScopedEntries = {
      global: { coder: { model: "openai/gpt-6.1-sol", variant: "high" } },
      project: { coder: { model: "openai/gpt-6-luna" } },
    };
    const coder = resolveEffective(defaults, layers).find((route) => route.role === "coder");
    expect(coder).toMatchObject({ model: "openai/gpt-6-luna", variant: undefined, source: "project" });
  });
});

describe("pending edits", () => {
  it("drops edits equal to the saved layer and removes no-op removals", () => {
    const saved: ScopedEntries = { global: { coder: { model: "openai/gpt-6-luna" } }, project: {} };
    const pending: PendingChanges = {
      global: { coder: { model: "openai/gpt-6-luna" }, explorer: null },
      project: {},
    };
    expect(normalizePending(saved, pending)).toEqual(emptyPending());
  });

  it("applies edits and removals over the saved layers", () => {
    const saved: ScopedEntries = { global: { coder: { model: "openai/gpt-6-luna" } }, project: { coder: { model: "openai/gpt-6.1-sol" } } };
    const pending: PendingChanges = { global: {}, project: { coder: null } };
    const applied = applyPending(saved, normalizePending(saved, pending));
    expect(applied.project.coder).toBeUndefined();
    expect(applied.global.coder).toEqual({ model: "openai/gpt-6-luna" });
  });

  it("sameEntry treats unset entries as equal and compares the full pair", () => {
    expect(sameEntry(undefined, {})).toBe(true);
    expect(sameEntry({ model: "a/b", variant: "x" }, { model: "a/b" })).toBe(false);
    expect(sameEntry({ model: "a/b", variant: "x" }, { model: "a/b", variant: "x" })).toBe(true);
  });
});

describe("catalog helpers", () => {
  it("filters by case-insensitive substring and keeps catalog order", () => {
    expect(filterModels(CATALOG, "GPT").map((model) => model.id)).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6-luna"]);
    expect(filterModels(CATALOG, "  ")).toHaveLength(CATALOG.length);
    expect(filterModels(CATALOG, "nothing-here")).toEqual([]);
  });

  it("offers the default choice and only catalog-reported variants", () => {
    const choices = variantChoices(CATALOG[0]!, undefined);
    expect(choices.options.map((option) => option.label)).toEqual(["default (no explicit variant)", "low", "medium", "high", "xhigh"]);
    expect(choices.notice).toBeUndefined();
  });

  it("reports an empty-variant model without guessing variants", () => {
    const choices = variantChoices(CATALOG[1]!, undefined);
    expect(choices.options).toHaveLength(1);
    expect(choices.notice).toContain("no reasoning variants");
  });

  it("with unobservable metadata offers only the no-variant choice plus an explicitly unverified current variant", () => {
    const unverifiable = CATALOG[2]!;
    expect(variantChoices(unverifiable, undefined).options.map((option) => option.variant)).toEqual([undefined]);
    const keep = variantChoices(unverifiable, "high").options;
    expect(keep.map((option) => option.label)).toEqual(["default (no explicit variant)", "keep current: high (unverified)"]);
    expect(variantChoices(unverifiable, undefined).notice).toContain("cannot be verified");
  });

  it("routeStatus flags unlisted models, unverifiable and unsupported variants, and unavailable catalogs", () => {
    expect(routeStatus({ model: "openai/gpt-6-luna", variant: undefined }, CATALOG)).toBe("");
    expect(routeStatus({ model: "missing/model", variant: undefined }, CATALOG)).toBe("not in OpenCode catalog");
    expect(routeStatus({ model: "claude-agent/opus", variant: "high" }, CATALOG)).toBe("variant unverified");
    expect(routeStatus({ model: "openai/gpt-6.1-sol", variant: "bogus" }, CATALOG)).toBe("variant unsupported");
    expect(routeStatus({ model: "openai/gpt-6.1-sol", variant: "low" }, undefined)).toBe("catalog unavailable");
  });
});

describe("save-time validation", () => {
  it("accepts supported model and variant pairs", () => {
    const pending: PendingChanges = {
      global: { coder: { model: "openai/gpt-6.1-sol", variant: "high" } },
      project: { planner: { model: "openai/gpt-6-luna" } },
    };
    expect(validatePending(pending, CATALOG)).toEqual([]);
  });

  it("blocks a model that the fresh catalog no longer lists", () => {
    const pending: PendingChanges = { global: { coder: { model: "openai/gone" } }, project: {} };
    expect(validatePending(pending, CATALOG)).toEqual(["global coder: model openai/gone is no longer listed by OpenCode"]);
  });

  it("blocks unsupported and unverifiable variants", () => {
    const pending: PendingChanges = {
      global: {
        coder: { model: "openai/gpt-6.1-sol", variant: "turbo" },
        explorer: { model: "claude-agent/opus", variant: "high" },
      },
      project: {},
    };
    const errors = validatePending(pending, CATALOG);
    expect(errors).toEqual([
      "global coder: variant turbo is not supported by openai/gpt-6.1-sol",
      "global explorer: variant high cannot be verified for claude-agent/opus",
    ]);
  });
});

describe("reducer: navigation and selection", () => {
  it("moves the role cursor with arrows and clamps at the ends", () => {
    const start = initialManagerState("global");
    const { state } = run(start, [KEY.down, KEY.down, KEY.up]);
    expect(state.roleIndex).toBe(1);
    const top = run(start, [KEY.up, KEY.up]).state;
    expect(top.roleIndex).toBe(0);
    const bottom = run(start, Array.from({ length: ROLES.length + 3 }, () => KEY.down)).state;
    expect(bottom.roleIndex).toBe(ROLES.length - 1);
  });

  it("switches scope with Tab", () => {
    const { state } = run(initialManagerState("global"), [KEY.tab]);
    expect(state.scope).toBe("project");
    expect(run(state, [KEY.tab]).state.scope).toBe("global");
  });

  it("opens the picker with the current model highlighted", () => {
    const { state } = run(initialManagerState("global"), [KEY.down, KEY.enter]);
    expect(state.screen).toMatchObject({ kind: "model", role: "explorer", searching: false, query: "" });
    const screen = state.screen as { cursor: number };
    expect(CATALOG[screen.cursor]?.id).toBe(resolveEffective(defaults, EMPTY).find((route) => route.role === "explorer")?.model);
  });

  it("refuses to edit when the catalog is unavailable or still loading", () => {
    const failed = run(initialManagerState(), [KEY.enter], ctxWith(EMPTY, { status: "failed", error: "boom" }));
    expect(failed.state.screen.kind).toBe("main");
    expect(failed.state.notice?.text).toContain("Model catalog unavailable");
    const loading = run(initialManagerState(), [KEY.enter], ctxWith(EMPTY, { status: "loading" }));
    expect(loading.state.notice?.text).toContain("still loading");
  });
});

describe("reducer: search, selection, and variants", () => {
  it("activates search with / and filters while typing; slash is part of model IDs", () => {
    const keys = [KEY.char("/"), KEY.char("l"), KEY.char("u"), KEY.char("n"), KEY.char("a")];
    const { state } = run(initialManagerState(), [KEY.enter, ...keys]);
    expect(state.screen).toMatchObject({ kind: "model", query: "luna", searching: true });
    const slashed = run(initialManagerState(), [KEY.char("/"), KEY.char("/"), KEY.char("g")]).state;
    expect(slashed.screen).toMatchObject({ query: "/g" });
  });

  it("accepts a multi-character burst (paste or fast typing) as search text", () => {
    const pasted = run(initialManagerState(), [KEY.enter, KEY.char("/"), { input: "gpt-6.1-sol" }]).state;
    expect(pasted.screen).toMatchObject({ kind: "model", query: "gpt-6.1-sol", searching: true });
    expect(filterModels(CATALOG, "gpt-6.1-sol").map((model) => model.id)).toEqual(["openai/gpt-6.1-sol"]);
  });

  it("keeps the text after a leading slash that arrives in the same burst", () => {
    const burst = run(initialManagerState(), [{ input: "/luna" }]).state;
    expect(burst.screen).toMatchObject({ kind: "model", query: "luna", searching: true });
  });

  it("never treats a control sequence as search text", () => {
    const { state } = run(initialManagerState(), [KEY.enter, KEY.char("/"), { input: "a\x1b[Ab" }]);
    expect(state.screen).toMatchObject({ query: "" });
    const tab = run(initialManagerState(), [KEY.enter, KEY.char("/"), { input: "x\t" }]).state;
    expect(tab.screen).toMatchObject({ query: "" });
  });

  it("ignores typed letters outside search mode (no accidental save or removal)", () => {
    const { state, effects } = run(initialManagerState(), [KEY.enter, KEY.char("s"), KEY.char("r")]);
    expect(effects).toEqual([]);
    expect(state.screen).toMatchObject({ kind: "model", query: "", searching: false });
  });

  it("Esc clears an active search first, then goes back to the main table", () => {
    let state = run(initialManagerState(), [KEY.enter, KEY.char("/"), KEY.char("x")]).state;
    state = run(state, [KEY.esc]).state;
    expect(state.screen).toMatchObject({ kind: "model", query: "", searching: false });
    state = run(state, [KEY.esc]).state;
    expect(state.screen.kind).toBe("main");
  });

  it("selects a model then applies a variant as a pending change for the active scope", () => {
    const { state } = run(initialManagerState("global"), [
      KEY.enter,
      KEY.char("/"),
      ...["g", "p", "t", "-", "6", ".", "1"].map(KEY.char),
      KEY.enter, // chooses openai/gpt-6.1-sol
      KEY.down, // default -> low
      KEY.down, // low -> medium
      KEY.down, // medium -> high
      KEY.enter,
    ]);
    expect(state.screen.kind).toBe("main");
    expect(state.pending.global.coder).toEqual({ model: "openai/gpt-6.1-sol", variant: "high" });
    expect(state.notice?.text).toContain("coder: global -> openai/gpt-6.1-sol (high)");
  });

  it("choosing the default variant stores a model-only pair (variant cleared)", () => {
    const { state } = run(initialManagerState("project"), [KEY.enter, KEY.char("/"), ...["l", "u", "n", "a"].map(KEY.char), KEY.enter, KEY.enter]);
    expect(state.pending.project.coder).toEqual({ model: "openai/gpt-6-luna" });
  });

  it("does not store a pending change when the chosen pair equals the saved one", () => {
    const saved: ScopedEntries = { global: { explorer: { model: "openai/gpt-6.1-sol", variant: "high" } }, project: {} };
    const ctx = ctxWith(saved);
    const { state } = run(initialManagerState("global"), [KEY.down, KEY.enter], ctx);
    // Cursor lands on the current model (gpt-6.1-sol, high) in the picker.
    const cursorAtCurrent = (state.screen as { cursor: number }).cursor;
    expect(CATALOG[cursorAtCurrent]?.id).toBe("openai/gpt-6.1-sol");
    // Enter on the current model, then Enter on its already-saved variant (cursor starts there).
    const after = run(state, [KEY.enter, KEY.enter], ctx).state;
    expect(after.screen.kind).toBe("main");
    expect(pendingCount(after.pending)).toBe(0);
    // The notice must not promise a save that will not happen.
    expect(after.notice?.text).toContain("already saved in global scope; no change.");
    expect(after.notice?.text).not.toContain("press S to save");
  });

  it("records several agents before save and then emits a single save effect", () => {
    const keys: KeyEvent[] = [
      KEY.enter, KEY.char("/"), ...["l", "u", "n", "a"].map(KEY.char), KEY.enter, KEY.enter, // coder -> luna
      KEY.down, KEY.enter, KEY.char("/"), ...["s", "o", "l"].map(KEY.char), KEY.enter, KEY.enter, // explorer -> sol (default)
    ];
    const { state: main } = run(initialManagerState("global"), keys);
    expect(main.screen.kind).toBe("main");
    expect(pendingCount(main.pending)).toBe(2);
    const saved = run(main, [KEY.char("S")]);
    expect(saved.effects).toEqual(["save"]);
    expect(saved.state.saving).toBe(true);
    // While saving, keys are ignored.
    expect(run(saved.state, [KEY.char("R"), KEY.esc]).effects).toEqual([]);
  });

  it("S without pending changes does not save", () => {
    const { effects, state } = run(initialManagerState(), [KEY.char("s")]);
    expect(effects).toEqual([]);
    expect(state.notice?.text).toBe("No pending changes to save.");
  });
});

describe("reducer: cancel, discard, and removal", () => {
  it("Esc on the main table with no pending changes exits without saving", () => {
    const { effects } = run(initialManagerState(), [KEY.esc]);
    expect(effects).toEqual(["exit"]);
  });

  it("Esc with pending changes discards them and stays open, so a second Esc exits", () => {
    const edited = run(initialManagerState("global"), [KEY.enter, KEY.char("/"), ...["l", "u", "n", "a"].map(KEY.char), KEY.enter, KEY.enter]).state;
    expect(pendingCount(edited.pending)).toBe(1);
    const discarded = run(edited, [KEY.esc]);
    expect(discarded.effects).toEqual([]);
    expect(pendingCount(discarded.state.pending)).toBe(0);
    expect(discarded.state.notice?.text).toContain("Discarded 1 pending change");
    expect(run(discarded.state, [KEY.esc]).effects).toEqual(["exit"]);
  });

  it("R in project scope removes the project override so the global assignment is inherited", () => {
    const saved: ScopedEntries = {
      global: { coder: { model: "openai/gpt-6-luna" } },
      project: { coder: { model: "openai/gpt-6.1-sol", variant: "low" } },
    };
    const ctx = ctxWith(saved);
    const { state } = run(initialManagerState("project"), [KEY.char("R")], ctx);
    expect(state.pending.project.coder).toBeNull();
    const preview = resolveEffective(defaults, applyPending(saved, normalizePending(saved, state.pending)))
      .find((route) => route.role === "coder");
    expect(preview).toMatchObject({ model: "openai/gpt-6-luna", source: "global" });
  });

  it("R reports when there is no override to remove", () => {
    const { state, effects } = run(initialManagerState("project"), [KEY.char("r")], ctxWith());
    expect(effects).toEqual([]);
    expect(state.notice?.text).toContain("nothing to remove");
    expect(pendingCount(state.pending)).toBe(0);
  });

  it("R in global scope resets the global assignment to the ARIA default", () => {
    const saved: ScopedEntries = { global: { coder: { model: "openai/gpt-6-luna" } }, project: {} };
    const { state } = run(initialManagerState("global"), [KEY.char("R")], ctxWith(saved));
    const preview = resolveEffective(defaults, applyPending(saved, normalizePending(saved, state.pending)))
      .find((route) => route.role === "coder");
    expect(preview?.source).toBe("default");
  });
});

describe("helpers", () => {
  it("describeRoute formats provider/model with an optional variant", () => {
    expect(describeRoute("openai/gpt-6-luna", undefined)).toBe("openai/gpt-6-luna");
    expect(describeRoute("openai/gpt-6-luna", "high")).toBe("openai/gpt-6-luna (high)");
  });
});
