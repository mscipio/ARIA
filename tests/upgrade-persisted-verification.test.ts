import { describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import {
  selfUpgradeAria,
  type HandoffSpawnFn,
} from "../src/aria-upgrade.js";
import {
  buildUpgradeHandoff,
  UPGRADE_COMPONENTS,
  type AriaAvailableTarget,
  type UpgradeCheckResult,
  type UpgradeComponentRow,
  type UpgradeHandoff,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T004 persisted-first regressions (T002 model + T003 migrate-from path).
//
// Deterministic fake executor/clock: persisted opencode.json is mirrored
// synchronously (T001), the runtime `plugin list` view is scripted per
// poll via a queue (transient absent / old-state / never-converging),
// and backoff uses an injectable no-op delay counter (no slow sleeps).
// `readPersistedPlugins` / `delay` / `listConvergence` seams only.
//
// Case mapping (10 user cases; 9 reuses T003's suite, see bottom):
//  1. post-add list transiently absent, persisted correct → success +
//     staleness note, handoff proceeds.
//  2. post-add list transient old-state then convergence → success.
//  3. immediate persisted success even with list unconverged → success.
//  4. genuine failed add (persisted wrong/missing, add exit 0) → fail +
//     truthful rollback, zero handoff.
//  5. conflicting/duplicate registration → fail-closed, zero mutation.
//  6. rollback with transient-stale runtime → persisted reports restored.
//  7. genuine persisted rollback failure → truthful unresolved.
//  8. zero handoff/component work on unresolved identity.
//  9. (existing T003 suite, no new test) old-v1.0.7 → new-CLI migrate.
// 10. unrelated config preserved (multiset check).
// ---------------------------------------------------------------------------

const TARGET_106: AriaAvailableTarget = { tag: "v1.0.6", version: "1.0.6", spec: "github:mscipio/ARIA#v1.0.6" };
const TARGET_107: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

type Row = [string, string, string];

function pluginTable(rows: Row[]): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

const UNRELATED: Row[] = [
  ["other", "1.0.0", "npm:other@1.0.0"],
  ["engram", "local", "/home/user/.config/opencode/plugins/engram.ts"],
];

function ariaRow(spec: string): Row {
  return ["aria", "deadbee", spec];
}

function checkWithTarget(target: AriaAvailableTarget): UpgradeCheckResult {
  const rows: UpgradeComponentRow[] = UPGRADE_COMPONENTS.map((component) => (
    component === "aria"
      ? { component, installed: "1.0.6", available: target.tag, status: "upgrade-available", detail: "upgrade available" }
      : { component, installed: "remote", available: null, status: "remote-healthy", detail: "observed" }
  ));
  return { currentVersion: "1.0.6", cliVersion: "1.0.6", installedSpec: TARGET_106.spec, available: { kind: "known", target }, selfUpgradeBlocked: false, blockReason: null, components: rows };
}

function handoffFor(target: AriaAvailableTarget): UpgradeHandoff {
  return buildUpgradeHandoff(target, checkWithTarget(target));
}

interface StaleWorld {
  persisted: string[];
  live: Row[];
  /** Post-detection list script: each entry serves one `plugin list` call in order; empty → live truth. */
  listQueue: Row[][];
  calls: string[];
  delayCalls: number[];
  handoffs: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }>;
  /** Add specs whose persisted write is silently skipped (models genuine persist failure with exit 0). */
  skipPersistOnAdd: Set<string>;
  listCalls: number;
}

function makeStaleWorld(initial: Row[]): { world: StaleWorld; executor: Executor } {
  const world: StaleWorld = {
    persisted: initial.map((row) => row[2]),
    live: [...initial],
    listQueue: [],
    calls: [],
    delayCalls: [],
    handoffs: [],
    skipPersistOnAdd: new Set(),
    listCalls: 0,
  };
  const executor: Executor = async (command, args) => {
    world.calls.push(`${command} ${args.join(" ")}`);
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
      world.listCalls += 1;
      if (world.listCalls > 1 && world.listQueue.length > 0) {
        const next = world.listQueue.shift() as Row[];
        return { stdout: next.length === 0 ? "No plugins found" : pluginTable(next), stderr: "" };
      }
      return { stdout: world.live.length === 0 ? "No plugins found" : pluginTable(world.live), stderr: "" };
    }
    if (command === "opencode" && args[0] === "plugin" && args[1] === "remove") {
      const spec = args[2] ?? "";
      world.live = world.live.filter((row) => row[2] !== spec);
      world.persisted = world.persisted.filter((entry) => entry !== spec);
      return { stdout: "plugin removed", stderr: "" };
    }
    if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
      const spec = args[2] ?? "";
      world.live.push(["aria", "deadbee", spec]);
      if (!world.skipPersistOnAdd.has(spec)) world.persisted.push(spec);
      return { stdout: "plugin installed", stderr: "" };
    }
    if (command === "npm" && args[0] === "install") {
      // R003 bounded installed-CLI update (`npm install -g <exact-spec>`).
      return { stdout: "installed", stderr: "" };
    }
    throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
  };
  return { world, executor };
}

function staleOptions(world: StaleWorld, executor: Executor, listConvergence?: { attempts: number; delayMs: number }) {
  const handoffSpawn: HandoffSpawnFn = async (handoff, target) => {
    world.handoffs.push({ handoff, target });
    return { ok: true, detail: "stub handoff taken", stdout: `done ${target.tag}` };
  };
  return {
    executor,
    readPersistedPlugins: async () => ({ kind: "ok" as const, path: "fake-persisted-opencode.json", specs: [...world.persisted] }),
    delay: async (ms: number) => { world.delayCalls.push(ms); },
    ...(listConvergence === undefined ? {} : { listConvergence }),
    handoffSpawn,
  };
}

function sortedKeys(rows: Row[]): string[] {
  return rows.map((row) => row.join(" ")).sort();
}

describe("T004 persisted-first verification (deterministic stale-list regressions)", () => {
  it("case 1: post-add list transiently absent while persisted has the target → success with staleness note, handoff proceeds", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    // First post-add poll sees no ARIA row (transiently absent); second converges to live truth.
    world.listQueue.push(
      [...UNRELATED],
      [ariaRow(TARGET_107.spec), ...UNRELATED],
    );
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(true);
    expect(world.handoffs).toHaveLength(1);
    expect(outcome.detail).toContain("converged after 2 polls");
    expect(outcome.detail).toContain("transiently stale");
    expect(outcome.detail).toContain("persisted");
    expect(world.persisted.filter((spec) => spec === TARGET_107.spec)).toHaveLength(1);
    // Bounded retry used the injectable clock (no sleeps on the persisted path).
    expect(world.delayCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("case 2: post-add list shows transient old-state then converges → success", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    world.listQueue.push(
      [ariaRow(TARGET_106.spec), ...UNRELATED],
      [ariaRow(TARGET_107.spec), ...UNRELATED],
    );
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(true);
    expect(world.handoffs).toHaveLength(1);
    expect(outcome.detail).toContain("converged after 2 polls");
    expect(world.live.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });

  it("case 3: immediate persisted success even with the list never converging → success (persisted authoritative)", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    // List stays on the old state for every poll within the bound.
    world.listQueue.push(
      [ariaRow(TARGET_106.spec), ...UNRELATED],
      [ariaRow(TARGET_106.spec), ...UNRELATED],
    );
    const outcome = await selfUpgradeAria(
      TARGET_107,
      handoffFor(TARGET_107),
      staleOptions(world, executor, { attempts: 2, delayMs: 1 }),
    );
    expect(outcome.ok).toBe(true);
    expect(world.handoffs).toHaveLength(1);
    expect(outcome.detail).toContain("did not converge within 2 polls");
    expect(outcome.detail).toContain("persisted authoritative");
  });

  it("case 4: genuine failed add (persisted wrong/missing despite add exit 0) → fail with truthful rollback, zero handoff", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    world.skipPersistOnAdd.add(TARGET_107.spec);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(world.handoffs).toHaveLength(0);
    expect(outcome.detail).toContain("did not verify");
    expect(outcome.registration).toContain(`original registration restored (${TARGET_106.spec})`);
    // On-disk truth matches the report: single original, no target residue.
    expect(world.persisted.filter((spec) => spec === TARGET_106.spec)).toHaveLength(1);
    expect(world.persisted).not.toContain(TARGET_107.spec);
    expect(world.live.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_106.spec]);
  });

  it("case 5: duplicate identical registrations fail closed with zero mutation past the gate", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ariaRow(TARGET_106.spec), ...UNRELATED]);
    const beforeLive = world.live.map((row) => row[2]);
    const beforePersisted = [...world.persisted];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("multiple ARIA registrations");
    // Single read-only probe; no remove/add and no handoff.
    expect(world.calls).toEqual(["opencode plugin list"]);
    expect(world.handoffs).toHaveLength(0);
    expect(world.live.map((row) => row[2])).toEqual(beforeLive);
    expect(world.persisted).toEqual(beforePersisted);
  });

  it("case 6: rollback with transient-stale runtime → persisted model reports restored truthfully", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    world.skipPersistOnAdd.add(TARGET_107.spec);
    // Report list after the failed add, then a stale first rollback poll, then live (restored) truth.
    world.listQueue.push(
      [ariaRow(TARGET_107.spec), ...UNRELATED],
      [ariaRow(TARGET_107.spec), ...UNRELATED],
    );
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(world.handoffs).toHaveLength(0);
    expect(outcome.registration).toContain(`original registration restored (${TARGET_106.spec})`);
    expect(outcome.registration).toContain("persisted");
    // On-disk truth agrees: single original persisted.
    expect(world.persisted.filter((spec) => spec === TARGET_106.spec)).toHaveLength(1);
    expect(world.persisted).not.toContain(TARGET_107.spec);
  });

  it("case 7: genuine persisted rollback failure → truthful unresolved with no contradiction of on-disk state", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    world.skipPersistOnAdd.add(TARGET_107.spec);
    world.skipPersistOnAdd.add(TARGET_106.spec);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(world.handoffs).toHaveLength(0);
    expect(outcome.registration).toContain("unresolved");
    expect(outcome.registration).not.toContain("restored");
    // The note describes the actual on-disk state (no persisted ARIA registration left).
    expect(world.persisted.filter((spec) => spec.startsWith("github:mscipio/ARIA#"))).toHaveLength(0);
    expect(outcome.registration).toContain("no persisted ARIA Git registration");
  });

  it("case 8: zero handoff/component work on unresolved identity", async () => {
    const { world, executor } = makeStaleWorld([...UNRELATED]);
    const beforeLive = world.live.map((row) => row[2]);
    const beforePersisted = [...world.persisted];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not positively identified");
    expect(world.calls).toEqual(["opencode plugin list"]);
    expect(world.handoffs).toHaveLength(0);
    expect(world.live.map((row) => row[2])).toEqual(beforeLive);
    expect(world.persisted).toEqual(beforePersisted);
  });

  it("case 10: unrelated config preserved as a multiset (duplicates and order-insensitive)", async () => {
    const duplicated: Row[] = [
      ariaRow(TARGET_106.spec),
      ["other", "1.0.0", "npm:other@1.0.0"],
      ["other", "1.0.0", "npm:other@1.0.0"],
      ["engram", "local", "/home/user/.config/opencode/plugins/engram.ts"],
    ];
    const { world, executor } = makeStaleWorld(duplicated);
    const unrelatedBefore = sortedKeys(duplicated.filter((row) => row[0] !== "aria"));
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(true);
    expect(world.handoffs).toHaveLength(1);
    expect(outcome.detail).toContain("unrelated plugins preserved");
    const unrelatedAfter = sortedKeys(world.live.filter((row) => row[0] !== "aria"));
    expect(unrelatedAfter).toEqual(unrelatedBefore);
    expect(unrelatedAfter).toHaveLength(3);
    expect(world.live.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });

  // T007: persisted-identity preflight on ALL paths (normal + already-current).
  // Even with one identifiable runtime-list row, persisted ambiguity/mismatch
  // fails closed with zero remove/add, zero handoff/spawn, zero rollback.
  it("T007a: persisted-ambiguous preflight on the normal path → zero mutation calls", async () => {
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_106.spec), ...UNRELATED]);
    const beforeLive = world.live.map((row) => row[2]);
    const beforePersisted = [...world.persisted];
    const base = staleOptions(world, executor);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), {
      ...base,
      readPersistedPlugins: async () => ({
        kind: "ambiguous" as const,
        reason: "Ambiguous global OpenCode config: both opencode.json and opencode.jsonc exist",
        path: "fake-persisted-opencode.json",
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("persisted registration does not positively identify");
    expect(outcome.detail).toContain(TARGET_106.spec);
    // Single read-only list probe; no remove/add, no rollback mutation, no handoff.
    expect(world.calls).toEqual(["opencode plugin list"]);
    expect(world.handoffs).toHaveLength(0);
    expect(world.live.map((row) => row[2])).toEqual(beforeLive);
    expect(world.persisted).toEqual(beforePersisted);
  });

  it("T007b: already-current list with persisted-old → mismatch, never verified-handoff success", async () => {
    // Runtime list already shows the target; persisted still shows the old spec.
    const { world, executor } = makeStaleWorld([ariaRow(TARGET_107.spec), ...UNRELATED]);
    world.persisted = [TARGET_106.spec, ...UNRELATED.map((row) => row[2])];
    const beforeLive = world.live.map((row) => row[2]);
    const beforePersisted = [...world.persisted];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), staleOptions(world, executor));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("persisted registration does not positively identify");
    expect(outcome.detail).toContain(TARGET_107.spec);
    expect(outcome.detail).not.toContain("no replacement performed");
    // Zero mutation and zero handoff/spawn: the already-current shortcut never ran.
    expect(world.calls).toEqual(["opencode plugin list"]);
    expect(world.handoffs).toHaveLength(0);
    expect(world.live.map((row) => row[2])).toEqual(beforeLive);
    expect(world.persisted).toEqual(beforePersisted);
  });
});
