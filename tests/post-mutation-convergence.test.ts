import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { installQuotaIfMissing } from "../src/bootstrap.js";
import type { Executor } from "../src/deps.js";
import { DEFAULT_LIST_CONVERGENCE } from "../src/list-convergence.js";
import { openCodeGlobalDir } from "../src/paths.js";
import { QUOTA_PLUGIN_ID } from "../src/quota.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T004 deterministic post-mutation convergence regressions.
//
// Caller-level proofs for the T003 persisted-first wiring of
// `installQuotaIfMissing` (mutation → persisted global-config verification
// → bounded runtime `opencode plugin list` convergence). Every test uses a
// per-test temp XDG root plus an injected fake clock: zero real sleeps,
// exact poll/delay assertions.
//
// Case mapping (T004 bullets):
//  1. stale→stale→visible succeeds within the bound (single mutation,
//     observation-only retries, unrelated entries preserved).
//  2. immediate visibility succeeds with zero extra polls/delays.
//  3. never-visible fails closed after the exact bound + rolls back
//     byte-identical.
//  4. malformed/unrecognized post-mutation output fails closed (null is
//     never treated as not-present).
//  5. unrecognized pre-install output fails closed as report-only with zero
//     mutation (null is never treated as absent at the gate either).
//  6. missing persisted registration fails immediately with zero
//     post-mutation polls — runtime visibility cannot rescue it.
//  7. duplicate registration is rejected and rolled back.
//  8. unrelated config (mixed plugin shapes + MCP servers) survives
//     byte-for-byte on the success path.
//  9. shared default bound guard: T003/T004 never lengthen sleeps — the
//     default path still converges within exactly 3 polls / 2×100ms.
// Already-safe ARIA/Engram convergence is protected by its existing suites
// (aria-upgrade, engram-lifecycle, upgrade-persisted-verification), re-run
// as regression evidence; this file adds no duplicates for those paths.
// ---------------------------------------------------------------------------

const QUOTA_SPEC = "@slkiser/opencode-quota@5.1.0";
const QUOTA_VERSION = "5.1.0";
const UNRELATED_PLUGIN = "unrelated-plugin@1.0.0";
const PLUGIN_HEADER = "ID  VERSION  SOURCE";
const STALE_LIST = "No plugins found";
const MALFORMED_LIST = "garbage output";

function quotaRow(version = QUOTA_VERSION, source: string = QUOTA_SPEC): string {
  return `${QUOTA_PLUGIN_ID}  ${version}  ${source}`;
}

function pluginTable(rows: string[]): string {
  return [PLUGIN_HEADER, ...rows].join("\n");
}

const VISIBLE_LIST = pluginTable([quotaRow()]);
const DUPLICATE_LIST = pluginTable([quotaRow(), quotaRow()]);

const tempDirs: string[] = [];
let savedXdg: string | undefined;

beforeEach(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t004-xdg-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp XDG root");
  process.env.XDG_CONFIG_HOME = root;
});

afterEach(async () => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seedGlobalConfig(value: unknown): Promise<string> {
  const dir = await ensureGlobalDir();
  const path = resolve(dir, "opencode.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

async function ensureGlobalDir(): Promise<string> {
  const dir = openCodeGlobalDir();
  assertNotCallerGlobalPath(dir, "temp XDG global dir");
  await mkdir(dir, { recursive: true });
  return dir;
}

interface InstallHarness {
  calls: string[];
  delays: number[];
  executor: Executor;
  /** Total `opencode plugin list` calls (1 pre-check + post-mutation polls). */
  pluginLists(): number;
  /** Total `opencode plugin add` mutations (must stay exactly 1 past the gate). */
  pluginAdds(): number;
}

/**
 * Scripted Quota installer world. Before the add, `plugin list` serves
 * `preList`; after the add it serves `postLists` in order (last repeats).
 * The add persists via `onAdd` (default: native-installer fidelity — append
 * the spec to the existing `plugins[]`, preserving every unrelated entry).
 */
function installHarness(options: {
  preList?: string;
  postLists?: string[];
  npmVersion?: string;
  onAdd?: ((spec: string) => Promise<void>) | null;
}): InstallHarness {
  const calls: string[] = [];
  const delays: number[] = [];
  const preList = options.preList ?? STALE_LIST;
  const postLists = options.postLists ?? [VISIBLE_LIST];
  let added = false;
  let postServed = 0;
  const executor: Executor = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
      if (!added) return { stdout: preList, stderr: "" };
      const output = postLists[Math.min(postServed, postLists.length - 1)];
      postServed += 1;
      return { stdout: output ?? STALE_LIST, stderr: "" };
    }
    if (command === "npm" && args[0] === "view") {
      return { stdout: `${options.npmVersion ?? QUOTA_VERSION}\n`, stderr: "" };
    }
    if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
      const spec = args[2] ?? "";
      added = true;
      if (options.onAdd === null) {
        // Genuine persist failure: exit 0 while the config surface never appears.
      } else if (options.onAdd !== undefined) {
        await options.onAdd(spec);
      } else {
        const dir = openCodeGlobalDir();
        const path = resolve(dir, "opencode.json");
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        const plugins = Array.isArray(parsed["plugins"]) ? [...(parsed["plugins"] as unknown[])] : [];
        plugins.push(spec);
        parsed["plugins"] = plugins;
        await writeFile(path, JSON.stringify(parsed));
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  return {
    calls,
    delays,
    executor,
    pluginLists: () => calls.filter((call) => call === "opencode plugin list").length,
    pluginAdds: () => calls.filter((call) => call.startsWith("opencode plugin add ")).length,
  };
}

const BOUND = { attempts: 3, delayMs: 100 };

async function installWithFakeClock(harness: InstallHarness, useDefaultBound = false) {
  const delay = async (ms: number): Promise<void> => {
    harness.delays.push(ms);
  };
  return installQuotaIfMissing(
    harness.executor,
    useDefaultBound ? { delay } : { convergence: BOUND, delay },
  );
}

describe("T004 Quota post-mutation convergence (persisted-first, bounded poll)", () => {
  it("stale→stale→visible succeeds within the bound with exactly one mutation", async () => {
    const configPath = await seedGlobalConfig({ plugins: [UNRELATED_PLUGIN] });
    const harness = installHarness({ postLists: [STALE_LIST, STALE_LIST, VISIBLE_LIST] });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("installed");
    expect(result.installedVersion).toBe(QUOTA_VERSION);
    expect(result.mutated).toBe(true);
    // Exact-bound proof: 1 pre-check list + 3 post-mutation polls, 2×100ms between retries.
    expect(harness.pluginLists()).toBe(4);
    expect(harness.delays).toEqual([100, 100]);
    // Single-mutation proof: retries repeat observation only, never another add.
    expect(harness.pluginAdds()).toBe(1);
    expect(harness.calls).toContain(`opencode plugin add ${QUOTA_SPEC}`);
    // Unrelated config survives; the quota registration lands exactly once.
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.plugins).toEqual([UNRELATED_PLUGIN, QUOTA_SPEC]);
  });

  it("immediate visibility succeeds with zero extra polls or delays", async () => {
    await ensureGlobalDir();
    const harness = installHarness({ postLists: [VISIBLE_LIST] });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("installed");
    expect(result.mutated).toBe(true);
    // 1 pre-check + 1 post-mutation poll, no delay recorded.
    expect(harness.pluginLists()).toBe(2);
    expect(harness.delays).toEqual([]);
    expect(harness.pluginAdds()).toBe(1);
  });

  it("never-visible fails closed after the exact bound and rolls back byte-identical", async () => {
    const configPath = await seedGlobalConfig({ plugins: [UNRELATED_PLUGIN] });
    const before = await readFile(configPath, "utf8");
    const harness = installHarness({ postLists: [STALE_LIST, STALE_LIST, STALE_LIST] });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    // Exact-bound proof: exhaustion at exactly 3 post-mutation polls, 2×100ms — never more.
    expect(harness.pluginLists()).toBe(4);
    expect(harness.delays).toEqual([100, 100]);
    expect(harness.pluginAdds()).toBe(1);
    expect(result.detail).toMatch(/not listed|did not converge/);
    // Genuine validation failure still rolls the snapshot back byte-for-byte.
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("malformed post-mutation output fails closed and is never treated as not-present", async () => {
    const configPath = await seedGlobalConfig({ plugins: [UNRELATED_PLUGIN] });
    const before = await readFile(configPath, "utf8");
    const harness = installHarness({ postLists: [MALFORMED_LIST, MALFORMED_LIST, MALFORMED_LIST] });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("validation-failed");
    expect(result.rolledBack).toBe(true);
    // Null samples exhaust the same exact bound without ever converging.
    expect(harness.pluginLists()).toBe(4);
    expect(harness.delays).toEqual([100, 100]);
    expect(harness.pluginAdds()).toBe(1);
    expect(result.detail).toMatch(/unavailable or unrecognized|did not converge/);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("unrecognized pre-install output fails closed as report-only with zero mutation", async () => {
    const harness = installHarness({ preList: MALFORMED_LIST });

    const result = await installWithFakeClock(harness);

    // Absence is never inferred from an unrecognized list: no discovery, no add.
    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(harness.calls).toEqual(["opencode plugin list"]);
    expect(harness.pluginAdds()).toBe(0);
  });

  it("missing persisted registration fails immediately; runtime visibility cannot rescue it", async () => {
    // The add exits 0 but persists nothing; the runtime view would show the
    // quota plugin, which must NOT rescue the missing persisted surface.
    await ensureGlobalDir();
    const harness = installHarness({ postLists: [VISIBLE_LIST], onAdd: null });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    // Zero post-mutation polls: persisted-first short-circuits before any list sample.
    expect(harness.pluginLists()).toBe(1);
    expect(harness.delays).toEqual([]);
    expect(harness.pluginAdds()).toBe(1);
    expect(result.detail).toMatch(/missing after the install|carries no quota entry/);
  });

  it("duplicate registration is rejected and rolled back", async () => {
    const configPath = await seedGlobalConfig({ plugins: [UNRELATED_PLUGIN] });
    const before = await readFile(configPath, "utf8");
    const harness = installHarness({
      postLists: [DUPLICATE_LIST],
      onAdd: async (spec) => {
        const dir = openCodeGlobalDir();
        const path = resolve(dir, "opencode.json");
        const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        parsed["plugins"] = [UNRELATED_PLUGIN, spec, spec];
        await writeFile(path, JSON.stringify(parsed));
      },
    });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    // The duplicated persisted surface fails before any runtime sample is taken.
    expect(harness.pluginLists()).toBe(1);
    expect(harness.delays).toEqual([]);
    expect(result.detail).toMatch(/not exactly|more than once|ambiguous/);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("unrelated config (mixed plugin shapes + MCP servers) survives byte-for-byte", async () => {
    const seeded = {
      mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } },
      plugins: [UNRELATED_PLUGIN, ["tuple-plugin@2.0.0", {}], { package: "object-plugin@3.1.4" }],
    };
    const configPath = await seedGlobalConfig(seeded);
    const harness = installHarness({ postLists: [VISIBLE_LIST] });

    const result = await installWithFakeClock(harness);

    expect(result.status).toBe("installed");
    expect(harness.pluginAdds()).toBe(1);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    // Unrelated entries are byte-identical across shapes; only the quota spec is added.
    expect(written.plugins.slice(0, 3)).toEqual(seeded.plugins);
    expect(written.plugins.filter((spec: string) => spec === QUOTA_SPEC)).toEqual([QUOTA_SPEC]);
    expect(written.mcp).toEqual(seeded.mcp);
  });

  it("default bound stays 3 polls / 100ms (no lengthened sleeps)", async () => {
    expect(DEFAULT_LIST_CONVERGENCE).toEqual({ attempts: 3, delayMs: 100 });
    expect((DEFAULT_LIST_CONVERGENCE.attempts - 1) * DEFAULT_LIST_CONVERGENCE.delayMs).toBeLessThan(1000);
    await seedGlobalConfig({ plugins: [UNRELATED_PLUGIN] });
    const harness = installHarness({ postLists: [STALE_LIST] });

    const result = await installWithFakeClock(harness, true);

    // Without an explicit bound the production default still exhausts at
    // exactly 3 post-mutation polls with 2×100ms delays.
    expect(result.status).toBe("validation-failed");
    expect(harness.pluginLists()).toBe(4);
    expect(harness.delays).toEqual([100, 100]);
    expect(harness.pluginAdds()).toBe(1);
  });
});
