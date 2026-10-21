import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { runDoctor } from "../src/doctor.js";
import { ROLES } from "../src/routes.js";
import { createUniqueScratchDir } from "../src/scratch.js";
import { defaultGlobalConfigPath, ensureAriaSetupConfigFile, ensureAriaSkillsRefreshFile } from "../src/setup-config.js";
import { isEphemeralNpxInstallRoot, resolveDurableAriaSkillsRoot, resolveGlobalAriaSkillsRoot } from "../src/skills.js";

const fixtures: string[] = [];
const restorers: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restorers.splice(0)) restore();
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const path = await createUniqueScratchDir(resolve(process.cwd()), "T001-durable-skills", "case");
  fixtures.push(path);
  return path;
}

async function dirs(root: string) {
  const ephemeral = join(root, "npm-cache", "_npx", "abc123", "node_modules", "aria");
  const global = join(root, "global", "lib", "node_modules", "aria");
  const stale = join(root, "old", "node_modules", "aria", "skills");
  await mkdir(join(ephemeral, "skills"), { recursive: true });
  await mkdir(join(global, "skills"), { recursive: true });
  await writeFile(join(global, "package.json"), JSON.stringify({ name: "aria", version: "1.3.3" }));
  await mkdir(stale, { recursive: true });
  const globalSkills = join(global, "skills");
  const resolver = () => globalSkills;
  return { ephemeral, global, globalSkills, ephemeralSkills: join(ephemeral, "skills"), stale, resolver };
}

async function configFile(path: string, skills: unknown): Promise<void> {
  await mkdir(join(path, "config"), { recursive: true });
  await writeFile(join(path, "config", "opencode.json"), JSON.stringify({ skills }, null, 2));
}

describe("T001 durable ARIA skills root", () => {
  it("selects verified global root for npx, refreshes stale paths in place, and preserves user registrations", async () => {
    const root = await fixture(); const d = await dirs(root);
    const expected = resolveDurableAriaSkillsRoot({ installedRoot: d.ephemeral, globalSkillsRootResolver: d.resolver });
    expect(expected).toBe(d.globalSkills);
    const path = join(root, "config", "opencode.json");
    await configFile(root, ["/user/skills", d.ephemeralSkills, "https://example.com/skills"]);
    const refreshed = await ensureAriaSkillsRefreshFile({ configPath: path, skillsRoot: expected });
    expect(refreshed.changed).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).skills).toEqual(["/user/skills", expected, "https://example.com/skills"]);
    const before = await readFile(path, "utf8");
    expect((await ensureAriaSkillsRefreshFile({ configPath: path, skillsRoot: expected })).changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps durable registration byte-identical across repeated setup and refresh", async () => {
    const root = await fixture(); const d = await dirs(root); const path = join(root, "cfg.json");
    await writeFile(path, JSON.stringify({ default_agent: "coder", experimental: { subagent_depth: 3 }, plugins: ["file:///aria"], skills: [d.globalSkills] }, null, 2));
    const setupOptions = { configPath: path, pluginUri: "file:///aria", skillsRoot: resolveDurableAriaSkillsRoot({ installedRoot: d.ephemeral, globalSkillsRootResolver: d.resolver }) };
    const first = await ensureAriaSetupConfigFile(setupOptions);
    const bytes = await readFile(path, "utf8");
    const second = await ensureAriaSetupConfigFile(setupOptions);
    expect(first.changed).toBe(false); expect(second.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await readdir(root)).filter((name) => name.startsWith("cfg.json.aria-backup-"))).toHaveLength(0);
    expect((await ensureAriaSkillsRefreshFile({ configPath: path, skillsRoot: setupOptions.skillsRoot })).changed).toBe(false);
    expect((await ensureAriaSkillsRefreshFile({ configPath: path, skillsRoot: setupOptions.skillsRoot })).changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("resolves checkout and no-global/decoy fallbacks without inventing global roots", async () => {
    const root = await fixture(); const d = await dirs(root); const checkout = join(root, "checkout");
    expect(resolveDurableAriaSkillsRoot({ installedRoot: checkout, globalSkillsRootResolver: d.resolver })).toBe(join(checkout, "skills"));
    const decoy = join(root, "decoy", "lib", "node_modules", "aria");
    await mkdir(join(decoy, "skills"), { recursive: true });
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "not-aria" }));
    expect(resolveDurableAriaSkillsRoot({ installedRoot: d.ephemeral, globalSkillsRootResolver: () => undefined })).toBe(d.ephemeralSkills);
    const oldPrefix = process.env.NPM_CONFIG_PREFIX;
    process.env.NPM_CONFIG_PREFIX = join(root, "decoy");
    try {
      expect(resolveGlobalAriaSkillsRoot()).toBeUndefined();
      expect(resolveDurableAriaSkillsRoot({ installedRoot: d.ephemeral })).toBe(d.ephemeralSkills);
    } finally {
      if (oldPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
      else process.env.NPM_CONFIG_PREFIX = oldPrefix;
    }
  });

  it("discovers a verified global package from NPM_CONFIG_PREFIX and requires the exact npx package root", async () => {
    const root = await fixture(); const d = await dirs(root);
    const oldPrefix = process.env.NPM_CONFIG_PREFIX;
    process.env.NPM_CONFIG_PREFIX = join(root, "global");
    try {
      expect(resolveGlobalAriaSkillsRoot()).toBe(resolve(d.globalSkills));
      expect(resolveDurableAriaSkillsRoot({ installedRoot: d.ephemeral })).toBe(resolve(d.globalSkills));
    } finally {
      if (oldPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
      else process.env.NPM_CONFIG_PREFIX = oldPrefix;
    }
    expect(isEphemeralNpxInstallRoot(d.ephemeral)).toBe(true);
    expect(isEphemeralNpxInstallRoot(join(root, "npm-cache", "_npx", "abc123", "node_modules", "unrelated", "checkout"))).toBe(false);
  });

  it("recognizes real symlink aliases without writes and migrates legacy aliases/stale owned paths", async () => {
    const root = await fixture(); const real = join(root, "real", "aria"); const alias = join(root, "alias");
    await mkdir(join(real, "skills"), { recursive: true }); await symlink(join(root, "real"), alias, "dir");
    const durable = join(real, "skills"); const aliasPath = join(alias, "aria", "skills");
    const path = join(root, "legacy.json");
    await writeFile(path, JSON.stringify({ skills: { paths: [aliasPath] } }));
    const migratedAlias = await ensureAriaSetupConfigFile({ configPath: path, pluginUri: "file:///aria", skillsRoot: durable });
    expect(migratedAlias.changed).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).skills).toEqual([aliasPath]);
    const stale = join(root, "old", "node_modules", "aria", "skills");
    await writeFile(path, JSON.stringify({ skills: { paths: [stale] } }));
    await ensureAriaSetupConfigFile({ configPath: path, pluginUri: "file:///aria", skillsRoot: durable });
    expect(JSON.parse(await readFile(path, "utf8")).skills).toEqual([durable]);
    for (const skills of [{}, { paths: [] }]) {
      await writeFile(path, JSON.stringify({ skills }));
      await ensureAriaSetupConfigFile({ configPath: path, pluginUri: "file:///aria", skillsRoot: durable });
      expect(JSON.parse(await readFile(path, "utf8")).skills).toEqual([durable]);
    }
  });

  it("keeps an explicit empty skills array fail-closed without changing the file", async () => {
    const root = await fixture(); const path = join(root, "empty.json");
    await writeFile(path, JSON.stringify({ skills: [] }));
    const before = await readFile(path, "utf8");
    await expect(ensureAriaSetupConfigFile({ configPath: path, pluginUri: "file:///aria", skillsRoot: join(root, "skills") })).rejects.toThrow(/explicitly empty/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("doctor reports stale path exactly without writing and passes the durable root", async () => {
    const root = await fixture(); const d = await dirs(root); const oldXdg = process.env.XDG_CONFIG_HOME;
    restorers.push(() => { if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; });
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    const configPath = defaultGlobalConfigPath();
    const options = {
      worktree: root, skillsRoot: d.globalSkills,
      executor: (async (command: string, args: string[]) => {
        const call = `${command} ${args.join(" ")}`;
        if (call === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
        if (call === "engram version") return { stdout: "engram 3.0.0", stderr: "" };
        if (call === "codegraph --version") return { stdout: "codegraph 1.0.0", stderr: "" };
        if (call === "opencode mcp list") return { stdout: "engram connected\ncontext7 connected\ncodegraph connected", stderr: "" };
        return { stdout: "", stderr: "" };
      }) as Executor,
      discovery: async () => ({ models: [{ id: "test/probe", providerID: "test", modelID: "probe", name: "Probe", variants: [], variantsObservable: true }] }),
    };
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(join(root, "aria.json"), JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }));
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, JSON.stringify({ skills: [d.stale] }));
    const before = await readFile(configPath, "utf8");
    let report = await runDoctor({ ...options, agentsDir: join(root, "agents") });
    let finding = report.findings.find((item) => item.area === "skills" && item.title === "configured skills");
    expect(finding?.severity).toBe("FAIL");
    expect(finding?.detail).toBe(`stale owned ARIA skills path ${d.stale} (expected ${d.globalSkills}; re-run setup or upgrade to refresh; nothing was changed)`);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect((await readdir(join(configPath, ".."))).filter((name) => name.includes("aria-backup-") && name.startsWith("opencode.json"))).toHaveLength(0);
    await writeFile(configPath, JSON.stringify({ skills: [d.globalSkills] }));
    const durableBytes = await readFile(configPath, "utf8");
    report = await runDoctor({ ...options, agentsDir: join(root, "agents") });
    finding = report.findings.find((item) => item.area === "skills" && item.title === "configured skills");
    expect(finding?.severity).toBe("PASS");
    expect(await readFile(configPath, "utf8")).toBe(durableBytes);
    const real = join(root, "real", "aria"); const alias = join(root, "alias");
    await mkdir(join(real, "skills"), { recursive: true }); await symlink(join(root, "real"), alias, "dir");
    const realSkills = resolve(real, "skills");
    const aliasSkills = join(alias, "aria", "skills");
    options.skillsRoot = realSkills;
    await writeFile(configPath, JSON.stringify({ skills: [aliasSkills] }));
    report = await runDoctor({ ...options, agentsDir: join(root, "agents") });
    finding = report.findings.find((item) => item.area === "skills" && item.title === "configured skills");
    expect(finding?.severity).toBe("PASS");
  });
});
