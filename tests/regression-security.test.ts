import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateAgentFiles,
  installAgentFiles,
  isAriaManaged,
  parseManagedHeader,
} from "../src/agents";
import aria from "../src/index";
import { resolveAriaConfig } from "../src/overrides";
import { validateAriaSetupConfig, rollbackSetupConfigFile } from "../src/setup-config";

/**
 * T009 aggregate: smallest gap-closing representatives not already owned by
 * T002-T008 focused suites. Each `it` below covers one security boundary
 * that had no representative test; bullets already covered (permission
 * evaluation, plan-tool execute/CAS/root, skills applier, setup
 * backup/rollback) are referenced, not duplicated. Generation bytes are the
 * aggregate seam: focused suites evaluate the canonical source, here we prove
 * the shipped files preserve the same boundaries.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-regression-"));
  tempDirs.push(root);
  return root;
}

describe("T009 regression/security aggregate", () => {
  it("shipped agent bytes preserve last-match ordering, .env, external, subagent, explicit MCP", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const files = generateAgentFiles(resolved, "0.6.0");
    const impl = files.implementer;
    const coder = files.coder;
    const researcher = files.researcher;

    // Last-match ordering on shipped bytes: fallback first, specifics after.
    expect(impl.indexOf('action: "*"')).toBeLessThan(impl.indexOf('action: "read"'));
    // .env ask gates precede the example allow (read + edit for implementer).
    expect(impl.indexOf('"*.env"')).toBeLessThan(impl.indexOf('"*.env.example"'));
    // External directories stay denied by default in shipped files.
    expect(impl).toContain('"external_directory"');
    expect(impl).toContain("effect: deny");
    expect(coder).toContain('"external_directory"');
    // Implementer shell: broad allow first, deny-list after so denies prevail.
    const shellAllow = impl.indexOf('action: "shell"');
    expect(shellAllow).toBeGreaterThanOrEqual(0);
    expect(shellAllow).toBeLessThan(impl.indexOf('"rm *"'));
    // Coder delegation: deny-all before the 9 specialist allows.
    expect(coder.indexOf('resource: "*"')).toBeLessThan(coder.indexOf('resource: "explorer"'));
    expect(coder).toContain('resource: "scientist"');
    expect(coder).not.toContain('resource: "writer"');
    // Coder skill: broad allow before the adversarial deny so deny prevails.
    expect(coder.indexOf('resource: "*"')).toBeLessThan(coder.indexOf('"rdc-adversarial-review"'));
    // Explicit MCP actions: researcher carries explicit ZotPilot IDs, no wildcard grant.
    expect(researcher).toContain('"zotpilot_search_papers"');
    expect(researcher).toContain('"zotpilot_create_note"');
    expect(researcher).not.toContain('"zotpilot_*"');
    expect(researcher).not.toContain('"engram_*"');
  });

  it("invalid project model overlays fail closed via setup with no agent patch", async () => {
    const root = await worktree();
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({ agents: { planner: { model: "bad-no-slash" } } }),
    );
    const toolTransform = vi.fn(async () => ({ dispose: async () => undefined }));
    const agentTransform = vi.fn(async () => ({ dispose: async () => undefined }));
    await expect(
      aria.setup({
        location: { project: { directory: root } },
        tool: { transform: toolTransform },
        agent: { transform: agentTransform },
      } as never),
    ).rejects.toThrow();
    // Fail-closed: the narrow patch never ran, and no files were written.
    expect(agentTransform).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["opencode.json"]);
  });

  it("tampered managed files regenerate with ownership intact and user files untouched", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");
    await mkdir(dir, { recursive: true });
    await installAgentFiles(resolved, { dir, version: "0.6.0" });
    await writeFile(join(dir, "my-helper.md"), "user content\n");

    // Hand-edit a managed file after generation (header intact, body changed).
    const managed = await readFile(join(dir, "coder.md"), "utf8");
    expect(isAriaManaged(managed)).toBe(true);
    await writeFile(join(dir, "coder.md"), `${managed}\n# tamper\n`);

    const second = await installAgentFiles(resolved, { dir, version: "0.6.0" });
    expect(second.tampered).toContain("coder");
    expect(second.written).toContain("coder");
    expect(second.backups.coder).toBeUndefined();
    expect(await readFile(join(dir, "my-helper.md"), "utf8")).toBe("user content\n");

    // Ownership probe rejects forged headers without weakening the boundary.
    expect(parseManagedHeader("unrelated user agent")).toBeNull();
    expect(parseManagedHeader("# ARIA-managed agent definition\n# aria-version: \n# aria-checksum: abc")).toBeNull();
    expect(
      parseManagedHeader(
        "# ARIA-managed agent definition\n# aria-version: 0.6.0\n# aria-checksum: not-hex",
      ),
    ).toBeNull();
  });

  it("plugin cleanup is idempotent and reload re-registers without extra agent work", async () => {
    const root = await worktree();
    const toolTransform = vi.fn(async (callback: (editor: { add: (tool: never) => void }) => void) => {
      callback({ add: () => undefined });
      return { dispose: async () => undefined };
    });
    const agentTransform = vi.fn(async () => ({ dispose: async () => undefined }));
    const ctx = {
      location: { directory: root },
      tool: { transform: toolTransform },
      agent: { transform: agentTransform },
    } as never;

    const cleanupFirst = await aria.setup(ctx);
    expect(typeof cleanupFirst).toBe("function");
    expect(toolTransform).toHaveBeenCalledTimes(1);
    // No overlay means no agent patch.
    expect(agentTransform).not.toHaveBeenCalled();
    await cleanupFirst?.();
    // Second cleanup call never throws (idempotent no-op).
    await cleanupFirst?.();

    const cleanupSecond = await aria.setup(ctx);
    expect(toolTransform).toHaveBeenCalledTimes(2);
    expect(agentTransform).not.toHaveBeenCalled();
    await cleanupSecond?.();
  });

  it("project overlays stay transform-only with skills as the single source", async () => {
    const root = await worktree();
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({ agents: { planner: { model: "openai/gpt-5.4-mini#high" } } }),
    );
    const toolTransform = vi.fn(async (callback: (editor: { add: (tool: never) => void }) => void) => {
      callback({ add: () => undefined });
      return { dispose: async () => undefined };
    });
    const agentTransform = vi.fn(async () => ({ dispose: async () => undefined }));
    const skillTransform = vi.fn();
    const cleanup = await aria.setup({
      location: { project: { directory: root } },
      tool: { transform: toolTransform },
      agent: { transform: agentTransform },
      skill: { transform: skillTransform },
    } as never);
    expect(toolTransform).toHaveBeenCalledTimes(1);
    expect(agentTransform).toHaveBeenCalledTimes(1);
    // Config skills[] stays the single home: no runtime skill registration.
    expect(skillTransform).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["opencode.json"]);
    await cleanup?.();
  });

  it("setup validation flags duplicate plugin registration and rollback ignores no-change state", async () => {
    const pluginUri = "file:///opt/aria-checkout";
    const skillsRoot = "/opt/aria-checkout/skills";
    const duplicated = {
      plugins: [pluginUri, pluginUri],
      skills: [skillsRoot],
      experimental: { subagent_depth: 3 },
    };
    expect(
      validateAriaSetupConfig(duplicated, { pluginUri, skillsRoot }).join("\n"),
    ).toContain("more than once");

    const dir = await worktree();
    const configPath = join(dir, "opencode.json");
    const original = JSON.stringify({ keep: true }, null, 2);
    await writeFile(configPath, original);
    const { ensureAriaSetupConfigFile } = await import("../src/setup-config");
    const changed = await ensureAriaSetupConfigFile({ configPath, pluginUri, skillsRoot });
    expect(changed.changed).toBe(true);
    const settled = await ensureAriaSetupConfigFile({ configPath, pluginUri, skillsRoot });
    expect(settled.changed).toBe(false);
    const bytesBefore = await readFile(configPath, "utf8");
    await rollbackSetupConfigFile(configPath, settled);
    expect(await readFile(configPath, "utf8")).toBe(bytesBefore);
  });
});
