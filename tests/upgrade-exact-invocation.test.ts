import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Executor } from "../src/deps.js";
import { buildHandoffSpawnArgv, migrateAriaFromExact, selfUpgradeAria } from "../src/aria-upgrade.js";
import { createUniqueScratchDir } from "../src/scratch.js";
import {
  ARIA_GIT_REMOTE,
  ARIA_GIT_SPEC_PREFIX,
  PROCESS_LOCAL_GIT_ENV,
  buildExactUpgradeApprovalArgv,
  buildMigrateApprovalArgv,
  buildUpgradeHandoff,
  checkUpgradeInventory,
  compareAriaVersions,
  discoverAriaTargetByExactSpec,
  discoverAriaTargetByExactTag,
  formatApprovalGuidance,
  formatBlockedApprovalDetail,
  formatExactUpgradeApprovalCommand,
  formatMigrateApprovalCommand,
  formatUpgradeCheck,
  installedSpecForGuidance,
  ownReleaseTarget,
  parseMigrateFromSpec,
  parseAriaRemoteRefs,
  runMigrateUpgrade,
  runUpgrade,
  verifyAriaTargetIdentity,
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
const RC5_FROM = `${ARIA_GIT_SPEC_PREFIX}v1.3.4-rc.5`;
const RC6_TAG_OBJECT = "bba467c2c97eb99a416cf7e4fac1949c4d549a90";
const RC6_COMMIT = "72459c95783201f222c2f56052d3c9ded3934cc2";
const RC7_COMMIT = "cccccccccccccccccccccccccccccccccccccccc";
const STABLE_COMMIT = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RC6_TARGET: AriaAvailableTarget = {
  tag: "v1.3.4-rc.6",
  version: "1.3.4-rc.6",
  spec: `${ARIA_GIT_SPEC_PREFIX}${RC6_COMMIT}`,
};
const BOOTSTRAP_RC7_SPEC = `${ARIA_GIT_SPEC_PREFIX}${RC7_COMMIT}`;
const RC_REMOTE = [
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.3.4-rc.5`,
  `${RC6_TAG_OBJECT}\trefs/tags/v1.3.4-rc.6`,
  `${RC6_COMMIT}\trefs/tags/v1.3.4-rc.6^{}`,
  `${RC7_COMMIT}\trefs/tags/v1.3.4-rc.7`,
  `${STABLE_COMMIT}\trefs/tags/v1.3.4`,
  "",
].join("\n");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchFixtures: string[] = [];

function pluginTable(rows: Array<[string, string, string]>): string {
  return ["ID  VERSION  SOURCE", ...rows.map(([id, version, source]) => `${id}  ${version}  ${source}`)].join("\n");
}

afterEach(async () => {
  await Promise.all(scratchFixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function targetHandoffFixture(): Promise<string> {
  const allocated = process.env.RDC_TEST_FIXTURE_DIR;
  const directory = allocated
    ? await mkdtemp(join(allocated, "target-owned-rc6-"))
    : await createUniqueScratchDir(REPO_ROOT, "tests/fixtures", "target-owned-rc6-handoff");
  scratchFixtures.push(directory);
  return directory;
}

async function extractRc6Package(globalRoot: string): Promise<void> {
  const packageRoot = join(globalRoot, "aria");
  await mkdir(packageRoot, { recursive: true });
  const archive = execFileSync("git", ["archive", "--format=tar", RC6_COMMIT], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", packageRoot], { input: archive });
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  expect(metadata).toEqual(expect.objectContaining({ name: "aria", version: RC6_TARGET.version }));
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
    // Fake globally installed bare CLI version (moves on `npm install -g`).
    let cliVersion = "1.0.6";
    const executor: Executor = async (command, args) => {
      // R006 convergence probe (read-only verification, never a mutation).
      if (command === "aria" && args[0] === "--version") {
        return { stdout: cliVersion, stderr: "" };
      }
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
      if (command === "npm" && args[0] === "install") {
        // R003 bounded installed-CLI update runs before replacement.
        const match = (args[2] ?? "").match(/#v(\d+\.\d+\.\d+)\s*$/);
        if (match) cliVersion = match[1] as string;
        return { stdout: "installed", stderr: "" };
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
    // Fake globally installed bare CLI version (moves on `npm install -g`).
    let cliVersion = "1.0.6";
    const executor: Executor = async (command, args) => {
      // R006 convergence probe (read-only verification, never a mutation).
      if (command === "aria" && args[0] === "--version") {
        return { stdout: cliVersion, stderr: "" };
      }
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
      if (command === "npm" && args[0] === "install") {
        // R003 bounded installed-CLI update runs before replacement.
        const match = (args[2] ?? "").match(/#v(\d+\.\d+\.\d+)\s*$/);
        if (match) cliVersion = match[1] as string;
        return { stdout: "installed", stderr: "" };
      }
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
    handoffs: Array<{ packageSpec: string; targetSpec: string }>;
    globalRoot?: string;
    persistedConfigPath?: string;
  }

  function makeMigrateWorld(
    initial: Array<[string, string, string]>,
    remoteRefs = LS_REMOTE_107_110,
    options: { globalRoot?: string; persistedConfigPath?: string; initialCliVersion?: string } = {},
  ): { world: MigrateWorld; executor: Executor } {
    const { initialCliVersion, ...worldOptions } = options;
    const world: MigrateWorld = {
      rows: [...initial],
      persistedSpecs: initial.map((row) => row[2]),
      calls: [],
      handoffs: [],
      ...worldOptions,
    };
    // Fake globally installed bare CLI version (moves on `npm install -g`).
    let cliVersion = initialCliVersion ?? "1.0.7";
    const persistPlugins = async () => {
      if (!world.persistedConfigPath) return;
      const config = JSON.parse(await readFile(world.persistedConfigPath, "utf8")) as Record<string, unknown>;
      config.plugins = [...world.persistedSpecs];
      await writeFile(world.persistedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    };
    const executor: Executor = async (command, args) => {
      // R006 convergence probe (read-only verification, never a mutation).
      if (command === "aria" && args[0] === "--version") {
        return { stdout: cliVersion, stderr: "" };
      }
      world.calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") return { stdout: remoteRefs, stderr: "" };
      if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
        return { stdout: world.rows.length === 0 ? "No plugins found" : pluginTable(world.rows), stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "remove") {
        const spec = args[2] ?? "";
        world.rows.splice(0, world.rows.length, ...world.rows.filter((row) => row[2] !== spec));
        for (let i = world.persistedSpecs.length - 1; i >= 0; i--) {
          if (world.persistedSpecs[i] === spec) world.persistedSpecs.splice(i, 1);
        }
        await persistPlugins();
        return { stdout: "plugin removed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
        world.rows.push(["aria", "deadbee", args[2] ?? ""]);
        world.persistedSpecs.push(args[2] ?? "");
        await persistPlugins();
        return { stdout: "plugin installed", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") return { stdout: "MCP Servers", stderr: "" };
      if (command === "npm" && args[0] === "root" && args[1] === "-g") {
        if (!world.globalRoot) throw new Error("isolated global package root not configured");
        return { stdout: world.globalRoot, stderr: "" };
      }
      if (command === "npm" && args[0] === "install") {
        // R003 bounded installed-CLI update runs before replacement.
        const spec = args[2] ?? "";
        const tagMatch = spec.match(/#v(\d+\.\d+\.\d+(?:-rc\.\d+)?)\s*$/);
        if (tagMatch) cliVersion = tagMatch[1] as string;
        else {
          const commit = spec.slice(spec.lastIndexOf("#") + 1);
          const resolved = remoteRefs.split("\n").map((line) => line.trim().split(/\s+/, 2)).find(([hash, ref]) =>
            hash?.toLowerCase() === commit.toLowerCase() && ref?.startsWith("refs/tags/v"),
          );
          if (resolved?.[1]) cliVersion = resolved[1].slice("refs/tags/".length).replace(/\^\{\}$/, "").slice(1);
        }
        return { stdout: "installed", stderr: "" };
      }
      if (command === "npm" && args[0] === "exec") {
        const packageSpec = args[args.indexOf("--package") + 1] ?? "";
        const payload = args[args.indexOf("--handoff-json") + 1] ?? "{}";
        const parsedHandoff = JSON.parse(payload) as { target?: { spec?: string } };
        world.handoffs.push({ packageSpec, targetSpec: parsedHandoff.target?.spec ?? "" });
        const ref = packageSpec.slice(packageSpec.lastIndexOf("#") + 1);
        const installedTag = ref.startsWith("v")
          ? ref
          : remoteRefs.split("\n").map((line) => line.trim().split(/\s+/, 2)).find(([hash]) => hash === ref)?.[1]
            ?.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "") ?? "unknown";
        return { stdout: `Upgrade: complete\nTarget continuation ${installedTag}\nBefore:\nAfter:\n`, stderr: "" };
      }
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
    expect(parseMigrateFromSpec(RC5_FROM)).toEqual({ ok: true });
    expect(ownReleaseTarget("1.3.4-rc.7")).toEqual({
      ok: true,
      target: { tag: "v1.3.4-rc.7", version: "1.3.4-rc.7", spec: `${ARIA_GIT_SPEC_PREFIX}v1.3.4-rc.7` },
    });
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

  it("keeps default discovery stable-only while comparing exact rc versions correctly", () => {
    const stable = parseAriaRemoteRefs([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.3.4-rc.99",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1.3.3",
      "",
    ].join("\n"));
    expect(stable?.tag).toBe("v1.3.3");
    expect(compareAriaVersions("1.3.4-rc.6", "1.3.4")).toBeLessThan(0);
    expect(compareAriaVersions("1.3.4-rc.7", "1.3.4-rc.6")).toBeGreaterThan(0);
  });

  it("resolves only an exact ARIA prerelease commit spec to its matching release tag", async () => {
    const executor: Executor = async (command) => {
      expect(command).toBe("git");
      return { stdout: RC_REMOTE, stderr: "" };
    };
    expect(await discoverAriaTargetByExactSpec(RC6_TARGET.spec, executor, true)).toEqual({ kind: "known", target: RC6_TARGET });
    for (const invalid of [
      `github:evil/ARIA#${RC6_COMMIT}`,
      `${ARIA_GIT_SPEC_PREFIX}v1.3.4-rc.6`,
      `${ARIA_GIT_SPEC_PREFIX}${RC6_COMMIT.slice(0, 8)}`,
      `${ARIA_GIT_SPEC_PREFIX}${"d".repeat(40)}`,
      `${ARIA_GIT_SPEC_PREFIX}${STABLE_COMMIT}`,
    ]) {
      expect((await discoverAriaTargetByExactSpec(invalid, executor, true)).kind).toBe("unknown");
    }
  });

  it("binds an annotated rc tag to its peeled commit during discovery and verification", async () => {
    const calls: string[][] = [];
    const executor: Executor = async (command, args) => {
      expect(command).toBe("git");
      calls.push(args);
      return { stdout: RC_REMOTE, stderr: "" };
    };
    const ref = "refs/tags/v1.3.4-rc.6";
    expect(await discoverAriaTargetByExactTag(RC6_TARGET.tag, executor)).toEqual({ kind: "known", target: RC6_TARGET });
    expect(await verifyAriaTargetIdentity(RC6_TARGET, executor)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["ls-remote", "--tags", ARIA_GIT_REMOTE, ref, ref.concat("^{}")],
      ["ls-remote", "--tags", ARIA_GIT_REMOTE, ref, ref.concat("^{}")],
    ]);
  });

  it("continues rc5→rc6 through the verified installed rc6 artifacts and preserves persisted config", async () => {
    const fixture = await targetHandoffFixture();
    const globalRoot = join(fixture, "global", "node_modules");
    await extractRc6Package(globalRoot);
    const configDir = join(fixture, "opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "opencode.json");
    const unrelatedConfig = { preserved: { key: "value" }, plugins: [RC5_FROM, "npm:other@1.0.0"], skills: ["user-skill"] };
    await writeFile(configPath, `${JSON.stringify(unrelatedConfig, null, 2)}\n`);

    const { world, executor } = makeMigrateWorld(
      [["aria", "1.3.4-rc.5", RC5_FROM], ...MIGRATE_UNRELATED],
      RC_REMOTE,
      { globalRoot, persistedConfigPath: configPath, initialCliVersion: "1.3.4-rc.5" },
    );
    const before = await checkUpgradeInventory(executor, { availableOverride: RC6_TARGET, configDir });
    const handoff = buildUpgradeHandoff(RC6_TARGET, before);
    const result = await migrateAriaFromExact(RC5_FROM, RC6_TARGET, handoff, {
      executor,
      globalConfigPath: configPath,
      delay: async () => {},
      continuationOptions: {
        configDir,
        // The artifact smoke isolates target-owned normalization/regen; the
        // real doctor is read-only but unrelated to generated-content proof.
        doctorFn: async () => ({ ok: true, detail: "isolated target-artifact smoke", mutated: false }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.handoffOutput).toContain("Target continuation v1.3.4-rc.6");
    expect(result.handoffOutput).toContain("Upgrade: complete");
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([RC6_TARGET.spec]);
    expect(world.rows.filter((row) => row[0] !== "aria")).toEqual(MIGRATE_UNRELATED);
    expect(world.persistedSpecs).toEqual(["npm:other@1.0.0", RC6_TARGET.spec]);
    expect(world.calls).toContain(`npm install -g ${RC6_TARGET.spec}`);
    expect(world.calls).toContain("npm root -g");
    expect(world.calls.some((call) => call.includes("--handoff-json"))).toBe(false);

    const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as typeof unrelatedConfig;
    expect(finalConfig.plugins).toEqual(["npm:other@1.0.0", RC6_TARGET.spec]);
    expect(finalConfig.preserved).toEqual(unrelatedConfig.preserved);
    expect(finalConfig.skills).toContain("user-skill");
    expect(finalConfig.skills).toContain(join(globalRoot, "aria", "skills"));

    const agentsDir = join(configDir, "agents");
    const commandsDir = join(configDir, "commands");
    const coder = await readFile(join(agentsDir, "coder.md"), "utf8");
    expect(coder).toContain(`# aria-version: ${RC6_TARGET.version}`);
    expect(coder).toContain("# aria-checksum:");
    const commandNames = await readdir(commandsDir);
    expect(commandNames).toHaveLength(2);
    for (const name of commandNames) {
      expect(await readFile(join(commandsDir, name), "utf8")).toContain(`# aria-version: ${RC6_TARGET.version}`);
    }
  });

  it("runs strict rc6 all-role conflict preflight through the target continuation without partial agent writes", async () => {
    const fixture = await targetHandoffFixture();
    const globalRoot = join(fixture, "global", "node_modules");
    await extractRc6Package(globalRoot);
    const configDir = join(fixture, "opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "opencode.json");
    await writeFile(configPath, `${JSON.stringify({ plugins: [RC5_FROM, "npm:other@1.0.0"], skills: ["user-skill"] }, null, 2)}\n`);
    const agentsDir = join(configDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    const conflictPath = join(agentsDir, "architect.md");
    const userContent = "user-owned architect file; target reconciliation must not replace it\n";
    await writeFile(conflictPath, userContent);

    const { world, executor } = makeMigrateWorld(
      [["aria", "1.3.4-rc.5", RC5_FROM], ...MIGRATE_UNRELATED],
      RC_REMOTE,
      { globalRoot, persistedConfigPath: configPath, initialCliVersion: "1.3.4-rc.5" },
    );
    const before = await checkUpgradeInventory(executor, { availableOverride: RC6_TARGET, configDir });
    const result = await migrateAriaFromExact(RC5_FROM, RC6_TARGET, buildUpgradeHandoff(RC6_TARGET, before), {
      executor,
      globalConfigPath: configPath,
      delay: async () => {},
      continuationOptions: {
        configDir,
        doctorFn: async () => ({ ok: true, detail: "must not run after regen conflict", mutated: false }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Target-owned continuation started and stopped at phase-stopped");
    expect(result.handoffOutput).toContain("unowned —");
    expect(await readdir(agentsDir)).toEqual(["architect.md"]);
    expect(await readFile(conflictPath, "utf8")).toBe(userContent);
    await expect(readdir(join(configDir, "commands"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(world.persistedSpecs).toEqual(["npm:other@1.0.0", RC6_TARGET.spec]);
    expect(world.calls.some((call) => call.includes("--handoff-json"))).toBe(false);
  });

  it("prints an immutable rc7 npm-exec bootstrap and exact rc6 target without mutation until approved", async () => {
    const argv = buildMigrateApprovalArgv(RC5_FROM, BOOTSTRAP_RC7_SPEC, RC6_TARGET.spec);
    expect(argv).toEqual([
      "exec", "--yes", "--package", BOOTSTRAP_RC7_SPEC, "--", "aria", "upgrade",
      "--migrate-from", RC5_FROM, "--target-spec", RC6_TARGET.spec, "--yes",
    ]);

    const { world, executor } = makeMigrateWorld([["aria", "1.3.4-rc.5", RC5_FROM], ...MIGRATE_UNRELATED], RC_REMOTE);
    const result = await runMigrateUpgrade(executor, {
      migrateFrom: RC5_FROM,
      targetSpec: RC6_TARGET.spec,
      ownVersion: "1.3.4-rc.7",
      approval: { yes: false },
    });
    expect(result.stage).toBe("blocked-approval");
    expect(result.detail).toContain(`npm exec --yes --package ${BOOTSTRAP_RC7_SPEC} -- aria upgrade --migrate-from ${RC5_FROM} --target-spec ${RC6_TARGET.spec} --yes`);
    expectZeroMutation(world.calls);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([RC5_FROM]);
    expect(world.persistedSpecs).toEqual([RC5_FROM, "npm:other@1.0.0"]);
  });

  it("routes the approved rc5 migration to the exact rc6 target selected by the bootstrap", async () => {
    const { world, executor } = makeMigrateWorld([["aria", "1.3.4-rc.5", RC5_FROM], ...MIGRATE_UNRELATED], RC_REMOTE);
    const result = await runMigrateUpgrade(executor, {
      migrateFrom: RC5_FROM,
      targetSpec: RC6_TARGET.spec,
      ownVersion: "1.3.4-rc.7",
      approval: { yes: true },
      migrateFn: async (fromSpec, target, handoff) => {
        expect(fromSpec).toBe(RC5_FROM);
        expect(target).toEqual(RC6_TARGET);
        expect(handoff.target).toEqual(RC6_TARGET);
        return { ok: true, detail: "approved exact target dispatched" };
      },
    });
    expect(result.stage).toBe("complete");
    expect(result.ownTarget).toEqual(RC6_TARGET);
    expect(result.handoff?.target).toEqual(RC6_TARGET);
    expect(world.rows.filter((row) => row[0] === "aria").map((row) => row[2])).toEqual([RC5_FROM]);
    expect(world.persistedSpecs).toEqual([RC5_FROM, "npm:other@1.0.0"]);
    expect(result.detail).toContain(`Migrate ${RC5_FROM} → ${RC6_TARGET.spec}`);
    expect(result.continuation).toBeUndefined();
  });

  it("rejects wrong repo, non-commit refs, tag/commit mismatch, and newer-than-bootstrap targets with zero mutation", async () => {
    const invalidTargets = [
      `github:evil/ARIA#${RC6_COMMIT}`,
      `${ARIA_GIT_SPEC_PREFIX}v1.3.4-rc.6`,
      `${ARIA_GIT_SPEC_PREFIX}${"d".repeat(40)}`,
      BOOTSTRAP_RC7_SPEC,
      `${ARIA_GIT_SPEC_PREFIX}${STABLE_COMMIT}`,
    ];
    for (const targetSpec of invalidTargets) {
      const { world, executor } = makeMigrateWorld([["aria", "1.3.4-rc.5", RC5_FROM], ...MIGRATE_UNRELATED], RC_REMOTE);
      const beforeRows = world.rows.map((row) => [...row]);
      const beforePersisted = [...world.persistedSpecs];
      const result = await runMigrateUpgrade(executor, {
        migrateFrom: RC5_FROM,
        targetSpec,
        ownVersion: "1.3.4-rc.7",
        approval: { yes: true },
      });
      expect(result.ok).toBe(false);
      expectZeroMutation(world.calls);
      expect(world.rows).toEqual(beforeRows);
      expect(world.persistedSpecs).toEqual(beforePersisted);
    }
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

  it("performs the newer-CLI-owned v1.0.7 to v1.0.10 transition then delegates continuation to the target package", async () => {
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
    // The migration bootstrap never runs target-owned post-handoff work.
    expect(world.calls.some((call) => call.startsWith(`npm exec --yes --package ${TO_110.spec} -- aria upgrade --handoff-json`))).toBe(true);
    expect(world.handoffs).toEqual([{ packageSpec: TO_110.spec, targetSpec: TO_110.spec }]);
    expect(result.continuation).toBeUndefined();
    expect(result.report).toContain("Target continuation v1.0.10");
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
