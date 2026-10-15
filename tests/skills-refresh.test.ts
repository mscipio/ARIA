import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stripJsoncComments } from "../src/deps.js";
import {
  ensureAriaSetupConfigFile,
  ensureAriaSkillsRefreshFile,
} from "../src/setup-config.js";
import {
  applyAriaSkillsToConfig,
  isAriaPackageSkillsPath,
  validateAriaSkillsConfig,
} from "../src/skills.js";
import { runAriaSkillsRefreshPhase } from "../src/upgrade.js";

/**
 * T007 v1.0.14 — positively owned skills refresh (isolated temp dirs only).
 *
 * Covers the four required behaviors plus fail-closed validation:
 * owned-refresh (single stale packaged `node_modules/aria/skills` → current
 * in place), idempotent-current (no write), unrelated-preserved
 * (user entries/keys keep order and bytes), ambiguous-closed (empty,
 * non-array, multiple owned, stale+current, duplicate — no write, no backup).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-skills-refresh-"));
  tempDirs.push(dir);
  return dir;
}

// Packaged-shape helpers: only `node_modules/aria/skills` is positively owned.
function packagedSkills(prefix: string): string {
  return join(prefix, "node_modules", "aria", "skills");
}

describe("T007 owned skills predicate", () => {
  it("positively identifies only packaged node_modules/aria/skills paths", () => {
    expect(isAriaPackageSkillsPath("/tmp/x/node_modules/aria/skills")).toBe(true);
    expect(isAriaPackageSkillsPath("/user/skills")).toBe(false);
    expect(isAriaPackageSkillsPath("/custom/skills")).toBe(false);
    expect(isAriaPackageSkillsPath("https://x/skills")).toBe(false);
    expect(isAriaPackageSkillsPath("relative/skills")).toBe(false);
    expect(isAriaPackageSkillsPath("")).toBe(false);
    expect(isAriaPackageSkillsPath(42)).toBe(false);
    expect(isAriaPackageSkillsPath("/checkout/skills")).toBe(false);
  });
});

describe("T007 pure applier refresh", () => {
  it("refreshes a single stale packaged entry in place, preserving unrelated order", () => {
    const stale = packagedSkills("/old/npx-cache");
    const current = packagedSkills("/new/release");
    const config: { skills?: unknown } = { skills: ["/user/skills", stale] };
    expect(applyAriaSkillsToConfig(config, current)).toEqual({ added: true });
    expect(config.skills).toEqual(["/user/skills", current]);
    expect(validateAriaSkillsConfig(config, current)).toEqual([]);
  });

  it("is idempotent when the current root is already present once", () => {
    const current = packagedSkills("/new/release");
    const config: { skills?: unknown } = { skills: ["/user/skills", current] };
    const snapshot = JSON.stringify(config);
    expect(applyAriaSkillsToConfig(config, current)).toEqual({ added: false });
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(validateAriaSkillsConfig(config, current)).toEqual([]);
  });

  it("appends alongside unrelated entries when no owned entry exists", () => {
    const current = packagedSkills("/new/release");
    const config: { skills?: unknown } = { skills: ["/user/skills"] };
    expect(applyAriaSkillsToConfig(config, current)).toEqual({ added: true });
    expect(config.skills).toEqual(["/user/skills", current]);
  });

  it("fails closed on ambiguous ownership without mutation", () => {
    const staleA = packagedSkills("/old/a");
    const staleB = packagedSkills("/old/b");
    const current = packagedSkills("/new/release");

    expect(() => applyAriaSkillsToConfig({ skills: [] }, current)).toThrow(/explicitly empty/);

    const multiStale: { skills?: unknown } = { skills: [staleA, staleB] };
    const multiBefore = JSON.stringify(multiStale);
    expect(() => applyAriaSkillsToConfig(multiStale, current)).toThrow(/ambiguous/);
    expect(JSON.stringify(multiStale)).toBe(multiBefore);

    const stalePlusCurrent: { skills?: unknown } = { skills: [staleA, current] };
    const mixedBefore = JSON.stringify(stalePlusCurrent);
    expect(() => applyAriaSkillsToConfig(stalePlusCurrent, current)).toThrow(/ambiguous/);
    expect(JSON.stringify(stalePlusCurrent)).toBe(mixedBefore);

    const nonArray: { skills?: unknown } = { skills: { paths: ["/s"] } };
    expect(applyAriaSkillsToConfig(nonArray, current)).toEqual({ added: false });
    expect(nonArray.skills).toEqual({ paths: ["/s"] });
  });
});

describe("T007 setup file refresh (existing writer)", () => {
  it("refreshes stale to current with backup, preserves unrelated keys, then idempotent", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const stale = packagedSkills("/old/npx-cache");
    const current = packagedSkills("/new/release");
    await writeFile(
      configPath,
      JSON.stringify({ mcp: { keep: true }, skills: ["/user/skills", stale] }, null, 2),
    );

    const first = await ensureAriaSetupConfigFile({
      configPath,
      pluginUri: "file:///opt/aria",
      skillsRoot: current,
    });
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeDefined();
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.skills).toEqual(["/user/skills", current]);
    expect(written.mcp).toEqual({ keep: true });

    const second = await ensureAriaSetupConfigFile({
      configPath,
      pluginUri: "file:///opt/aria",
      skillsRoot: current,
    });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
  });

  it("fails closed on ambiguous ownership without touching the file or backup", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ skills: [packagedSkills("/old/a"), packagedSkills("/old/b")] });
    await writeFile(configPath, original);
    await expect(
      ensureAriaSetupConfigFile({ configPath, pluginUri: "file:///opt/aria", skillsRoot: packagedSkills("/new") }),
    ).rejects.toThrow(/ambiguous/);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });
});

describe("T007 strict skills-only refresh (upgrade continuation)", () => {
  it("refreshes stale, idempotent on current, preserves unrelated, fails closed on ambiguous", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const stale = packagedSkills("/old/npx-cache");
    const current = packagedSkills("/new/release");

    await writeFile(configPath, JSON.stringify({ keep: "yes", skills: ["/user/skills", stale] }, null, 2));
    const beforeRaw = await readFile(configPath, "utf8");
    const refreshed = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.backupPath).toBeDefined();
    expect(await readFile(refreshed.backupPath as string, "utf8")).toBe(beforeRaw);
    const afterRaw = await readFile(configPath, "utf8");
    // T011 byte preservation: only the owned string literal changes.
    expect(afterRaw).toBe(beforeRaw.split(JSON.stringify(stale)).join(JSON.stringify(current)));
    const after = JSON.parse(afterRaw) as Record<string, unknown>;
    expect(after.skills).toEqual(["/user/skills", current]);
    expect(after.keep).toBe("yes");

    const idempotent = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(idempotent.changed).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(afterRaw);

    const ambiguousPath = join(dir, "ambiguous.json");
    const ambiguousOriginal = JSON.stringify({ skills: [packagedSkills("/old/a"), packagedSkills("/old/b")] });
    await writeFile(ambiguousPath, ambiguousOriginal);
    await expect(
      ensureAriaSkillsRefreshFile({ configPath: ambiguousPath, skillsRoot: current }),
    ).rejects.toThrow(/ambiguous/);
    expect(await readFile(ambiguousPath, "utf8")).toBe(ambiguousOriginal);

    const missingKeyPath = join(dir, "missing-key.json");
    await writeFile(missingKeyPath, JSON.stringify({ keep: true }));
    await expect(
      ensureAriaSkillsRefreshFile({ configPath: missingKeyPath, skillsRoot: current }),
    ).rejects.toThrow(/missing/);
    expect(JSON.parse(await readFile(missingKeyPath, "utf8"))).toEqual({ keep: true });

    await expect(
      ensureAriaSkillsRefreshFile({ configPath: join(dir, "does-not-exist.json"), skillsRoot: current }),
    ).rejects.toThrow(/missing/);
  });

  it("upgrade phase refreshes via configDir without deleting caches or rewriting unrelated config", async () => {
    const configDir = await tempDir();
    const stale = packagedSkills("/old/npx-cache");
    // Use the real current release root so the phase proves end-to-end wiring;
    // the stale entry is the only owned path, so it refreshes regardless.
    const { getPackageSkillsRoot } = await import("../src/skills.js");
    const current = getPackageSkillsRoot();
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ sentinel: "kept", skills: ["/user/skills", stale] }, null, 2),
    );

    const staleCacheDir = await tempDir();
    const sentinel = join(staleCacheDir, "sentinel.txt");
    await writeFile(sentinel, "old cache must survive");

    const ok = await runAriaSkillsRefreshPhase({ target: { tag: "v0.0.0", version: "0.0.0", spec: "github:mscipio/ARIA#v0.0.0" }, executor: async () => ({ stdout: "", stderr: "" }), configDir });
    expect(ok.ok).toBe(true);
    expect(ok.mutated).toBe(true);
    const after = JSON.parse(await readFile(join(configDir, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(after.skills).toEqual(["/user/skills", current]);
    expect(after.sentinel).toBe("kept");
    expect(await readFile(sentinel, "utf8")).toBe("old cache must survive");

    const again = await runAriaSkillsRefreshPhase({ target: { tag: "v0.0.0", version: "0.0.0", spec: "github:mscipio/ARIA#v0.0.0" }, executor: async () => ({ stdout: "", stderr: "" }), configDir });
    expect(again.ok).toBe(true);
    expect(again.mutated).toBe(false);
  });
});

describe("T011 surgical JSONC refresh preserves every unrelated byte", () => {
  it("replaces only the stale owned string, keeping MCP comments and formatting", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.jsonc");
    const stale = packagedSkills("/old/npx-cache");
    const current = packagedSkills("/new/release");
    const beforeRaw =
      `{\n` +
      `  // MCP servers (user-owned comment must survive)\n` +
      `  "mcp": { "keep": true }, // trailing comment on mcp\n` +
      `  /* block comment about skills */\n` +
      `  "skills": [\n` +
      `    "/user/skills", // user entry comment\n` +
      `    "${stale}", // stale owned entry\n` +
      `  ],\n` +
      `  "sentinel": "kept", // trailing comment\n` +
      `}\n`;
    await writeFile(configPath, beforeRaw);

    const result = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(result.changed).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe(beforeRaw);

    const afterRaw = await readFile(configPath, "utf8");
    // Only the owned string literal changes — the diff proves comments,
    // whitespace, key order, and the trailing newline are preserved.
    expect(afterRaw).toBe(beforeRaw.split(JSON.stringify(stale)).join(JSON.stringify(current)));
    expect(afterRaw).toContain("// MCP servers (user-owned comment must survive)");
    expect(afterRaw).toContain("// trailing comment on mcp");
    expect(afterRaw).toContain("/* block comment about skills */");
    expect(afterRaw).toContain("// user entry comment");
    const after = JSON.parse(stripJsoncComments(afterRaw)) as Record<string, unknown>;
    expect(after.skills).toEqual(["/user/skills", current]);
    expect(after.sentinel).toBe("kept");

    // Idempotent: the refreshed file parses back to current with no write.
    const again = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(again.changed).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(afterRaw);
  });

  it("appends alongside unrelated entries without touching other bytes", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const current = packagedSkills("/new/release");
    // Compact, no trailing newline: the surgical insert preserves both facts.
    const beforeRaw = `{"sentinel":"kept","skills":["/user/skills"]}`;
    await writeFile(configPath, beforeRaw);

    const result = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(true);
    const afterRaw = await readFile(configPath, "utf8");
    expect(afterRaw).toBe(`{"sentinel":"kept","skills":["/user/skills", ${JSON.stringify(current)}]}`);
    expect(afterRaw.endsWith("\n")).toBe(false);

    const again = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(again.changed).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(afterRaw);
  });

  it("leaves an already-current JSON file byte-identical with no backup", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const current = packagedSkills("/new/release");
    const beforeRaw = JSON.stringify({ keep: "yes", skills: ["/user/skills", current] }, null, 2);
    await writeFile(configPath, beforeRaw);

    const result = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: current });
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toBe(beforeRaw);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });
});
