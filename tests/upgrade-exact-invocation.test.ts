import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { Executor } from "../src/deps.js";
import { buildHandoffSpawnArgv, migrateAriaFromExact, selfUpgradeAria } from "../src/aria-upgrade.js";
import {
  ARIA_GIT_SPEC_PREFIX,
  PROCESS_LOCAL_GIT_ENV,
  buildExactUpgradeApprovalArgv,
  buildMigrateApprovalArgv,
  formatApprovalGuidance,
  formatBlockedApprovalDetail,
  formatExactUpgradeApprovalCommand,
  formatMigrateApprovalCommand,
  formatUpgradeCheck,
  installedSpecForGuidance,
  ownReleaseTarget,
  parseMigrateFromSpec,
  runMigrateUpgrade,
  runUpgrade,
  type AriaAvailableTarget,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T003 exact-package upgrade invocation: bare `aria upgrade --yes` is never
// offered; the executable form pins the positively identified installed
// exact Git spec via `NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package
// <spec> -- aria upgrade --yes` (per-invocation process-local Git allowance,
// never global/`.npmrc`) with verified argument boundaries. `bin/aria.mjs` needs no
// launcher (it dispatches relative to its own location, so npm selects the
// release). Formatting/checking never mutates; the approved `--yes` path
// still replaces the identified registration via the guarded mechanism.
// ---------------------------------------------------------------------------

const TARGET_106: AriaAvailableTarget = { tag: "v1.0.6", version: "1.0.6", spec: "github:mscipio/ARIA#v1.0.6" };
const TARGET_107: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

describe("T003 installed spec derivation (fail-closed, never guessed)", () => {
  it("maps an exact X.Y.Z version to its Git spec and rejects everything else", () => {
    expect(installedSpecForGuidance("1.0.6")).toBe("github:mscipio/ARIA#v1.0.6");
    expect(installedSpecForGuidance(null)).toBeNull();
    for (const inexact of ["0.0.0-dev", "1.0", "v1.0.6", "", "latest", "67639df", "1.0.6-rc.1"]) {
      expect(installedSpecForGuidance(inexact)).toBeNull();
    }
  });
});

describe("T003 exact approval argv boundaries (pure, no mutation)", () => {
  it("selects the installed exact spec with the npm boundary contract", () => {
    const hadGitKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    const argv = buildExactUpgradeApprovalArgv(TARGET_106.spec);
    // Exact boundary contract: npm <argv>; --package before --; aria after --.
    expect(argv).toEqual(["exec", "--yes", "--package", TARGET_106.spec, "--", "aria", "upgrade", "--yes"]);
    const packageFlag = argv.indexOf("--package");
    const separator = argv.indexOf("--");
    const ariaIndex = argv.indexOf("aria");
    expect(packageFlag).toBeGreaterThanOrEqual(0);
    expect(separator).toBeGreaterThan(packageFlag + 1);
    expect(argv[packageFlag + 1]).toBe(TARGET_106.spec);
    expect(ariaIndex).toBe(separator + 1);
    // Selects the exact Git namespace: never a checkout path, file URI, or bare name.
    expect(argv[packageFlag + 1]?.startsWith(ARIA_GIT_SPEC_PREFIX)).toBe(true);
    for (const entry of argv) {
      expect(entry).not.toContain("/review-driven-code");
      expect(entry).not.toContain("file://");
    }
    expect(argv).not.toContain("npx");
    // Pure: no process.env mutation from formatting.
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadGitKey);
  });

  it("formats the executable display command without offering a bare invocation", () => {
    const command = formatExactUpgradeApprovalCommand(TARGET_106.spec);
    expect(command).toBe(`NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${TARGET_106.spec} -- aria upgrade --yes`);
    expect(command).toContain(`--package ${TARGET_106.spec} -- aria upgrade --yes`);
    // The display form is the exact-package invocation with the approved
    // per-invocation process-local Git allowance, not a bare PATH lookup.
    expect(command.startsWith("NPM_CONFIG_ALLOW_GIT=all npm exec")).toBe(true);
  });
});

describe("T003 guidance (check + blocked-approval) names the installed exact package", () => {
  function checkResult(currentVersion: string | null, target: AriaAvailableTarget) {
    return {
      currentVersion,
      available: { kind: "known", target } as const,
      selfUpgradeBlocked: false,
      blockReason: null,
      components: [],
    };
  }

  it("formats the check line with the installed exact spec and the inventoried target", () => {
    const text = formatUpgradeCheck({
      ...checkResult("1.0.6", TARGET_107),
      components: [{ component: "aria", installed: "1.0.6", available: "v1.0.7", status: "upgrade-available", detail: "x" }],
    } as never);
    expect(text).toContain(`npm exec --yes --package ${TARGET_106.spec} -- aria upgrade --yes`);
    expect(text).toContain(TARGET_107.spec);
    // Bare recommendation removed: the old standalone guidance is gone.
    expect(text).not.toContain("run `aria upgrade --yes`");
  });

  it("withholds guidance fail-closed when identity is not exact (no bare fallback)", () => {
    const text = formatApprovalGuidance(null, TARGET_107.spec);
    expect(text).toContain("withheld");
    expect(text).not.toContain("run `aria upgrade --yes`");
    const detail = formatBlockedApprovalDetail("0.0.0-dev", TARGET_107.spec);
    expect(detail).toContain("not positively identified");
    expect(detail).not.toContain("run `aria upgrade --yes`");
  });

  it("blocks approval with the exact invocation and only read-only probes", async () => {
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") return { stdout: "aaa\trefs/tags/v1.0.7\n", stderr: "" };
      if (command === "opencode") return { stdout: "No plugins found", stderr: "" };
      if (command === "engram") throw new Error("engram not found");
      if (command === "codegraph") throw new Error("codegraph not found");
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    const result = await runUpgrade(executor, { currentVersion: "1.0.6", approval: { yes: false } });
    expect(result.stage).toBe("blocked-approval");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`npm exec --yes --package ${TARGET_106.spec} -- aria upgrade --yes`);
    expect(result.detail).not.toContain("run `aria upgrade --yes`");
    // Read-only: no remove/add/exec mutation merely by checking/guidance.
    for (const call of calls) {
      expect(call).not.toContain("plugin remove");
      expect(call).not.toContain("plugin add");
      expect(call.startsWith("npm exec")).toBe(false);
    }
  });
});

describe("T003 handoff spawn argv (pure boundary contract)", () => {
  it("carries the approved target spec across the -- boundary with the payload last", () => {
    const payload = JSON.stringify({ kind: "aria-upgrade-handoff" });
    const argv = buildHandoffSpawnArgv(TARGET_107, payload);
    expect(argv.slice(0, 7)).toEqual(["exec", "--yes", "--package", TARGET_107.spec, "--", "aria", "upgrade"]);
    expect(argv[argv.length - 2]).toBe("--handoff-json");
    expect(argv[argv.length - 1]).toBe(payload);
    // The aria after -- resolves from --package, not from PATH or a checkout.
    const separator = argv.indexOf("--");
    expect(argv.indexOf("aria")).toBe(separator + 1);
    expect(argv.join(" ")).not.toContain("/review-driven-code");
  });
});

describe("T003 resume guidance after replacement names the installed exact target", () => {
  it("reports the exact resume invocation (never bare) while keeping the verified new registration", async () => {
    const rows: Array<[string, string, string]> = [
      ["aria", "deadbee", TARGET_106.spec],
      ["other", "1.0.0", "npm:other@1.0.0"],
    ];
    const persistedSpecs: string[] = rows.map((row) => row[2]);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[1] === "list") {
        return { stdout: pluginTable(rows), stderr: "" };
      }
      if (command === "opencode" && args[1] === "remove") {
        rows.splice(0, rows.length, ...rows.filter((row) => row[2] !== args[2]));
        const spec = args[2] ?? "";
        for (let i = persistedSpecs.length - 1; i >= 0; i--) if (persistedSpecs[i] === spec) persistedSpecs.splice(i, 1);
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[1] === "add") {
        rows.push(["aria", "deadbee", args[2] ?? ""]);
        persistedSpecs.push(args[2] ?? "");
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "npm") {
        throw Object.assign(new Error("npm exec failed: network unavailable"), { stdout: "", stderr: "npm exec failed" });
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    const { buildUpgradeHandoff } = await import("../src/upgrade.js");
    const before = {
      currentVersion: "1.0.6",
      available: { kind: "known", target: TARGET_107 } as const,
      selfUpgradeBlocked: false,
      blockReason: null,
      components: [],
    } as never;
    const outcome = await selfUpgradeAria(TARGET_107, buildUpgradeHandoff(TARGET_107, before), {
      executor,
      readPersistedPlugins: async () => ({ kind: "ok" as const, path: "fake-persisted-opencode.json", specs: [...persistedSpecs] }),
      delay: async () => {},
    });
    expect(outcome.ok).toBe(false);
    // Replacement verified at the exact approved target; handoff did not start.
    expect(outcome.registration).toContain(`single registration at ${TARGET_107.spec}`);
    expect(rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
    // Resume guidance pins the now-installed exact package (which equals the approved target).
    expect(outcome.detail).toContain(`npm exec --yes --package ${TARGET_107.spec} -- aria upgrade --yes`);
    expect(outcome.detail).not.toContain("Re-run `aria upgrade --yes`");
  });
});

describe("T003 approved --yes path still replaces via the guarded mechanism", () => {
  it("takes the handoff for the positively identified registration with no post-handoff work in the old release", async () => {
    const rows: Array<[string, string, string]> = [
      ["aria", "deadbee", TARGET_106.spec],
      ["other", "1.0.0", "npm:other@1.0.0"],
    ];
    const persistedSpecs: string[] = rows.map((row) => row[2]);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") return { stdout: "aaa\trefs/tags/v1.0.6\nbbb\trefs/tags/v1.0.7\n", stderr: "" };
      if (command === "opencode" && args[1] === "list") return { stdout: pluginTable(rows), stderr: "" };
      if (command === "opencode" && args[1] === "remove") {
        rows.splice(0, rows.length, ...rows.filter((row) => row[2] !== args[2]));
        const spec = args[2] ?? "";
        for (let i = persistedSpecs.length - 1; i >= 0; i--) if (persistedSpecs[i] === spec) persistedSpecs.splice(i, 1);
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[1] === "add") {
        rows.push(["aria", "deadbee", args[2] ?? ""]);
        persistedSpecs.push(args[2] ?? "");
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers", stderr: "" };
      if (command === "engram") throw new Error("engram not found");
      if (command === "codegraph") throw new Error("codegraph not found");
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    const result = await runUpgrade(executor, {
      currentVersion: "1.0.6",
      approval: { yes: true },
      selfUpgradeFn: (target, handoff) => selfUpgradeAria(target, handoff, {
        executor,
        readPersistedPlugins: async () => ({ kind: "ok" as const, path: "fake-persisted-opencode.json", specs: [...persistedSpecs] }),
        delay: async () => {},
        handoffSpawn: async (next, nextTarget) => ({ ok: true, detail: "stub taken", stdout: `done ${nextTarget.tag}` }),
      }),
    });
    expect(result.stage).toBe("handoff-taken");
    expect(result.ok).toBe(true);
    expect(result.handoff?.target.spec).toBe(TARGET_107.spec);
    expect(rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
    expect("outcomes" in result).toBe(false);
  });
});

describe("T003 dispatcher needs no launcher; git env stays process-local", () => {
  it("records the bin/aria.mjs relative-dispatch analysis", () => {
    const launcher = readFileSync(new URL("../bin/aria.mjs", import.meta.url), "utf8");
    // The dispatcher imports its own release relative to its location, so
    // npm --package selection is sufficient and no launcher file exists.
    expect(launcher).toContain('await import("../dist/upgrade.js")');
    expect(launcher).toContain('await import("../dist/aria-upgrade.js")');
    expect(launcher).not.toContain("aria-upgrade-launcher");
  });

  it("keeps only the process-local git allowlist (no global env or .npmrc)", () => {
    expect(PROCESS_LOCAL_GIT_ENV).toEqual({ NPM_CONFIG_ALLOW_GIT: "all" });
    const upgradeSrc = readFileSync(new URL("../src/upgrade.ts", import.meta.url), "utf8");
    const adapterSrc = readFileSync(new URL("../src/aria-upgrade.ts", import.meta.url), "utf8");
    for (const src of [upgradeSrc, adapterSrc]) {
      expect(src).not.toMatch(/process\.env\s*\[/);
      expect(src).not.toMatch(/process\.env\.\w+\s*=/);
      // No .npmrc file is written or configured (the one invariant comment
      // documenting "no `.npmrc`" is the only allowed mention).
      expect(src).not.toMatch(/writeFile[^;]*npmrc/i);
      expect(src).not.toMatch(/NPM_CONFIG_STORE/i);
    }
    // Pure formatting never touches the process environment.
    const hadKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    formatExactUpgradeApprovalCommand(TARGET_106.spec);
    formatApprovalGuidance("1.0.6", TARGET_107.spec);
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadKey);
  });
});

describe("T003 migrate-from (newer-CLI-owned immutable-sender escape)", () => {
  const TO_110: AriaAvailableTarget = { tag: "v1.0.10", version: "1.0.10", spec: "github:mscipio/ARIA#v1.0.10" };
  const LS_REMOTE_107_110 = ["aaa111\trefs/tags/v1.0.7", "bbb222\trefs/tags/v1.0.10", ""].join("\n");
  const MIGRATE_UNRELATED: Array<[string, string, string]> = [["other", "1.0.0", "npm:other@1.0.0"]];

  interface MigrateWorld {
    rows: Array<[string, string, string]>;
    persistedSpecs: string[];
    calls: string[];
  }

  function makeMigrateWorld(initial: Array<[string, string, string]>): { world: MigrateWorld; executor: Executor } {
    const world: MigrateWorld = { rows: [...initial], persistedSpecs: initial.map((row) => row[2]), calls: [] };
    const executor: Executor = async (command, args) => {
      world.calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") return { stdout: LS_REMOTE_107_110, stderr: "" };
      if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
        return { stdout: world.rows.length === 0 ? "No plugins found" : pluginTable(world.rows), stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "remove") {
        const spec = args[2] ?? "";
        world.rows.splice(0, world.rows.length, ...world.rows.filter((row) => row[2] !== spec));
        for (let i = world.persistedSpecs.length - 1; i >= 0; i--) {
          if (world.persistedSpecs[i] === spec) world.persistedSpecs.splice(i, 1);
        }
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
        world.rows.push(["aria", "deadbee", args[2] ?? ""]);
        world.persistedSpecs.push(args[2] ?? "");
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers", stderr: "" };
      if (command === "engram") throw new Error("engram not found");
      if (command === "codegraph") throw new Error("codegraph not found");
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    };
    return { world, executor };
  }

  function expectZeroMutation(calls: string[]): void {
    for (const call of calls) {
      expect(call).not.toContain("plugin remove");
      expect(call).not.toContain("plugin add");
      expect(call.startsWith("npm exec")).toBe(false);
    }
  }

  it("validates --migrate-from specs and derives the own target from the packaged version (never the installed row)", () => {
    expect(parseMigrateFromSpec(TARGET_107.spec)).toEqual({ ok: true });
    for (const bad of ["", "aria", "v1.0.7", "github:evil/ARIA#v1.0.7", "github:mscipio/ARIA#main", "github:mscipio/ARIA#latest", "github:mscipio/ARIA#67639df", "github:mscipio/ARIA#v1.0"]) {
      expect(parseMigrateFromSpec(bad).ok).toBe(false);
    }
    expect(ownReleaseTarget("1.0.10")).toEqual({ ok: true, target: TO_110 });
    expect(ownReleaseTarget(null).ok).toBe(false);
    for (const bad of ["", "0.0.0-dev", "1.0", "v1.0.10", "latest", "67639df"]) {
      expect(ownReleaseTarget(bad).ok).toBe(false);
    }
  });

  it("builds the newer-CLI migrate invocation (--package selects TO, --migrate-from names FROM)", () => {
    const hadGitKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    const argv = buildMigrateApprovalArgv(TARGET_107.spec, TO_110.spec);
    expect(argv).toEqual(["exec", "--yes", "--package", TO_110.spec, "--", "aria", "upgrade", "--migrate-from", TARGET_107.spec, "--yes"]);
    const packageFlag = argv.indexOf("--package");
    const separator = argv.indexOf("--");
    expect(argv[packageFlag + 1]).toBe(TO_110.spec);
    expect(argv.indexOf("aria")).toBe(separator + 1);
    expect(argv.indexOf("--migrate-from")).toBeGreaterThan(separator);
    for (const entry of argv) {
      expect(entry).not.toContain("/review-driven-code");
      expect(entry).not.toContain("file://");
    }
    expect(formatMigrateApprovalCommand(TARGET_107.spec, TO_110.spec)).toBe(
      `NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${TO_110.spec} -- aria upgrade --migrate-from ${TARGET_107.spec} --yes`,
    );
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadGitKey);
  });

  it("blocks without --yes using only read-only probes (zero mutation)", async () => {
    const { world, executor } = makeMigrateWorld([["aria", "deadbee", TARGET_107.spec], ...MIGRATE_UNRELATED]);
    const result = await runMigrateUpgrade(executor, { migrateFrom: TARGET_107.spec, ownVersion: "1.0.10", approval: { yes: false } });
    expect(result.stage).toBe("blocked-approval");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("--migrate-from");
    expect(result.detail).toContain(TO_110.spec);
    expectZeroMutation(world.calls);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TARGET_107.spec]);
  });

  it("fails closed on from/installed mismatch with zero mutation", async () => {
    const { world, executor } = makeMigrateWorld([["aria", "deadbee", TARGET_106.spec], ...MIGRATE_UNRELATED]);
    const before = world.rows.map((row) => row[2]);
    const result = await runMigrateUpgrade(executor, { migrateFrom: TARGET_107.spec, ownVersion: "1.0.10", approval: { yes: true } });
    expect(result.stage).toBe("blocked-migrate");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("migrate-from mismatch");
    expectZeroMutation(world.calls);
    expect(world.rows.map((row) => row[2])).toEqual(before);
    expect(world.persistedSpecs).toEqual(before);
  });

  it("fails closed on a foreign installed registration with zero mutation", async () => {
    const { world, executor } = makeMigrateWorld([["aria", "local", "/some/checkout"], ...MIGRATE_UNRELATED]);
    const result = await runMigrateUpgrade(executor, { migrateFrom: TARGET_107.spec, ownVersion: "1.0.10", approval: { yes: true } });
    expect(result.stage).toBe("blocked-migrate");
    expect(result.ok).toBe(false);
    expectZeroMutation(world.calls);
    expect(world.rows.map((row) => row[2])).toContain("/some/checkout");
  });

  it("performs the newer-CLI-owned v1.0.7 to v1.0.10 transition and continues the pipeline in-process (no old-release spawn)", async () => {
    const { world, executor } = makeMigrateWorld([["aria", "deadbee", TARGET_107.spec], ...MIGRATE_UNRELATED]);
    const result = await runMigrateUpgrade(executor, {
      migrateFrom: TARGET_107.spec,
      ownVersion: "1.0.10",
      approval: { yes: true },
      migrateFn: (fromSpec, target, handoff) => migrateAriaFromExact(fromSpec, target, handoff, {
        executor,
        readPersistedPlugins: async () => ({ kind: "ok" as const, path: "fake-persisted-opencode.json", specs: [...world.persistedSpecs] }),
        delay: async () => {},
      }),
      continuation: {
        components: {
          engram: async () => ({ component: "engram", status: "completed", detail: "stubbed", mutated: true }),
          context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
          codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
          zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
          quota: async () => ({ component: "quota", status: "skipped", detail: "stubbed", mutated: false }),
        },
        normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
        regenFn: async () => ({ ok: true, detail: "no regen required", mutated: false }),
        depsSyncFn: async () => ({ ok: true, detail: "synced", mutated: false }),
        doctorFn: async () => ({ ok: true, detail: "healthy", mutated: false }),
      },
    });
    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    // The (to) target came from the packaged own version, not the installed row.
    expect(result.ownTarget?.spec).toBe(TO_110.spec);
    expect(result.detail).toContain(`Migrate ${TARGET_107.spec} → ${TO_110.spec}`);
    // Exactly one ARIA registration at the new target; unrelated preserved.
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([TO_110.spec]);
    expect(world.rows).toContainEqual(["other", "1.0.0", "npm:other@1.0.0"]);
    expect(world.persistedSpecs).toEqual(["npm:other@1.0.0", TO_110.spec]);
    // In-process continuation: no npm spawn of any release (old or new).
    expect(world.calls.some((call) => call.startsWith("npm exec"))).toBe(false);
    expect(result.report).toContain("Before:");
    expect(result.report).toContain("After:");
  });

  it("wires --migrate-from through the relative dispatcher (never bare aria)", () => {
    const launcher = readFileSync(new URL("../bin/aria.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("--migrate-from");
    expect(launcher).toContain("runMigrateUpgrade");
    expect(launcher).toContain("migrateAriaFromExact");
    expect(launcher).toContain('await import("../dist/upgrade.js")');
    expect(launcher).toContain('await import("../dist/aria-upgrade.js")');
  });
});
