import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { receiveUpgradeHandoff, selfUpgradeAria } from "../src/aria-upgrade.js";
import type { Executor, ExecutorOptions } from "../src/deps.js";
import { runUpgrade, type AriaAvailableTarget } from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// R006 — stale installed CLI in `aria upgrade` (focused public-interface
// regressions through `runUpgrade`, never the adapter alone).
//
// ARIA is already current only when BOTH the installed/OpenCode
// registration AND the running globally installed CLI are at the target.
// The reproduced case (plugin 1.1.0 + CLI 1.0.15 at target 1.1.0) must not
// return no-changes-made: it takes the existing bounded R003 exact-target
// CLI-update path (`npm install -g <exact-target-spec>` inside the
// self-upgrade adapter, then the one-shot handoff with no registration
// replacement), leaving bare `aria --version` at 1.1.0.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-r006-"));
  tempDirs.push(root);
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  return { root, configDir };
}

const TARGET_110: AriaAvailableTarget = {
  tag: "v1.1.0",
  version: "1.1.0",
  spec: "github:mscipio/ARIA#v1.1.0",
};

const STALE_CLI = "1.0.15";

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

interface RecordedCall {
  command: string;
  args: string[];
  options?: ExecutorOptions;
}

/** Fake world: real registration probe at the target, real CLI-update + handoff seams. */
function makeWorld(options: { failNpmInstall?: boolean; staleInstall?: boolean; initialBareVersion?: string } = {}): {
  executor: Executor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  // Fake globally installed bare CLI version: starts stale by default (the
  // reproduced plugin 1.1.0 + CLI 1.0.15 case) and moves on
  // `npm install -g`. R001 true-current cases pin it at the target up front.
  let cliVersion = options.initialBareVersion ?? STALE_CLI;
  const executor: Executor = async (command, args, channel) => {
    // R006 convergence probe (read-only verification, never a mutation):
    // served without recording so mutation-order assertions keep meaning.
    if (command === "aria" && args[0] === "--version") {
      return { stdout: cliVersion, stderr: "" };
    }
    calls.push({ command, args, options: channel });
    const key = `${command} ${args.join(" ")}`;
    if (key === "opencode plugin list") {
      return { stdout: pluginTable([["aria", "deadbee", TARGET_110.spec]]), stderr: "" };
    }
    if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
    if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (key === "engram version") throw new Error("engram not found");
    if (key === "codegraph --version") throw new Error("codegraph not found");
    if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
    if (command === "npm" && args[0] === "install") {
      if (options.failNpmInstall) throw new Error("npm install -g failed: network unavailable");
      // A silent stale install (exit 0 with the bare CLI unchanged, e.g.
      // wrong npm prefix or PATH shadowing) moves nothing: the convergence
      // gate must fail closed instead of reporting success.
      if (!options.staleInstall) {
        const match = (args[2] ?? "").match(/#v(\d+\.\d+\.\d+)\s*$/);
        if (match) cliVersion = match[1] as string;
      }
      return { stdout: "installed", stderr: "" };
    }
    throw new Error(`Unexpected command: ${key}`);
  };
  return { executor, calls };
}

async function noDelay(): Promise<void> {}

/** In-memory persisted registration: single entry at the target (synchronous-persist mirror). */
async function persistedAtTarget(): Promise<{ kind: "ok"; path: string; specs: string[] }> {
  return { kind: "ok", path: "fake-persisted-opencode.json", specs: [TARGET_110.spec] };
}

/** Third-party upgrade commands that the ARIA CLI-update path must never run. */
const THIRD_PARTY_UPGRADES = [
  "brew install",
  "brew upgrade",
  "python3 -m pip install",
  "opencode plugin add",
  "opencode plugin remove",
  "opencode plugin update",
  "opencode-quota update",
  "engram setup",
  "codegraph install",
  "codegraph upgrade",
  "zotpilot upgrade",
  "zotpilot register",
  "zotpilot install",
];

function callText(call: RecordedCall): string {
  return `${call.command} ${call.args.join(" ")}`;
}

describe("R006 stale installed CLI takes the bounded CLI-update path", () => {
  it("registration current + CLI stale executes the CLI update and hands off (never no-changes-made)", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const world = makeWorld();
    let handoffs = 0;
    let seamCalled = 0;

    const result = await runUpgrade(world.executor, {
      configDir,
      // Registration is observed (not pinned) at the target; the running
      // CLI is pinned stale — the reproduced plugin 1.1.0 + CLI 1.0.15 case.
      cliVersion: STALE_CLI,
      availableOverride: TARGET_110,
      approval: { yes: true },
      // The existing bounded R003 machinery: exact-target CLI update, then
      // the one-shot handoff with no registration replacement.
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async () => {
            handoffs++;
            return {
              ok: true,
              detail: "stub handoff taken",
              stdout: `ARIA upgrade report\nUpgrade to ${TARGET_110.spec} completed (${TARGET_110.tag})`,
            };
          },
        }),
      // Even when a dependency seam is present it must not run on the
      // handoff path (production `aria upgrade` carries none at all).
      dependenciesFn: async () => {
        seamCalled++;
        throw new Error("dependencies must not run pre-handoff");
      },
    });

    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain("no changes made");
    // The bounded exact-target CLI update executed (what moves bare
    // `aria --version` to the target release).
    expect(world.calls.map(callText)).toContain(`npm install -g ${TARGET_110.spec}`);
    // Registration already at target: no replacement, still one handoff.
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin remove"))).toBe(false);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin add"))).toBe(false);
    expect(handoffs).toBe(1);
    // No third-party upgrade invoked and the dependency seam never ran.
    expect(seamCalled).toBe(0);
    expect(result.dependencies).toBeUndefined();
    for (const call of world.calls.map(callText)) {
      expect(THIRD_PARTY_UPGRADES.some((mutation) => call.startsWith(mutation))).toBe(false);
    }
  });

  it("both current is a true no-op with zero mutation", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    // R001: true already-current requires the positively verified bare CLI
    // at the target too — start the fake bare CLI at the target.
    const world = makeWorld({ initialBareVersion: TARGET_110.version });

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: TARGET_110.version,
      availableOverride: TARGET_110,
      approval: { yes: true },
      selfUpgradeFn: async () => {
        throw new Error("self-upgrade must not run when both are current");
      },
    });

    expect(result.stage).toBe("already-current");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("no changes made");
    // Inventory probes only: no CLI update, no replacement, no handoff spawn.
    for (const call of world.calls.map(callText)) {
      expect(call.startsWith("npm install")).toBe(false);
      expect(call.startsWith("npm exec")).toBe(false);
      expect(call.startsWith("opencode plugin remove")).toBe(false);
      expect(call.startsWith("opencode plugin add")).toBe(false);
    }
    // Positive bare-CLI verification ran and observed the target.
    const bare = await world.executor("aria", ["--version"]);
    expect(bare.stdout.trim()).toBe(TARGET_110.version);
  });

  it("R001 running package at target with a stale bare CLI is NOT already-current (repairs via the single CLI-update path)", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    // Registration observed at the target; the running package version is
    // pinned at the target, but the globally installed bare CLI starts
    // stale (default world). R001: running version alone must never report
    // already-current while the bare CLI remains stale.
    const world = makeWorld();
    let handoffs = 0;

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: TARGET_110.version,
      availableOverride: TARGET_110,
      approval: { yes: true },
      // Real public orchestration path: the existing bounded R003 adapter
      // (the single `npm install -g <exact-target-spec>` updater) plus the
      // one-shot handoff with no registration replacement.
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async () => {
            handoffs++;
            return {
              ok: true,
              detail: "stub handoff taken",
              stdout: `ARIA upgrade report\nUpgrade to ${TARGET_110.spec} completed (${TARGET_110.tag})`,
            };
          },
        }),
    });

    // Fail-closed: staleness is never reported as success.
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.stage).not.toBe("already-current");
    expect(result.detail).not.toContain("no changes made");
    // The single exact-target CLI update executed (no second updater) and
    // the bare CLI converged to the target with no registration replacement.
    expect(world.calls.map(callText)).toContain(`npm install -g ${TARGET_110.spec}`);
    expect(world.calls.map(callText).filter((call) => call.startsWith("npm install")).length).toBe(1);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin remove"))).toBe(false);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin add"))).toBe(false);
    expect(handoffs).toBe(1);
    const bare = await world.executor("aria", ["--version"]);
    expect(bare.stdout.trim()).toBe(TARGET_110.version);
    for (const call of world.calls.map(callText)) {
      expect(THIRD_PARTY_UPGRADES.some((mutation) => call.startsWith(mutation))).toBe(false);
    }
  });

  it("CLI update failure fails closed with no false current", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const world = makeWorld({ failNpmInstall: true });
    let handoffs = 0;

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: STALE_CLI,
      availableOverride: TARGET_110,
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async () => {
            handoffs++;
            return { ok: true, detail: "must not hand off after CLI failure", stdout: "" };
          },
        }),
    });

    expect(result.stage).toBe("self-upgrade-failed");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("installed CLI update did not complete");
    expect(result.detail).not.toContain("already current");
    // Fail-closed: the CLI update was attempted, but the registration was
    // never touched and no handoff ran.
    expect(world.calls.map(callText)).toContain(`npm install -g ${TARGET_110.spec}`);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin remove"))).toBe(false);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin add"))).toBe(false);
    expect(handoffs).toBe(0);
  });

  it("public upgrade→handoff chain converges the bare CLI with the registration (real receive)", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const world = makeWorld();
    let received: { stage: string; ok: boolean } | null = null;

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: STALE_CLI,
      availableOverride: TARGET_110,
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async (next, nextTarget) => {
            // Real new-release receive half through the public handoff path
            // (all post-handoff phases stubbed; the payload/identity binding
            // is what this path proves).
            const continuation = await receiveUpgradeHandoff(JSON.stringify(next), nextTarget.version, {
              executor: world.executor,
              components: {
                engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
                context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
                codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
                zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
                quota: async () => ({ component: "quota", status: "skipped", detail: "stubbed", mutated: false }),
              },
              normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
              regenFn: async () => ({ ok: true, detail: "no regen required", mutated: false }),
              depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: false }),
              doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
            });
            received = { stage: continuation.stage, ok: continuation.ok };
            return {
              ok: continuation.ok,
              detail: continuation.detail,
              stdout: continuation.ok ? `Upgrade to ${nextTarget.spec} completed (${nextTarget.tag})` : "",
            };
          },
        }),
    });

    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain("no changes made");
    // CLI and registration converge together: the single exact-target
    // install moved the bare CLI while the registration stayed single at
    // the target (no replacement, still one handoff).
    expect(world.calls.map(callText)).toContain(`npm install -g ${TARGET_110.spec}`);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin remove"))).toBe(false);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin add"))).toBe(false);
    const bare = await world.executor("aria", ["--version"]);
    expect(bare.stdout.trim()).toBe(TARGET_110.version);
    // The real handoff receive completed in the target release.
    expect(received).toMatchObject({ stage: "complete", ok: true });
  });

  it("silent CLI staleness (install exit 0, bare CLI unchanged) fails closed with zero mutation", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const world = makeWorld({ staleInstall: true });
    let handoffs = 0;

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: STALE_CLI,
      availableOverride: TARGET_110,
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async () => {
            handoffs++;
            return { ok: true, detail: "must not hand off without CLI convergence", stdout: "" };
          },
        }),
    });

    expect(result.stage).toBe("self-upgrade-failed");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not converge");
    expect(result.detail).not.toContain("already current");
    // Fail-closed: the install was attempted, but the registration was
    // never touched, no handoff ran, and the bare CLI is still stale —
    // staleness can never be reported as success.
    expect(world.calls.map(callText)).toContain(`npm install -g ${TARGET_110.spec}`);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin remove"))).toBe(false);
    expect(world.calls.map(callText).some((call) => call.startsWith("opencode plugin add"))).toBe(false);
    expect(handoffs).toBe(0);
    const bare = await world.executor("aria", ["--version"]);
    expect(bare.stdout.trim()).toBe(STALE_CLI);
  });

  it("T010 bounded timeout: the single CLI-update install carries 600000ms while R006 verdicts are unchanged", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const world = makeWorld();
    let handoffs = 0;

    const result = await runUpgrade(world.executor, {
      configDir,
      cliVersion: STALE_CLI,
      availableOverride: TARGET_110,
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) =>
        selfUpgradeAria(target, handoff, {
          executor: world.executor,
          readPersistedPlugins: persistedAtTarget,
          delay: noDelay,
          handoffSpawn: async () => {
            handoffs++;
            return {
              ok: true,
              detail: "stub handoff taken",
              stdout: `ARIA upgrade report\nUpgrade to ${TARGET_110.spec} completed (${TARGET_110.tag})`,
            };
          },
        }),
    });

    // R006 verdict unchanged: stale CLI still takes the bounded update + handoff path.
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain("no changes made");
    expect(handoffs).toBe(1);
    // The single exact-target install carries the raised bound; every other
    // recorded call keeps the 120s default (no timeoutMs).
    const installs = world.calls.filter((call) => call.command === "npm" && call.args[0] === "install");
    expect(installs).toHaveLength(1);
    expect(installs[0]?.options?.timeoutMs).toBe(600_000);
    for (const call of world.calls) {
      if (call.command === "npm" && call.args[0] === "install") continue;
      expect(call.options?.timeoutMs, callText(call)).toBeUndefined();
    }
  });
});
