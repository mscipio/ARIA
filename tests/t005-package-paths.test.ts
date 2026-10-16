import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readPackageVersion } from "../src/agents.js";
import { getPackageRoot, loadDefaultConfig } from "../src/defaults.js";
import type { Executor } from "../src/deps.js";
import { resolveInstalledPackageRoot, setup } from "../src/lifecycle.js";
import { getPackageSkillsRoot } from "../src/skills.js";

/**
 * T005 production decoupling: a bare `aria` invocation uses its globally
 * installed package/assets and never infers or requires the dev checkout;
 * development remains `node ./bin/aria.mjs` with `process.cwd()` selecting
 * the invocation worktree. No `npm link`.
 *
 * Focused package-path regression only (no live v1.0.15 mutation, no
 * exhaustive branch coverage): packaged assets + registration identity
 * resolve from the installed package outside the repository, without
 * checkout paths leaking into production behavior.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-t005-"));
  tempDirs.push(dir);
  return dir;
}

describe("T005 packaged paths resolve from the installed package", () => {
  it("package-root/default/skills/version resolve from the loaded install, location-independent", async () => {
    const installedRoot = getPackageRoot();
    // Packaged assets load from the running install itself.
    const defaults = loadDefaultConfig();
    expect(Object.keys(defaults.roles)).toHaveLength(11);
    const version = readPackageVersion();
    const raw = JSON.parse(await readFile(resolve(installedRoot, "package.json"), "utf8")) as { version?: unknown };
    expect(version).toBe(raw.version);
    const skillsRoot = getPackageSkillsRoot();
    expect(skillsRoot).toBe(join(installedRoot, "skills"));
    // One representative packaged skill file is the on-disk tree, not a copy.
    const skillMd = await readFile(join(skillsRoot, "rdc-code-implementation", "SKILL.md"), "utf8");
    expect(skillMd.length).toBeGreaterThan(0);
    expect(resolveInstalledPackageRoot()).toBe(installedRoot);

    // Location-independence: an installed package outside the repository
    // resolves to its own root, never back to this checkout.
    const outsideBase = await tempDir();
    const outsideRoot = join(outsideBase, "node_modules", "aria");
    const fakeMeta = pathToFileURL(join(outsideRoot, "dist", "defaults.js")).href;
    expect(getPackageRoot(fakeMeta)).toBe(outsideRoot);
    expect(getPackageSkillsRoot(outsideRoot)).toBe(join(outsideRoot, "skills"));
    expect(getPackageRoot(fakeMeta)).not.toBe(installedRoot);
  });

  it("bin/aria.mjs uses installed-package-relative assets, never a dev checkout path", async () => {
    const installedRoot = getPackageRoot();
    const binText = await readFile(resolve(installedRoot, "bin", "aria.mjs"), "utf8");
    // Production assets resolve relative to the running install.
    expect(binText).toContain("../dist/");
    expect(binText).toContain("../package.json");
    // No absolute checkout leakage baked into the dispatcher.
    expect(binText).not.toContain(installedRoot);
  });

  it("setup registration identity resolves from the install with invocation-worktree cwd, no checkout leakage", async () => {
    // Simulated installed package outside the repository (co-located
    // bin/ + root, as both bare `aria` and `node ./bin/aria.mjs` ship).
    const installedDir = await tempDir();
    await mkdir(join(installedDir, "bin"), { recursive: true });
    const binaryPath = join(installedDir, "bin", "aria.mjs");
    await writeFile(binaryPath, "#!/usr/bin/env node\n");
    const binaryUrl = pathToFileURL(binaryPath).href;
    const { resolveCheckout } = await import("../src/lifecycle.js");
    const fixtureRoot = await resolveCheckout(binaryUrl);
    expect(fixtureRoot).toBe(installedDir);
    const fixtureUri = pathToFileURL(fixtureRoot).href;
    const fixtureSkills = join(fixtureRoot, "skills");

    // Invocation worktree outside both the fixture install and this checkout.
    const worktree = await tempDir();
    const confDir = await tempDir();
    const configPath = join(confDir, "opencode.json");
    const agentsDir = join(confDir, "agents");

    const seenCwd: string[] = [];
    // `plugin add` is invoked with the local directory argument; accept it.
    const recordingExecutor: Executor = async (command, args, options) => {
      if (options?.cwd !== undefined) seenCwd.push(options.cwd);
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
      if (invocation.startsWith("opencode plugin add ")) return { stdout: "ok", stderr: "" };
      throw new Error(`Unexpected command: ${invocation}`);
    };

    const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

    const result = await setup(binaryUrl, recordingExecutor, okSync as never, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: fixtureSkills },
    });
    expect(result.ok).toBe(true);

    // Subprocesses ran in the invocation worktree, never in the package root.
    expect(seenCwd.length).toBeGreaterThan(0);
    for (const cwd of seenCwd) expect(cwd).toBe(worktree);

    // Registration + config identity name the fixture install, never this checkout.
    const repoRoot = getPackageRoot();
    const written = JSON.parse(await readFile(configPath, "utf8")) as { plugins?: unknown; skills?: unknown };
    expect(JSON.stringify(written.plugins)).toContain(fixtureUri);
    expect(JSON.stringify(written.skills)).toContain(fixtureSkills);
    if (fixtureRoot !== repoRoot) {
      expect(JSON.stringify(written)).not.toContain(repoRoot);
    }
  });
});
