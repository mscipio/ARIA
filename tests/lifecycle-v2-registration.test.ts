import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { parsePluginList, setup } from "../src/lifecycle.js";

/**
 * T008 V2 registration/introspection remediation (pinned OpenCode 2.0.23).
 *
 * Pinned contract (isolated 2.0.23 binary `--help` evidence):
 * - `plugin --help`: subcommands list/add/check/update/remove (no bare
 *   `plugin <module>`, no `--global` on `add`).
 * - `plugin add --help`: `USAGE opencode plugin add [flags] <package>`,
 *   single `<package>` positional, no `--global` flag.
 * - `debug --help`: subcommands agents/config/paths only (no `info`).
 * - `plugin list`: `ID  VERSION  SOURCE` table or `No plugins found`.
 *
 * Mocks below use only those 2.0.23 surfaces (never `debug info`, never
 * `--global`, never invented flags).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-v2reg-"));
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

type Call = { command: string; args: string[] };

function collectingExecutor(responses: Record<string, { stdout?: string; stderr?: string; error?: string }>): {
  executor: Executor;
  calls: Call[];
} {
  const calls: Call[] = [];
  const executor: Executor = async (command, args) => {
    calls.push({ command, args });
    const response = responses[`${command} ${args.join(" ")}`];
    if (!response) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { executor, calls };
}

const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

const SKILLS_ROOT = "/opt/aria-checkout/skills";

describe("T008 V2 registration command shape (A)", () => {
  it("generates `plugin add <checkout-path>` with no --global and never calls `debug info`", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor, calls } = collectingExecutor({
      "opencode plugin list": { stdout: "No plugins found" },
      [`opencode plugin add ${checkout}`]: { stdout: 'Plugin installed and added' },
    });
    const worktree = await tempDir();
    const result = await setup(binaryUrl(checkout), executor, okSync, {
      worktree,
      files: {
        globalConfigPath: join(await tempDir(), "opencode.json"),
        agentsDir: join(await tempDir(), "agents"),
        skillsRoot: SKILLS_ROOT,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(calls).toContainEqual({ command: "opencode", args: ["plugin", "list"] });
    expect(calls).toContainEqual({ command: "opencode", args: ["plugin", "add", checkout] });
    for (const call of calls) {
      expect(call.args).not.toContain("--global");
      expect(call.args).not.toEqual(["debug", "info"]);
    }
  });

  it("reports the pinned local limitation without weakening fail-closed on real errors", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "opencode plugin list": { stdout: "No plugins found" },
      [`opencode plugin add ${checkout}`]: { error: "permission denied" },
    });
    let syncCalled = false;
    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, {
      worktree: await tempDir(),
      // T019: explicit temp paths even on the registration-failure path so
      // no phase can fall through to caller global paths.
      files: {
        globalConfigPath: join(await tempDir(), "opencode.json"),
        agentsDir: join(await tempDir(), "agents"),
        skillsRoot: SKILLS_ROOT,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(syncCalled).toBe(false);
  });
});

describe("T008 V2 pristine and repeat idempotence (B, C)", () => {
  it("pristine absent→success writes once; repeat detects correct with no duplicate registration", async () => {
    const checkout = await makeFixtureCheckout();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const agentsDir = join(dir, "agents");
    const worktree = await tempDir();

    const first = collectingExecutor({
      "opencode plugin list": { stdout: "No plugins found" },
      [`opencode plugin add ${checkout}`]: { stdout: "installed" },
    });
    const firstResult = await setup(binaryUrl(checkout), first.executor, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.setup!.registration.action).toBe("registered");
    expect(firstResult.setup!.config!.changed).toBe(true);
    expect(firstResult.setup!.agents!.written).toBe(11);
    expect(firstResult.setup!.agents!.unchanged).toBe(0);

    // Repeat: list shows the checkout path; no `plugin add` response is
    // configured, so any duplicate registration attempt throws.
    const second = collectingExecutor({
      "opencode plugin list": { stdout: ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n") },
    });
    const secondResult = await setup(binaryUrl(checkout), second.executor, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(secondResult.ok).toBe(true);
    expect(secondResult.setup!.registration.action).toBe("already registered");
    expect(second.executor).toBeDefined();
    expect(secondResult.setup!.config!.changed).toBe(false);
    expect(secondResult.setup!.agents!.written).toBe(0);
    expect(secondResult.setup!.agents!.unchanged).toBe(11);
  });
});

describe("T008 V2 absence/presence surfaces only (D)", () => {
  it("parses the 2.0.23 table, empty, unrecognized, and space-containing targets", () => {
    expect(parsePluginList("No plugins found")).toEqual({ recognized: true, entries: [] });
    expect(parsePluginList("ID  VERSION  SOURCE\naria  local  /opt/aria").entries).toEqual([
      { id: "aria", version: "local", target: "/opt/aria" },
    ]);
    // Paths with spaces survive as a single SOURCE remainder.
    const spaced = parsePluginList("ID  VERSION  SOURCE\naria  local  /tmp/my project (v2)");
    expect(spaced.recognized).toBe(true);
    expect(spaced.entries[0]!.target).toBe("/tmp/my project (v2)");
    // V1 `debug info` shape has no V2 table header: unrecognized, never guessed.
    expect(parsePluginList("OpenCode Debug Info\nplugins:\n  - file:///x").recognized).toBe(false);
  });

  it("falls back to `plugin add` on unrecognized list output without `debug info`", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor, calls } = collectingExecutor({
      "opencode plugin list": { stdout: "something unexpected" },
      [`opencode plugin add ${checkout}`]: { stdout: "installed via fallback" },
    });
    const result = await setup(binaryUrl(checkout), executor, okSync, {
      worktree: await tempDir(),
      files: {
        globalConfigPath: join(await tempDir(), "opencode.json"),
        agentsDir: join(await tempDir(), "agents"),
        skillsRoot: SKILLS_ROOT,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(calls.some((call) => call.args.join(" ") === "debug info")).toBe(false);
  });
});

describe("T008 V2 fail-closed rollback after registration/config mutation (E)", () => {
  it("restores the config file when agent installation fails after registration", async () => {
    const checkout = await makeFixtureCheckout();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ user: "kept" });
    await writeFile(configPath, original);
    const agentsBlocker = join(dir, "blocker");
    await writeFile(agentsBlocker, "not a directory");
    const { executor } = collectingExecutor({
      "opencode plugin list": { stdout: "No plugins found" },
      [`opencode plugin add ${checkout}`]: { stdout: "installed" },
    });
    let syncCalled = false;
    const result = await setup(binaryUrl(checkout), executor, async () => {
      syncCalled = true;
      return okSync();
    }, {
      worktree: await tempDir(),
      files: { globalConfigPath: configPath, agentsDir: agentsBlocker, skillsRoot: SKILLS_ROOT },
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("agents");
    expect(syncCalled).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });
});
