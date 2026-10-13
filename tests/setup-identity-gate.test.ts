import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { setup, update } from "../src/lifecycle.js";
import { isHandoffMatch, buildUpgradeHandoff, validateAriaTargetForRemoval } from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

/**
 * T002 identity-gate regression coverage: `setup()`/`update()` mutations
 * are gated on the positively identified states shared with the read-only
 * doctor (`parsePluginList` + `isSameLocalPluginIdentity` plus the exact
 * version predicates, single-sourced in `src/lifecycle.ts`).
 *
 * - A definite mismatch (conflicting `aria` source, including exact-tag
 *   evidence) or an ambiguous identity (duplicate registration, unknown
 *   list) fails closed BEFORE any `plugin add`, file write, or sync.
 * - Deterministic first-time bootstrap (recognized list, no `aria` entry)
 *   and idempotent re-runs (exact match, TUI included) still work.
 * - The only designed transition out of a mismatch is the explicit
 *   exact-target `aria upgrade --yes` handoff (pure validation bound here;
 *   the mutating remove/add/handoff transport stays covered by
 *   `tests/aria-upgrade.test.ts`).
 * - Project-local `aria.json` stays read-only and unrelated global
 *   OpenCode config is preserved (bootstrap) or untouched (blocked).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-t002-gate-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFixtureCheckout(): Promise<string> {
  const root = await tempDir();
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

const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

const SKILLS_ROOT = "/opt/aria-checkout/skills";

async function setupFiles() {
  const dir = await tempDir();
  const files = {
    globalConfigPath: join(dir, "opencode.json"),
    agentsDir: join(dir, "agents"),
    skillsRoot: SKILLS_ROOT,
  };
  assertNotCallerGlobalPath(files.globalConfigPath, "setup files.globalConfigPath");
  assertNotCallerGlobalPath(files.agentsDir, "setup files.agentsDir");
  return files;
}

/** Worktree carrying a project-local aria.json that must stay byte-identical. */
async function worktreeWithProjectAria(): Promise<{ worktree: string; projectAriaPath: string; before: string }> {
  const worktree = await tempDir();
  const projectAriaPath = join(worktree, "aria.json");
  const before = JSON.stringify({ roles: { coder: { model: "project/pinned" } } });
  await writeFile(projectAriaPath, before);
  return { worktree, projectAriaPath, before };
}

describe("T002 setup identity gate", () => {
  it("blocks a definite Git-tag mismatch before any write, keeping project aria.json read-only", async () => {
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const { worktree, projectAriaPath, before } = await worktreeWithProjectAria();
    // Live-workstation shape: running checkout vs registered v1.0.7.
    const listed = ["ID  VERSION  SOURCE", "aria  842e4ec  github:mscipio/ARIA#v1.0.7"].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, { worktree, files });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.action).toBe("failed");
    expect(result.setup!.registration.detail).toContain("definite mismatch");
    expect(result.setup!.registration.detail).toContain("aria upgrade --yes");
    // Fail-before-writes: no mutating plugin call, no config/agents, no sync.
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(calls.some((call) => call.args.includes("remove"))).toBe(false);
    expect(result.setup?.config).toBeUndefined();
    expect(result.setup?.agents).toBeUndefined();
    expect(syncCalled).toBe(false);
    await expect(readdir(files.agentsDir).catch(() => [])).resolves.toEqual([]);
    // Project aria.json is read-only; no global config was created.
    expect(await readFile(projectAriaPath, "utf8")).toBe(before);
    await expect(readFile(files.globalConfigPath, "utf8")).rejects.toThrow();
  });

  it("blocks a duplicated registration without comparing or writing", async () => {
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    // Duplicate of the intended target: still ambiguous (never guessed),
    // even though every row matches.
    const listed = [
      "ID  VERSION  SOURCE",
      `aria  local  ${checkout}`,
      `aria  local  ${checkout}`,
    ].join("\n");
    const { executor, calls } = collectingExecutor({ "opencode plugin list": { stdout: listed } });
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, { worktree: await tempDir(), files });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.detail).toContain("more than once");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(result.setup?.config).toBeUndefined();
    expect(syncCalled).toBe(false);
  });

  it("blocks unknown identity (unrecognized output and probe failure) fail-closed", async () => {
    const checkout = await makeFixtureCheckout();
    for (const pluginList of [{ stdout: "something unexpected" }, { error: "spawn opencode ENOENT" }]) {
      const files = await setupFiles();
      const { executor, calls } = collectingExecutor({ "opencode plugin list": pluginList });
      let syncCalled = false;
      const result = await setup(binaryUrl(checkout), executor, async () => {
        syncCalled = true;
        return okSync();
      }, { worktree: await tempDir(), files });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("registration");
      expect(result.setup!.registration.detail).toContain("not positively identified");
      expect(calls.some((call) => call.args.includes("add"))).toBe(false);
      expect(result.setup?.config).toBeUndefined();
      expect(syncCalled).toBe(false);
    }
  });

  it("allows deterministic bootstrap when registration is positively absent, preserving unrelated config", async () => {
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const { worktree, projectAriaPath, before } = await worktreeWithProjectAria();
    // Unrelated user-owned global config that setup must preserve.
    await writeFile(files.globalConfigPath, JSON.stringify({ custom: "kept", mcp: { other: { type: "local" } } }));
    const globalBefore = await readFile(files.globalConfigPath, "utf8");
    const { executor, calls } = collectingExecutor({
      "opencode plugin list": { stdout: "No plugins found" },
      [`opencode plugin add ${checkout}`]: { stdout: "installed" },
    });
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, { worktree, files });

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(syncCalled).toBe(true);
    expect(calls.filter((call) => call.args.includes("add")).length).toBe(1);
    // Unrelated keys preserved; project aria.json untouched.
    const written = JSON.parse(await readFile(files.globalConfigPath, "utf8")) as Record<string, unknown>;
    expect(written["custom"]).toBe("kept");
    expect(written["mcp"]).toEqual({ other: { type: "local" } });
    expect(JSON.parse(globalBefore)).not.toEqual(written);
    expect(await readFile(projectAriaPath, "utf8")).toBe(before);
    expect(result.setup!.agents!.written).toBe(11);
  });

  it("allows an idempotent re-run when the checkout already matches", async () => {
    const checkout = await makeFixtureCheckout();
    const files = await setupFiles();
    const { executor, calls } = collectingExecutor({
      "opencode plugin list": { stdout: ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n") },
    });
    let syncCalled = false;

    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, { worktree: await tempDir(), files });

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(syncCalled).toBe(true);
  });

  it("keeps the explicit exact-target upgrade handoff as the designed transition", async () => {
    // Pure validation bound: an exact release target validates BEFORE any
    // removal, and the handoff binds that exact target plus scope. The
    // mutating remove/add/handoff transport stays covered by
    // tests/aria-upgrade.test.ts; this pins the gate the setup block above
    // points at.
    const target = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };
    expect(validateAriaTargetForRemoval(target)).toEqual({ ok: true });
    expect(validateAriaTargetForRemoval(null).ok).toBe(false);
    const check = {
      currentVersion: "1.0.6",
      cliVersion: "1.0.8",
      installedSpec: "github:mscipio/ARIA#v1.0.6",
      available: { kind: "known" as const, target },
      selfUpgradeBlocked: false,
      blockReason: null,
      components: [{ component: "aria" as const, installed: "1.0.6", available: "v1.0.7", status: "upgrade-available" as const, detail: "x" }],
    };
    const handoff = buildUpgradeHandoff(target, check);
    expect(isHandoffMatch(handoff, target, ["aria"])).toEqual({ match: true });
    expect(isHandoffMatch(handoff, { ...target, spec: "github:mscipio/ARIA#v1.0.8" }, ["aria"]).match).toBe(false);
  });
});

describe("T002 update identity gate", () => {
  it("blocks an update on a definite mismatch before pull/install/handoff", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");
    const listed = ["ID  VERSION  SOURCE", "aria  842e4ec  github:mscipio/ARIA#v1.0.7"].join("\n");
    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "opencode plugin list": { stdout: listed },
      "git pull --ff-only": { stdout: "must not run" },
      "npm ci --omit=dev": { stdout: "must not run" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "must not run" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("identity");
    expect(result.update!.identity?.ok).toBe(false);
    expect(result.update!.identity?.error).toContain("definite mismatch");
    // Read-only preconditions ran; no mutation ran.
    expect(calls.some((call) => call.args.includes("pull"))).toBe(false);
    expect(calls.some((call) => call.args.includes("ci"))).toBe(false);
    expect(calls.some((call) => call.command === process.execPath)).toBe(false);
  });

  it("allows an update when the checkout matches the registration", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "opencode plugin list": { stdout: ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n") },
      "git pull --ff-only": { stdout: "Already up to date." },
      "npm ci --omit=dev": { stdout: "added 0 packages" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "sync ok", stderr: "" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
  });
});
