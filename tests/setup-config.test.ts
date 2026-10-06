import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentFiles, readPackageVersion } from "../src/agents.js";
import type { Executor } from "../src/deps.js";
import { resolveCheckout, setup } from "../src/lifecycle.js";
import {
  applyAriaPluginToConfig,
  applyAriaSetupToConfig,
  ensureAriaSetupConfigFile,
  findLegacySetupKeys,
  resolveSetupAriaConfig,
  rollbackSetupConfigFile,
  validateAriaSetupConfig,
} from "../src/setup-config.js";

/**
 * T008 setup/config file phases: V2-only keys, preservation, idempotence,
 * backup/rollback, and lifecycle wiring. Permission renames and depth
 * evaluation semantics are T004-owned (`tests/permissions.test.ts`); the
 * 21-skill applier contract is T007-owned (`tests/skills-config.test.ts`).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-setup-config-"));
  tempDirs.push(dir);
  return dir;
}

const PLUGIN_URI = "file:///opt/aria-checkout";
const SKILLS_ROOT = "/opt/aria-checkout/skills";

function mockExecutor(responses: Record<string, { stdout?: string; stderr?: string; error?: string }>): Executor {
  return async (command: string, args: string[]) => {
    const response = responses[`${command} ${args.join(" ")}`];
    if (!response) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

/** Fixture checkout with bin/aria.mjs plus its exact plugin URI as setup() derives it. */
async function fixtureSetup(): Promise<{ binaryUrl: string; pluginUri: string }> {
  const checkout = await tempDir();
  await mkdir(join(checkout, "bin"), { recursive: true });
  const binaryPath = join(checkout, "bin", "aria.mjs");
  await writeFile(binaryPath, "#!/usr/bin/env node\n");
  const binaryUrl = pathToFileURL(binaryPath).href;
  const pluginUri = pathToFileURL(await resolveCheckout(binaryUrl)).href;
  return { binaryUrl, pluginUri };
}

function introspected(uri: string): Record<string, { stdout: string }> {
  return {
    "opencode plugin list": {
      stdout: ["ID  VERSION  SOURCE", `aria  local  ${uri}`].join("\n"),
    },
  };
}

const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

describe("T008 V2 setup appliers (pure)", () => {
  it("writes only supported V2 keys: exact plugin URI, skills root, depth default 3", () => {
    const config: Record<string, unknown> = {};
    const result = applyAriaSetupToConfig(config, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });

    expect(result).toEqual({ pluginsAdded: true, skillsAdded: true, depthFilled: true });
    expect(config).toEqual({
      plugins: [PLUGIN_URI],
      skills: [SKILLS_ROOT],
      experimental: { subagent_depth: 3 },
    });
    // Never emits V1 keys.
    expect(config).not.toHaveProperty("plugin");
    expect(config).not.toHaveProperty("subagent_depth");
    expect(validateAriaSetupConfig(config, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("preserves unrelated user config and user entries; second run changes nothing", () => {
    const config: Record<string, unknown> = {
      model: "custom/default",
      mcp: { extra: { type: "local", command: "x" } },
      plugins: ["file:///user/plugin"],
      skills: ["/user/skills"],
      experimental: { subagent_depth: 0, portable_shell_scanner: true },
    };
    const first = applyAriaSetupToConfig(config, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });

    // Explicit depth (including 0) is preserved, never overwritten.
    expect(first).toEqual({ pluginsAdded: true, skillsAdded: true, depthFilled: false });
    expect(config.plugins).toEqual(["file:///user/plugin", PLUGIN_URI]);
    expect(config.skills).toEqual(["/user/skills", SKILLS_ROOT]);
    expect((config.experimental as { subagent_depth?: number }).subagent_depth).toBe(0);
    expect((config.experimental as { portable_shell_scanner?: boolean }).portable_shell_scanner).toBe(true);
    expect(config.model).toBe("custom/default");

    const snapshot = JSON.stringify(config);
    const second = applyAriaSetupToConfig(config, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(second).toEqual({ pluginsAdded: false, skillsAdded: false, depthFilled: false });
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it("leaves legacy non-array shapes for file-level migration and flags them", () => {
    const plugins: Record<string, unknown> = { plugins: { old: true } };
    expect(applyAriaPluginToConfig(plugins, PLUGIN_URI)).toEqual({ added: false });
    expect(plugins.plugins).toEqual({ old: true });

    expect(findLegacySetupKeys({ subagent_depth: 2 })).toEqual([
      "subagent_depth (V1 top-level; V2 uses experimental.subagent_depth)",
    ]);
    expect(findLegacySetupKeys({ plugin: "x" })).toEqual(["plugin (V1 singular; V2 uses plugins[])"]);
    expect(findLegacySetupKeys({ skills: { paths: ["/s"] } })).toEqual([
      "skills (legacy object; V2 uses skills: string[])",
    ]);
    expect(findLegacySetupKeys({ plugins: [], skills: [], experimental: {} })).toEqual([]);

    const issues = validateAriaSetupConfig(
      { skills: { paths: ["/s"] }, plugins: [] },
      { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT },
    );
    expect(issues.join("\n")).toContain("legacy object");
    expect(issues.join("\n")).toContain("not registered");
  });
});

describe("T008 global config file (backup/rollback/idempotence)", () => {
  it("creates, preserves, and leaves unchanged on re-run with no stray files", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, JSON.stringify({ mcp: { ctx: 1 }, plugins: ["file:///user/plugin"] }, null, 2));

    const first = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(first.changed).toBe(true);
    expect(first.created).toBe(false);
    expect(first.backupPath).toBeDefined();

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.mcp).toEqual({ ctx: 1 });
    expect(written.plugins).toEqual(["file:///user/plugin", PLUGIN_URI]);
    expect(written.skills).toEqual([SKILLS_ROOT]);
    expect((written.experimental as { subagent_depth?: number }).subagent_depth).toBe(3);
    expect(written).not.toHaveProperty("plugin");
    expect(written).not.toHaveProperty("subagent_depth");

    const second = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();

    // Backup + config only; atomic temp files never leak.
    const entries = (await readdir(dir)).sort();
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(entries.some((entry) => entry.includes(".aria-backup-"))).toBe(true);
  });

  it("migrates a legacy skills object forward with backup, preserving string entries", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({ skills: { paths: ["/user/skills", 42], urls: ["https://x/skills"] } }),
    );

    const result = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(result.changed).toBe(true);
    expect(result.migratedLegacySkills).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toContain("paths");

    const written = JSON.parse(await readFile(configPath, "utf8")) as { skills?: unknown };
    expect(written.skills).toEqual(["/user/skills", "https://x/skills", SKILLS_ROOT]);
  });

  it("rolls back a replacement byte-for-byte, removes a created file, and ignores no-change state", async () => {
    const dir = await tempDir();

    const replacedPath = join(dir, "opencode.json");
    const original = JSON.stringify({ keep: true }, null, 2);
    await writeFile(replacedPath, original);
    const replaced = await ensureAriaSetupConfigFile({ configPath: replacedPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(replaced.changed).toBe(true);
    await rollbackSetupConfigFile(replacedPath, replaced);
    expect(await readFile(replacedPath, "utf8")).toBe(original);

    const createdPath = join(dir, "fresh.json");
    const created = await ensureAriaSetupConfigFile({ configPath: createdPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(created.created).toBe(true);
    await rollbackSetupConfigFile(createdPath, created);
    await expect(readFile(createdPath, "utf8")).rejects.toThrow();

    const settled = await ensureAriaSetupConfigFile({ configPath: replacedPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(settled.changed).toBe(true);
    const repeat = await ensureAriaSetupConfigFile({ configPath: replacedPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(repeat.changed).toBe(false);
    const bytesBefore = await readFile(replacedPath, "utf8");
    await rollbackSetupConfigFile(replacedPath, repeat);
    expect(await readFile(replacedPath, "utf8")).toBe(bytesBefore);
  });

  it("fails closed on invalid JSON without touching the file", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, "{broken");
    await expect(
      ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT }),
    ).rejects.toThrow("invalid JSON");
    expect(await readFile(configPath, "utf8")).toBe("{broken");
  });

  it("dedupes a legacy skills object that already contains the ARIA root", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({ skills: { paths: [SKILLS_ROOT, "/user/skills"], urls: [SKILLS_ROOT] } }),
    );

    const result = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(result.changed).toBe(true);
    expect(result.migratedLegacySkills).toBe(true);

    const written = JSON.parse(await readFile(configPath, "utf8")) as { skills?: unknown };
    expect(written.skills).toEqual([SKILLS_ROOT, "/user/skills"]);
    expect(validateAriaSetupConfig(written, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("migrates V1 plugin + top-level depth with backup and validates", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify(
      { plugin: "file:///legacy-plugin", subagent_depth: 2, mcp: { keep: true } },
      null,
      2,
    );
    await writeFile(configPath, original);

    const result = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe(original);

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written).not.toHaveProperty("plugin");
    expect(written).not.toHaveProperty("subagent_depth");
    expect(written.plugins).toEqual(["file:///legacy-plugin", PLUGIN_URI]);
    expect((written.experimental as { subagent_depth?: number }).subagent_depth).toBe(2);
    expect((written as { mcp?: unknown }).mcp).toEqual({ keep: true });
    expect(validateAriaSetupConfig(written, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("preserves an explicit V2 depth when a V1 top-level duplicate exists", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({ subagent_depth: 2, experimental: { subagent_depth: 0 } }),
    );

    await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written).not.toHaveProperty("subagent_depth");
    expect((written.experimental as { subagent_depth?: number }).subagent_depth).toBe(0);
    expect(validateAriaSetupConfig(written, { pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("rejects unmigratable legacy shapes before mutation without touching the file", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ plugins: { old: true }, skills: [] });
    await writeFile(configPath, original);

    await expect(
      ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT }),
    ).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
    expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces atomically: backup is a copy and the live path is never missing", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ keep: true }, null, 2);
    await writeFile(configPath, original);

    const result = await ensureAriaSetupConfigFile({ configPath, pluginUri: PLUGIN_URI, skillsRoot: SKILLS_ROOT });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    // Copy semantics: backup holds the original bytes while the live path
    // already holds the replacement — both exist simultaneously.
    expect(await readFile(result.backupPath as string, "utf8")).toBe(original);
    const live = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(live.plugins).toEqual([PLUGIN_URI]);
    expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

describe("T008 setup lifecycle file phases", () => {
  it("writes config + agent files with temp paths; second run is idempotent", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const agentsDir = join(dir, "agents");
    const worktree = await tempDir();

    const first = await setup(binaryUrl, mockExecutor(introspected(pluginUri)), okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(first.ok).toBe(true);
    expect(first.stage).toBe("complete");
    expect(first.setup?.config?.changed).toBe(true);
    expect(first.setup?.agents?.written).toBe(11);
    expect(first.setup?.agents?.unchanged).toBe(0);

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.plugins).toEqual([pluginUri]);
    expect(written.skills).toEqual([SKILLS_ROOT]);
    expect(validateAriaSetupConfig(written, { pluginUri, skillsRoot: SKILLS_ROOT })).toEqual([]);

    const second = await setup(binaryUrl, mockExecutor(introspected(pluginUri)), okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(second.ok).toBe(true);
    expect(second.setup?.config?.changed).toBe(false);
    expect(second.setup?.agents?.written).toBe(0);
    expect(second.setup?.agents?.unchanged).toBe(11);
  });

  it("resolves agent files project-neutral: CWD project overrides never bake into global files", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    // Project-local model override at the setup worktree must not leak into
    // the global managed files (T005 overlays stay runtime-only).
    const worktree = await tempDir();
    await writeFile(
      join(worktree, "aria.json"),
      JSON.stringify({ roles: { explorer: { model: "custom/project-model" } } }),
    );
    const dir = await tempDir();

    const result = await setup(binaryUrl, mockExecutor(introspected(pluginUri)), okSync, {
      worktree,
      files: { globalConfigPath: join(dir, "opencode.json"), agentsDir: join(dir, "agents"), skillsRoot: SKILLS_ROOT },
    });
    expect(result.ok).toBe(true);
    const explorerFile = await readFile(join(dir, "agents", "explorer.md"), "utf8");
    expect(explorerFile).not.toContain("custom/project-model");
    expect(resolveSetupAriaConfig(worktree).roles.explorer.model).not.toBe("custom/project-model");
  });

  it("rolls back the config write when agent installation fails", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ user: "kept" });
    await writeFile(configPath, original);
    // An existing regular file where the agents directory must go.
    const agentsBlocker = join(dir, "blocker");
    await writeFile(agentsBlocker, "not a directory");
    const worktree = await tempDir();

    let syncCalled = false;
    const result = await setup(
      binaryUrl,
      mockExecutor(introspected(pluginUri)),
      async () => {
        syncCalled = true;
        return okSync();
      },
      { worktree, files: { globalConfigPath: configPath, agentsDir: agentsBlocker, skillsRoot: SKILLS_ROOT } },
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("agents");
    expect(syncCalled).toBe(false);
    // Mandatory rollback: user bytes restored, backup consumed.
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });

  it("fails closed on invalid global config without running sync", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, "{broken");
    const worktree = await tempDir();

    let syncCalled = false;
    const result = await setup(
      binaryUrl,
      mockExecutor(introspected(pluginUri)),
      async () => {
        syncCalled = true;
        return okSync();
      },
      { worktree, files: { globalConfigPath: configPath, agentsDir: join(dir, "agents"), skillsRoot: SKILLS_ROOT } },
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("config");
    expect(syncCalled).toBe(false);
    expect(result.setup?.config?.detail).toContain("invalid JSON");
  });

  it("backs up a pre-existing unmanaged agent instead of overwriting it", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    const dir = await tempDir();
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "coder.md"), "user-owned coder agent\n");
    const worktree = await tempDir();

    const result = await setup(binaryUrl, mockExecutor(introspected(pluginUri)), okSync, {
      worktree,
      files: { globalConfigPath: join(dir, "opencode.json"), agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(result.ok).toBe(true);
    expect(result.setup?.agents?.written).toBe(11);
    expect((await readdir(agentsDir)).some((entry) => entry.startsWith("coder.md.aria-backup-"))).toBe(true);
    // Canonical generation path stays intact (installAgentFiles owns bytes).
    const resolved = resolveSetupAriaConfig(worktree);
    expect(await readFile(join(agentsDir, "coder.md"), "utf8")).toBe(
      generateAgentFiles(resolved, readPackageVersion()).coder,
    );
  });

  it("rolls back accumulated agent files on mid-install failure (partial-install)", async () => {
    const { binaryUrl, pluginUri } = await fixtureSetup();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const originalConfig = JSON.stringify({ user: "kept" });
    await writeFile(configPath, originalConfig);
    // coder is unmanaged (replaced + backed up) before explorer fails: a
    // directory at explorer.md makes the second install step throw after
    // the first already committed.
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    const originalCoder = "user-owned coder agent\n";
    await writeFile(join(agentsDir, "coder.md"), originalCoder);
    await mkdir(join(agentsDir, "explorer.md"), { recursive: true });
    const worktree = await tempDir();

    let syncCalled = false;
    const result = await setup(
      binaryUrl,
      mockExecutor(introspected(pluginUri)),
      async () => {
        syncCalled = true;
        return okSync();
      },
      { worktree, files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT } },
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("agents");
    expect(syncCalled).toBe(false);
    // Config rolled back byte-for-byte with its backup consumed.
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
    // Accumulated agent change rolled back: replaced coder restored and its
    // backup consumed, including the backup-moved-before-failed-replacement
    // path for the current role.
    expect(await readFile(join(agentsDir, "coder.md"), "utf8")).toBe(originalCoder);
    expect((await readdir(agentsDir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });
});
