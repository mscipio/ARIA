import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Executor } from "../src/deps.js";
import { setup } from "../src/lifecycle.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

/**
 * T003 setup same-release identity: an exact same-release GitHub
 * registration (`github:mscipio/ARIA#vX.Y.Z` with `X.Y.Z` equal to the
 * running CLI version) is the same release as the running install, so
 * setup continues idempotently; a genuinely conflicting release/source
 * still refuses before any mutation. ARIA-owned state (stale packaged
 * skills path) reconciles, complete-current stays a no-op, and present
 * dependencies are never version-chased (install-if-missing only).
 *
 * Isolation: every `setup()` call names explicit temp
 * `files:{globalConfigPath,agentsDir,skillsRoot}` plus a temp worktree, so
 * no caller-global or live v1.1.0 state is touched. The executor only
 * answers `opencode plugin list` (any version-chasing `npm`/`brew` call
 * throws), proving no upgrade path runs on setup.
 */

const tempDirs: string[] = [];

// T002 deterministic version fixture: the same-release identity path reads
// the running CLI version internally, so the package-version read is pinned
// to an explicit simulated release (cross-module importers observe the
// mock). No behavioral result branches on the checkout's release version:
// the running/same specs are fixed fixtures and every conflicting spec is a
// fixed different release.
const { RUNNING_VERSION, SAME_SPEC, CONFLICTING_RELEASE_SPEC } = vi.hoisted(() => ({
  RUNNING_VERSION: "9.9.9",
  SAME_SPEC: "github:mscipio/ARIA#v9.9.9",
  CONFLICTING_RELEASE_SPEC: "github:mscipio/ARIA#v1.0.7",
}));

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return { ...actual, readPackageVersion: () => RUNNING_VERSION };
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeFixtureCheckout(): Promise<string> {
  const root = await tempDir("aria-t003-checkout-");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
  return root;
}

function binaryUrl(checkout: string): string {
  return pathToFileURL(resolve(checkout, "bin", "aria.mjs")).href;
}

type Call = { command: string; args: string[]; options?: { cwd?: string } };

function collectingExecutor(responses: Record<string, { stdout?: string; stderr?: string; error?: string }>): {
  executor: Executor;
  calls: Call[];
} {
  const calls: Call[] = [];
  const executor: Executor = async (command, args, options) => {
    calls.push({ command, args, options });
    const response = responses[`${command} ${args.join(" ")}`];
    if (!response) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { executor, calls };
}

async function setupFiles(skillsRoot?: string) {
  const dir = await tempDir("aria-t003-files-");
  const files = {
    globalConfigPath: join(dir, "opencode.json"),
    agentsDir: join(dir, "agents"),
    skillsRoot: skillsRoot ?? join(dir, "skills"),
  };
  assertNotCallerGlobalPath(files.globalConfigPath, "setup files.globalConfigPath");
  assertNotCallerGlobalPath(files.agentsDir, "setup files.agentsDir");
  return files;
}

function runningSpec(): { version: string; spec: string } {
  return { version: RUNNING_VERSION, spec: SAME_SPEC };
}

function conflictingSpec(): string {
  // A genuinely different release from the simulated running CLI.
  return CONFLICTING_RELEASE_SPEC;
}

/** Install-only mock: present installs stay untouched, never upgraded. */
function installOnlyDependencies(calls: string[]) {
  return async () => {
    calls.push("dependenciesFn");
    return {
      ok: true,
      outcomes: [
        { component: "engram", status: "skipped" as const, detail: "Engram 9.9.9 already installed; setup leaves present installs untouched", mutated: false },
      ],
      report: "present installs untouched (install-if-missing only)",
    };
  };
}

describe("T003 setup same-release identity", () => {
  it("exact same-release Git registration succeeds idempotently with no re-register", async () => {
    const { version: runningVersion, spec: sameSpec } = runningSpec();
    expect(sameSpec.startsWith("github:mscipio/ARIA#v")).toBe(true);
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const worktree = await tempDir("aria-t003-work-");
    const listed = ["ID  VERSION  SOURCE", `aria  842e4ec  ${sameSpec}`].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    const dependencyCalls: string[] = [];

    const first = await setup(binaryUrl(checkout), executor, undefined, {
      worktree,
      files,
      dependenciesFn: installOnlyDependencies(dependencyCalls),
    });

    expect(first.ok).toBe(true);
    expect(first.stage).toBe("complete");
    expect(first.setup!.registration.action).toBe("already registered");
    // No version-chasing mutation: only the read-only list probe ran.
    expect(calls.filter((call) => call.args.includes("add")).length).toBe(0);
    expect(calls.filter((call) => call.args.includes("remove")).length).toBe(0);
    expect(calls.every((call) => call.command === "opencode" && call.args[0] === "plugin" && call.args[1] === "list")).toBe(true);
    // Install-only dependencies: present stays skipped, never upgraded.
    expect(dependencyCalls).toEqual(["dependenciesFn"]);
    expect(first.setup!.dependencies!.ok).toBe(true);
    expect(first.setup!.dependencies!.outcomes.every((outcome) => outcome.mutated === false)).toBe(true);
    // Exactly-once Git identity preserved (no second local entry appended).
    const written = JSON.parse(await readFile(files.globalConfigPath, "utf8")) as { plugins?: unknown };
    expect(written.plugins).toEqual([sameSpec]);

    // Idempotent second run: same registration still matches, no add.
    const secondList = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    const secondDependencyCalls: string[] = [];
    const second = await setup(binaryUrl(checkout), secondList.executor, undefined, {
      worktree,
      files,
      dependenciesFn: installOnlyDependencies(secondDependencyCalls),
    });
    expect(second.ok).toBe(true);
    expect(second.setup!.registration.action).toBe("already registered");
    expect(secondList.calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(secondDependencyCalls).toEqual(["dependenciesFn"]);
    expect(runningVersion.length).toBeGreaterThan(0);
  });

  it("conflicting release/source refuses before any mutation", async () => {
    const { version: runningVersion, spec: sameSpec } = runningSpec();
    const checkout = await makeFixtureCheckout();
    const worktree = await tempDir("aria-t003-work-");
    // Two conflicting shapes: a different approved release tag, and the same
    // tag from a foreign (unapproved) source. Both must refuse.
    const cases = [
      ["different release", ["ID  VERSION  SOURCE", `aria  842e4ec  ${conflictingSpec()}`].join("\n")],
      ["foreign source", ["ID  VERSION  SOURCE", `aria  842e4ec  github:other/ARIA#v${runningVersion}`].join("\n")],
    ] as const;
    expect(sameSpec).not.toBe(conflictingSpec());
    for (const [label, listed] of cases) {
      const files = await setupFiles();
      const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
      let dependenciesCalled = false;
      let syncCalled = false;
      const result = await setup(binaryUrl(checkout), executor, async () => {
        syncCalled = true;
        return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
      }, {
        worktree,
        files,
        dependenciesFn: async () => {
          dependenciesCalled = true;
          return { ok: true, outcomes: [], report: "must not run" };
        },
      });
      expect(result.ok, label).toBe(false);
      expect(result.stage, label).toBe("registration");
      expect(result.setup!.registration.action, label).toBe("failed");
      expect(result.setup!.registration.detail, label).toContain("definite mismatch");
      expect(calls.some((call) => call.args.includes("add")), label).toBe(false);
      expect(calls.some((call) => call.args.includes("remove")), label).toBe(false);
      expect(result.setup?.config, label).toBeUndefined();
      expect(result.setup?.agents, label).toBeUndefined();
      expect(dependenciesCalled, label).toBe(false);
      expect(syncCalled, label).toBe(false);
      await expect(readFile(files.globalConfigPath, "utf8"), label).rejects.toThrow();
    }
  });

  it("same-release with stale ARIA-owned skills path refreshes only the owned entry", async () => {
    const { spec: sameSpec } = runningSpec();
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const worktree = await tempDir("aria-t003-work-");
    const stalePackaged = "/old/npx-cache/node_modules/aria/skills";
    await writeFile(
      files.globalConfigPath,
      JSON.stringify({ custom: "kept", plugins: [sameSpec], skills: ["/user/skills", stalePackaged] }),
    );
    const beforeRaw = await readFile(files.globalConfigPath, "utf8");
    const listed = ["ID  VERSION  SOURCE", `-  842e4ec  ${sameSpec}`].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    const dependencyCalls: string[] = [];

    const result = await setup(binaryUrl(checkout), executor, undefined, {
      worktree,
      files,
      dependenciesFn: installOnlyDependencies(dependencyCalls),
    });

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(dependencyCalls).toEqual(["dependenciesFn"]);
    // Stale packaged entry refreshes in place; unrelated entries/keys survive.
    const written = JSON.parse(await readFile(files.globalConfigPath, "utf8")) as Record<string, unknown>;
    expect(written["custom"]).toBe("kept");
    expect(written["skills"]).toEqual(["/user/skills", files.skillsRoot]);
    // Exactly-once Git identity: no local duplicate appended.
    expect(written["plugins"]).toEqual([sameSpec]);
    expect(result.setup!.config!.changed).toBe(true);
    expect(result.setup!.config!.backupPath).toBeDefined();
    expect(await readFile(result.setup!.config!.backupPath as string, "utf8")).toBe(beforeRaw);
  });

  it("already-current complete setup is a no-op and idempotent", async () => {
    const { spec: sameSpec } = runningSpec();
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const worktree = await tempDir("aria-t003-work-");
    const listed = ["ID  VERSION  SOURCE", `aria  842e4ec  ${sameSpec}`].join("\n");

    const firstExecutor = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    const first = await setup(binaryUrl(checkout), firstExecutor.executor, undefined, {
      worktree,
      files,
      dependenciesFn: installOnlyDependencies([]),
    });
    expect(first.ok).toBe(true);
    expect(first.setup!.agents!.written).toBe(11);
    const completeRaw = await readFile(files.globalConfigPath, "utf8");
    const completeAgents = await readFile(join(files.agentsDir, "coder.md"), "utf8").catch(() => null);
    expect(completeAgents).not.toBeNull();

    // Second run over the complete state writes nothing.
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    const dependencyCalls: string[] = [];
    const second = await setup(binaryUrl(checkout), executor, undefined, {
      worktree,
      files,
      dependenciesFn: installOnlyDependencies(dependencyCalls),
    });
    expect(second.ok).toBe(true);
    expect(second.stage).toBe("complete");
    expect(second.setup!.registration.action).toBe("already registered");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(second.setup!.config!.changed).toBe(false);
    expect(second.setup!.config!.backupPath).toBeUndefined();
    expect(second.setup!.agents!.written).toBe(0);
    expect(second.setup!.agents!.unchanged).toBe(11);
    // Byte-identical config; no stray backup from the no-op run.
    expect(await readFile(files.globalConfigPath, "utf8")).toBe(completeRaw);
    const entries = await readdir(join(files.globalConfigPath, ".."));
    const backups = entries.filter((entry) => entry.includes(".aria-backup-"));
    // Exactly one backup exists (from the first creation/refresh), none added.
    expect(backups.length).toBeLessThanOrEqual(1);
    // Omitted depsSync stays skipped with install-only ownership (never
    // version-chases); present deps stay skipped untouched.
    expect(second.setup!.sync.output).toContain("install-if-missing");
    expect(dependencyCalls).toEqual(["dependenciesFn"]);
    expect(second.setup!.dependencies!.outcomes.every((outcome) => outcome.mutated === false)).toBe(true);
  });

  it("R002 explicit conflicting --plugin-spec with a same-release registration refuses before any mutation (no duplicate)", async () => {
    const { spec: sameSpec } = runningSpec();
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const worktree = await tempDir("aria-t003-work-");
    // Running/registered simulated same release (v9.9.9) with an explicit
    // conflicting spec (v1.0.7): the same-release fallback must not
    // mask the explicit conflict.
    const explicitSpec = CONFLICTING_RELEASE_SPEC;
    expect(explicitSpec).not.toBe(sameSpec);
    const listed = ["ID  VERSION  SOURCE", `aria  842e4ec  ${sameSpec}`].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    let dependenciesCalled = false;
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    }, {
      worktree,
      files,
      pluginSpec: explicitSpec,
      dependenciesFn: async () => {
        dependenciesCalled = true;
        return { ok: true, outcomes: [], report: "must not run" };
      },
    });

    // Refusal before mutation: mismatch, no add/remove, no file writes, no
    // sync, no dependencies seam, and no duplicate conflicting registration.
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.action).toBe("failed");
    expect(result.setup!.registration.detail).toContain("definite mismatch");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(calls.some((call) => call.args.includes("remove"))).toBe(false);
    expect(result.setup?.config).toBeUndefined();
    expect(result.setup?.agents).toBeUndefined();
    expect(dependenciesCalled).toBe(false);
    expect(syncCalled).toBe(false);
    // No config file was written, so no duplicate conflicting entry exists.
    await expect(readFile(files.globalConfigPath, "utf8")).rejects.toThrow();
  });
});
