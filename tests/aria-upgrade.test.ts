import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { Executor, ExecutorOptions } from "../src/deps.js";
import {
  classifyAriaRegistration,
  detectAriaRegistration,
  makeDefaultHandoffSpawn,
  receiveUpgradeHandoff,
  selfUpgradeAria,
  type HandoffSpawnFn,
} from "../src/aria-upgrade.js";
import {
  buildUpgradeHandoff,
  isHandoffMatch,
  runUpgrade,
  UPGRADE_COMPONENTS,
  type AriaAvailableTarget,
  type UpgradeCheckResult,
  type UpgradeComponentRow,
  type UpgradeHandoff,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T011 ARIA self-upgrade adapter: exact-Git-identity detection, pre-removal
// validation, rollback-safe remove/replace/re-register (never
// `plugin update`), unrelated preservation, one-shot handoff with
// target-immutability, old-code-stops, and new-release receive gating.
//
// Sandbox discipline (T019): this suite performs zero filesystem writes
// outside temp dirs (one read-only-missing config dir for the orchestration
// proof) and never touches caller config paths. All plugin/registry effects
// run through a stateful fake executor; per-call git env is asserted on the
// recorded call options while `process.env` stays clean.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const TARGET_106: AriaAvailableTarget = { tag: "v1.0.6", version: "1.0.6", spec: "github:mscipio/ARIA#v1.0.6" };
const TARGET_107: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

const UNRELATED_ROWS: Array<[string, string, string]> = [
  ["@slkiser/opencode-quota.server", "5.0.2", "@slkiser/opencode-quota@5.0.2"],
  ["engram", "local", "/home/user/.config/opencode/plugins/engram.ts"],
  ["-", "-", "list"],
];

function ariaRow(spec: string, version = "67639df"): [string, string, string] {
  return ["aria", version, spec];
}

function checkWithTarget(target: AriaAvailableTarget): UpgradeCheckResult {
  const rows: UpgradeComponentRow[] = UPGRADE_COMPONENTS.map((component) => (
    component === "aria"
      ? { component, installed: "1.0.6", available: target.tag, status: "upgrade-available", detail: "upgrade available" }
      : { component, installed: "remote", available: null, status: "remote-healthy", detail: "observed" }
  ));
  return { currentVersion: "1.0.6", available: { kind: "known", target }, selfUpgradeBlocked: false, blockReason: null, components: rows };
}

function handoffFor(target: AriaAvailableTarget): UpgradeHandoff {
  return buildUpgradeHandoff(target, checkWithTarget(target));
}

interface RecordedCall {
  command: string;
  args: string[];
  options?: ExecutorOptions;
}

interface FakePluginWorld {
  executor: Executor;
  calls: RecordedCall[];
  rows: Array<[string, string, string]>;
  failRemove: Set<string>;
  failAdd: Set<string>;
  failListCount: number;
  /** Spec whose add pushes a duplicated row (models a registry duplication fault). */
  duplicateAddSpec: string | null;
  spawnStdout: string | null;
  spawnError: string | null;
}

function makeFakePluginWorld(initial: Array<[string, string, string]>): FakePluginWorld {
  const world: FakePluginWorld = {
    executor: async (command, args, options) => {
      world.calls.push({ command, args, options });
      const key = `${command} ${args.join(" ")}`;
      if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
        if (world.failListCount > 0) {
          world.failListCount--;
          throw new Error("opencode plugin list failed: connection refused");
        }
        return { stdout: world.rows.length === 0 ? "No plugins found" : pluginTable(world.rows), stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "remove") {
        const spec = args[2] ?? "";
        if (world.failRemove.has(spec)) throw new Error(`opencode plugin remove ${spec} failed: backend error`);
        if (!world.rows.some((row) => row[2] === spec)) throw new Error(`plugin ${spec} is not configured`);
        world.rows = world.rows.filter((row) => row[2] !== spec);
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
        const spec = args[2] ?? "";
        if (world.failAdd.has(spec)) throw new Error(`opencode plugin add ${spec} failed: fetch failed`);
        world.rows.push(["aria", "deadbee", spec]);
        if (world.duplicateAddSpec === spec) world.rows.push(["aria", "deadbee", spec]);
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "npm" && args[0] === "exec") {
        if (world.spawnError !== null) {
          throw Object.assign(new Error(world.spawnError), { stdout: "", stderr: world.spawnError });
        }
        return { stdout: world.spawnStdout ?? "", stderr: "" };
      }
      throw new Error(`unexpected call: ${key}`);
    },
    calls: [],
    rows: [...initial],
    failRemove: new Set(),
    failAdd: new Set(),
    failListCount: 0,
    duplicateAddSpec: null,
    spawnStdout: null,
    spawnError: null,
  };
  return world;
}

function initial106(): Array<[string, string, string]> {
  return [ariaRow(TARGET_106.spec), ...UNRELATED_ROWS];
}

function capturingSpawn(captured: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }>): HandoffSpawnFn {
  return async (handoff, target) => {
    captured.push({ handoff, target });
    return { ok: true, detail: "stub handoff taken", stdout: `ARIA upgrade report\nUpgrade to ${target.spec} completed (${target.tag})` };
  };
}

function gitEnvCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.options?.env?.["NPM_CONFIG_ALLOW_GIT"] === "all");
}

/** Payload carried by an npm-exec handoff spawn call. */
function spawnPayload(call: RecordedCall): string {
  const flag = call.args.indexOf("--handoff-json");
  if (flag === -1 || flag + 1 >= call.args.length) throw new Error("spawn call carries no --handoff-json payload");
  return call.args[flag + 1] as string;
}

describe("T011 current-registration detection (exact Git identity)", () => {
  it("identifies a single exact v-tag registration with the version from the ref", () => {
    const detection = classifyAriaRegistration(pluginTable(initial106()));
    expect(detection).toMatchObject({ kind: "identified", spec: TARGET_106.spec, ref: "v1.0.6", version: "1.0.6" });
  });

  it("identifies an exact 40-hex SHA spec with a null version (immutable, unversioned)", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const detection = classifyAriaRegistration(pluginTable([ariaRow(`github:mscipio/ARIA#${sha}`)]));
    expect(detection).toMatchObject({ kind: "identified", version: null });
  });

  it("fails closed unknown on empty, aria-free, and unrecognized output", () => {
    expect(classifyAriaRegistration("No plugins found").kind).toBe("unknown");
    expect(classifyAriaRegistration(pluginTable([...UNRELATED_ROWS])).kind).toBe("unknown");
    expect(classifyAriaRegistration("garbage output").kind).toBe("unknown");
  });

  it("fails closed ambiguous on multiple distinct ARIA specs", () => {
    const detection = classifyAriaRegistration(pluginTable([ariaRow(TARGET_106.spec), ariaRow(TARGET_107.spec)]));
    expect(detection.kind).toBe("ambiguous");
  });

  it("fails closed on non-Git aria ids (unsupported alone, ambiguous mixed)", () => {
    expect(classifyAriaRegistration(pluginTable([["aria", "local", "/some/checkout"]])).kind).toBe("unsupported");
    expect(classifyAriaRegistration(pluginTable([ariaRow(TARGET_106.spec), ["aria", "local", "/some/checkout"]])).kind).toBe("ambiguous");
  });

  it("fails closed unknown on inexact refs (branch, moving tag, short SHA)", () => {
    for (const ref of ["main", "latest", "67639df", "v1.0", ""]) {
      expect(classifyAriaRegistration(pluginTable([ariaRow(`github:mscipio/ARIA#${ref}`)])).kind).toBe("unknown");
    }
  });

  it("reports unknown when plugin list itself fails", async () => {
    const world = makeFakePluginWorld(initial106());
    world.failListCount = 1;
    const detection = await detectAriaRegistration(world.executor);
    expect(detection.kind).toBe("unknown");
    expect(world.calls).toHaveLength(1);
  });
});

describe("T011 replace, validation, and preservation", () => {
  it("replaces the exact ref, verifies a single registration, preserves unrelated entries, and hands off once", async () => {
    const world = makeFakePluginWorld(initial106());
    const hadGitKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    const captured: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }> = [];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), {
      executor: world.executor,
      handoffSpawn: capturingSpawn(captured),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.handoffNote).toContain("performs no further work");
    // Exact call order: detect → remove current → add target → verify → one-shot spawn. Never `plugin update`.
    expect(world.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "opencode plugin list",
      `opencode plugin remove ${TARGET_106.spec}`,
      `opencode plugin add ${TARGET_107.spec}`,
      "opencode plugin list",
    ]);
    expect(world.calls.some((call) => call.args[1] === "update")).toBe(false);
    expect(captured).toHaveLength(1);
    // Exactly one ARIA registration at the new ref; unrelated rows byte-identical (order-insensitive).
    const ariaRows = world.rows.filter((row) => row[0] === "aria");
    expect(ariaRows.map((row) => row[2])).toEqual([TARGET_107.spec]);
    expect(world.rows.filter((row) => row[0] !== "aria")).toEqual(expect.arrayContaining(UNRELATED_ROWS));
    expect(world.rows.filter((row) => row[0] !== "aria")).toHaveLength(UNRELATED_ROWS.length);
    // Process-local git env on the mutating calls only; never in process.env.
    expect(gitEnvCalls(world.calls).map((call) => call.args[1])).toEqual(["remove", "add"]);
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadGitKey);
  });

  it("skips replacement when already at the validated target but still hands off once", async () => {
    const world = makeFakePluginWorld([ariaRow(TARGET_107.spec, "newsha1"), ...UNRELATED_ROWS]);
    const captured: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }> = [];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), {
      executor: world.executor,
      handoffSpawn: capturingSpawn(captured),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("no replacement performed");
    expect(world.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual(["opencode plugin list"]);
    expect(captured).toHaveLength(1);
  });

  it("uses the default npm-exec transport with per-call git env when no spawn seam is given", async () => {
    const world = makeFakePluginWorld(initial106());
    world.spawnStdout = `ARIA upgrade report\nUpgrade to ${TARGET_107.spec} completed (${TARGET_107.tag})`;
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(true);
    const spawn = world.calls.find((call) => call.command === "npm");
    expect(spawn?.args.slice(0, 7)).toEqual(["exec", "--yes", "--package", TARGET_107.spec, "--", "aria", "upgrade"]);
    expect(spawn === undefined ? "" : spawnPayload(spawn)).toContain("aria-upgrade-handoff");
    expect(spawn?.options?.env?.["NPM_CONFIG_ALLOW_GIT"]).toBe("all");
    expect(makeDefaultHandoffSpawn).toBeDefined();
  });
});

describe("T011 pre-removal gates (zero mutation on failure)", () => {
  it("validates the requested target before touching the current registration", async () => {
    const world = makeFakePluginWorld(initial106());
    const evil = { tag: "v1.0.7", version: "1.0.7", spec: "github:evil/ARIA#v1.0.7" };
    const outcome = await selfUpgradeAria(evil, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(world.calls).toHaveLength(0);
    expect(world.rows).toEqual(initial106());
  });

  it("refuses when the handoff-bound target differs from the requested target", async () => {
    const world = makeFakePluginWorld(initial106());
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor({ ...TARGET_107, spec: "github:mscipio/ARIA#v1.0.8", tag: "v1.0.8", version: "1.0.8" }), {
      executor: world.executor,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("handoff target mismatch");
    expect(world.calls).toHaveLength(0);
  });

  it("fails closed with a single read-only probe on ambiguous current state", async () => {
    const world = makeFakePluginWorld([ariaRow(TARGET_106.spec), ariaRow(TARGET_107.spec), ...UNRELATED_ROWS]);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(world.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual(["opencode plugin list"]);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2]).sort()).toEqual([TARGET_106.spec, TARGET_107.spec].sort());
  });
});

describe("T011 rollback (original restored or exact unresolved state)", () => {
  it("restores the original spec when re-registration fails, with git env on the rollback", async () => {
    const world = makeFakePluginWorld(initial106());
    world.failAdd.add(TARGET_107.spec);
    const captured: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }> = [];
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), {
      executor: world.executor,
      handoffSpawn: capturingSpawn(captured),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain(`original registration restored (${TARGET_106.spec})`);
    expect(captured).toHaveLength(0);
    expect(world.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "opencode plugin list",
      `opencode plugin remove ${TARGET_106.spec}`,
      `opencode plugin add ${TARGET_107.spec}`,
      "opencode plugin list",
      `opencode plugin remove ${TARGET_107.spec}`,
      `opencode plugin add ${TARGET_106.spec}`,
      "opencode plugin list",
    ]);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_106.spec]);
    for (const call of world.calls.filter((call) => call.args[1] === "add" || call.args[1] === "remove")) {
      expect(call.options?.env?.["NPM_CONFIG_ALLOW_GIT"]).toBe("all");
    }
    expect(world.calls.some((call) => call.args[1] === "update")).toBe(false);
  });

  it("reports the exact unresolved state when rollback also fails", async () => {
    const world = makeFakePluginWorld(initial106());
    world.failAdd.add(TARGET_107.spec);
    world.failAdd.add(TARGET_106.spec);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain("unresolved");
    expect(outcome.registration).toContain(TARGET_106.spec);
  });

  it("leaves the verified-intact original alone when removal fails (no add attempted)", async () => {
    const world = makeFakePluginWorld(initial106());
    world.failRemove.add(TARGET_106.spec);
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain(`original registration intact (${TARGET_106.spec})`);
    expect(world.calls.some((call) => call.args[1] === "add")).toBe(false);
    expect(world.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "opencode plugin list",
      `opencode plugin remove ${TARGET_106.spec}`,
      "opencode plugin list",
    ]);
  });

  it("rolls back a duplicated post-add registration to the single original", async () => {
    const world = makeFakePluginWorld(initial106());
    world.duplicateAddSpec = TARGET_107.spec;
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain(`original registration restored (${TARGET_106.spec})`);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_106.spec]);
  });
});

describe("T011 handoff target immutability and failure states", () => {
  it("hands the exact validated target plus the approved scope to the spawn, exactly once", async () => {
    const world = makeFakePluginWorld(initial106());
    const handoff = handoffFor(TARGET_107);
    const seen: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }> = [];
    const outcome = await selfUpgradeAria(TARGET_107, handoff, {
      executor: world.executor,
      handoffSpawn: async (next, nextTarget) => {
        seen.push({ handoff: next, target: nextTarget });
        return { ok: true, detail: "stub taken", stdout: `done ${nextTarget.tag}` };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const handed = seen[0];
    expect(handed?.target).toEqual(TARGET_107);
    expect(handed?.handoff.target).toEqual(TARGET_107);
    expect(handed?.handoff.approvedComponents).toEqual(handoff.approvedComponents);
    // The exact-match gate passes on exactly what was handed over.
    if (handed === undefined) throw new Error("expected one handoff");
    expect(isHandoffMatch(handed.handoff, TARGET_107, handed.handoff.approvedComponents)).toEqual({ match: true });
  });

  it("proves the spawned payload is immutable: the npm-exec argv carries the pre-mutation snapshot", async () => {
    const world = makeFakePluginWorld(initial106());
    world.spawnStdout = `ok ${TARGET_107.tag}`;
    const handoff = handoffFor(TARGET_107);
    const outcome = await selfUpgradeAria(TARGET_107, handoff, { executor: world.executor });
    expect(outcome.ok).toBe(true);
    const spawn = world.calls.find((call) => call.command === "npm");
    if (spawn === undefined) throw new Error("expected one npm-exec spawn");
    const sent = JSON.parse(spawnPayload(spawn)) as UpgradeHandoff;
    expect(sent.target).toEqual(TARGET_107);
    expect(sent.approvedComponents).toEqual(handoff.approvedComponents);
    handoff.target.spec = "github:mscipio/ARIA#v9.9.9";
    expect(sent.target.spec).toBe(TARGET_107.spec);
  });

  it("keeps the verified new registration and reports exactly when the handoff spawn fails", async () => {
    const world = makeFakePluginWorld(initial106());
    world.spawnError = "npm exec failed: network unavailable";
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain(`replaced (single registration at ${TARGET_107.spec})`);
    expect(outcome.registration).toContain("continuation not started");
    expect(outcome.detail).toContain("aria upgrade --yes");
    // No rollback of a good replacement: nothing runs after the spawn.
    expect(world.calls.map((call) => `${call.command} ${call.args[0]} ${call.args[1]}`)).toEqual([
      "opencode plugin list",
      "opencode plugin remove",
      "opencode plugin add",
      "opencode plugin list",
      "npm exec --yes",
    ]);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });

  it("reports unconfirmed ownership when the new release does not acknowledge the target tag", async () => {
    const world = makeFakePluginWorld(initial106());
    world.spawnStdout = "some unrelated output";
    const outcome = await selfUpgradeAria(TARGET_107, handoffFor(TARGET_107), { executor: world.executor });
    expect(outcome.ok).toBe(false);
    expect(outcome.registration).toContain("ownership unconfirmed");
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });
});

describe("T011 old-code-stops proof through the real T010 orchestration", () => {
  const LS_REMOTE_SAMPLE = ["aaa111\trefs/tags/v1.0.6", "bbb222\trefs/tags/v1.0.7", ""].join("\n");
  const HEALTHY_MCP_LIST = ["MCP Servers", "engram connected", "context7 connected"].join("\n");

  async function makeIsolatedConfigDir(): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-aria-upgrade-"));
    tempDirs.push(root);
    const configDir = resolve(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    return configDir;
  }

  it("takes the handoff with the real adapter and performs no post-handoff phases", async () => {
    const configDir = await makeIsolatedConfigDir();
    const rows: Array<[string, string, string]> = initial106();
    const calls: string[] = [];
    const seen: Array<{ handoff: UpgradeHandoff; target: AriaAvailableTarget }> = [];
    const executor: Executor = async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`);
      void options;
      if (command === "git" && args[0] === "ls-remote") return { stdout: LS_REMOTE_SAMPLE, stderr: "" };
      if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
        return { stdout: pluginTable(rows), stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "remove") {
        rows.splice(0, rows.length, ...rows.filter((row) => row[2] !== args[2]));
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
        rows.push(["aria", "deadbee", args[2] ?? ""]);
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") return { stdout: HEALTHY_MCP_LIST, stderr: "" };
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };

    const result = await runUpgrade(executor, {
      configDir,
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor,
          handoffSpawn: async (next, nextTarget) => {
            seen.push({ handoff: next, target: nextTarget });
            return { ok: true, detail: "stub taken", stdout: `done ${nextTarget.tag}` };
          },
        }),
    });

    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.handoff?.target.spec).toBe(TARGET_107.spec);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target.spec).toBe(TARGET_107.spec);
    // Old code stops: no outcomes/report keys, and no post-handoff command
    // (normalize, regen, sync, doctor, component upgrades) ever ran.
    expect("outcomes" in result).toBe(false);
    expect("report" in result).toBe(false);
    const allowed = new Set([
      "git ls-remote https://github.com/mscipio/ARIA.git",
      "opencode plugin list",
      `opencode plugin remove ${TARGET_106.spec}`,
      `opencode plugin add ${TARGET_107.spec}`,
      "opencode mcp list",
      "engram version",
      "codegraph --version",
    ]);
    for (const call of calls) {
      expect(allowed.has(call), `post-handoff or unexpected call: ${call}`).toBe(true);
    }
    expect(rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });
});

describe("T011 new-release handoff receiver", () => {
  function throwingExecutor(): Executor {
    return async () => {
      throw new Error("receiver must not call the executor on this path");
    };
  }

  it("stops for fresh approval on target drift with zero mutation", async () => {
    const handoff = handoffFor(TARGET_107);
    const result = await receiveUpgradeHandoff(JSON.stringify(handoff), "1.0.6", { executor: throwingExecutor() });
    expect(result.stage).toBe("drift-blocked");
    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([]);
    expect(result.report).toBe("");
  });

  it("fails closed on malformed payloads and inexact own versions with zero mutation", async () => {
    const executor = throwingExecutor();
    expect((await receiveUpgradeHandoff("not-json", "1.0.7", { executor })).ok).toBe(false);
    expect((await receiveUpgradeHandoff(JSON.stringify({ kind: "nope" }), "1.0.7", { executor })).ok).toBe(false);
    const handoff = handoffFor(TARGET_107);
    expect((await receiveUpgradeHandoff(JSON.stringify(handoff), "0.0.0-dev", { executor })).ok).toBe(false);
  });

  it("continues through the T010 sequence on an exact match (wire-through, no duplication)", async () => {
    const handoff = handoffFor(TARGET_107);
    const result = await receiveUpgradeHandoff(JSON.stringify(handoff), "1.0.7", {
      executor: throwingExecutor(),
      // T017: continuation defaults are now the real shared lifecycle; stub
      // all five to isolate the wire-through path.
      components: {
        engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
        context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
        codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
        zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
        quota: async () => ({ component: "quota", status: "skipped", detail: "nothing installed", mutated: false }),
      },
      normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
      regenFn: async () => ({ ok: true, detail: "no regen required", mutated: false }),
      depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: false }),
      doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
    });
    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    expect(result.report).toContain("Before:");
    expect(result.report).toContain("After:");
    expect([...UPGRADE_COMPONENTS].sort()).toEqual(["aria", "codegraph", "context7", "engram", "quota", "zotpilot"].sort());
  });
});
