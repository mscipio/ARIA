import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getPackageRoot } from "../src/defaults";
import aria from "../src/index";
import {
  applyAriaSkillsToConfig,
  ARIA_SKILL_NAMES,
  getPackageSkillsRoot,
  validateAriaSkillsConfig,
} from "../src/skills";

/**
 * T007 single-source packaged skills (config `skills: string[]`).
 *
 * On-disk content contracts (frontmatter `name`/`owner`, method bounds) are
 * already owned by `tests/skills.test.ts` and `scripts/smoke-package.mjs`;
 * this suite covers only the T007 registration contract: the 21-skill
 * inventory sync, the single version-locked entry, idempotence (no dup),
 * the exact 2.0.23 dependency pin, no legacy keys, and no
 * `ctx.skill.transform` registration from the V2 plugin setup.
 */

const skillsRoot = resolve(process.cwd(), "skills");

describe("T007 packaged skills single source", () => {
  it("lists exactly the 21 packaged skills present as skills/*/SKILL.md", () => {
    const onDisk = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(onDisk).toHaveLength(21);
    expect(onDisk.filter((name) => name.startsWith("rdc-"))).toHaveLength(9);
    expect(onDisk.filter((name) => name.startsWith("aria-"))).toHaveLength(12);
    expect([...ARIA_SKILL_NAMES].sort()).toEqual(onDisk);
    for (const name of ARIA_SKILL_NAMES) {
      const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
      expect(text).toContain(`name: ${name}`);
    }
  });

  it("applies the single version-locked entry idempotently and preserves user entries", () => {
    const root = getPackageSkillsRoot();
    expect(root).toBe(join(getPackageRoot(), "skills"));
    expect(root.startsWith(getPackageRoot())).toBe(true);

    const fresh: { skills?: unknown } = {};
    expect(applyAriaSkillsToConfig(fresh)).toEqual({ added: true });
    expect(fresh.skills).toEqual([root]);
    expect(validateAriaSkillsConfig(fresh)).toEqual([]);

    // Re-applying registers nothing twice (no duplicate discovery).
    expect(applyAriaSkillsToConfig(fresh)).toEqual({ added: false });
    expect(fresh.skills).toEqual([root]);
    expect(validateAriaSkillsConfig(fresh)).toEqual([]);

    // Unrelated user entries keep their order ahead of the ARIA root.
    const user: { skills?: unknown } = { skills: ["/custom/skills"] };
    expect(applyAriaSkillsToConfig(user)).toEqual({ added: true });
    expect(user.skills).toEqual(["/custom/skills", root]);
    expect(validateAriaSkillsConfig(user)).toEqual([]);

    // Duplicate registration is reported, not silently kept.
    expect(validateAriaSkillsConfig({ skills: [root, root] })).toEqual([
      "ARIA package skills root is registered more than once (duplicate discovery)",
    ]);
    expect(validateAriaSkillsConfig({})).toEqual([
      "skills entry is missing (ARIA skills root is not registered)",
    ]);
  });

  it("pins the exact 2.0.23 plugin API the single source was chosen from", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    // Exact pin, no range: the Config.skills string[] + SkillDomain evidence
    // below was verified against this exact install, never a floating dev API.
    expect(packageJson.dependencies?.["@opencode/plugin"]).toBe("2.0.23");
  });

  it("never emits legacy skills.paths/urls keys and leaves legacy shapes to T008 migration", () => {
    const config: { skills?: unknown } = {};
    applyAriaSkillsToConfig(config);
    expect(Array.isArray(config.skills)).toBe(true);
    for (const entry of config.skills as unknown[]) {
      expect(typeof entry).toBe("string");
    }
    const shaped = config as { skills?: { paths?: unknown; urls?: unknown } };
    expect(shaped.skills).not.toHaveProperty("paths");
    expect(shaped.skills).not.toHaveProperty("urls");

    // Legacy V1 object shape is left untouched here (T008 owns migration
    // with backup) and flagged by validation, never silently rewritten.
    const legacy: { skills?: unknown } = { skills: { paths: ["/old/skills"] } };
    expect(applyAriaSkillsToConfig(legacy)).toEqual({ added: false });
    expect(legacy.skills).toEqual({ paths: ["/old/skills"] });
    expect(validateAriaSkillsConfig(legacy)).toEqual([
      "skills is not the canonical V2 string[] (legacy skills.paths/urls shape)",
    ]);
  });

  it("registers no ctx.skill.transform from the V2 plugin setup (config is the single home)", async () => {
    const skillTransform = vi.fn();
    const ctx = {
      location: { directory: process.cwd() },
      tool: { transform: async () => ({ dispose: async () => undefined }) },
      agent: { transform: async () => ({ dispose: async () => undefined }) },
      skill: { transform: skillTransform },
    };
    const cleanup = await aria.setup(ctx as never);
    expect(skillTransform).not.toHaveBeenCalled();
    await cleanup?.();
  });
});
