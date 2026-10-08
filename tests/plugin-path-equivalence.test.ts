import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { resolveCheckout, setup } from "../src/lifecycle.js";
import {
  applyAriaPluginToConfig,
  isSameLocalPluginIdentity,
  validateAriaSetupConfig,
} from "../src/setup-config.js";

/**
 * T008 narrow remediation: local absolute-path ≡ corresponding file:// URI.
 * One consistent rule (Node path/URL primitives, no string hacks); an
 * existing equivalent is preserved unchanged (never rewritten), no append
 * of an equivalent, validation counts equivalents as one identity and
 * rejects [path, file-uri] as duplicate (not exactly-once). Npm names,
 * remote URLs, and unrelated specifiers retain exact semantics; arbitrary
 * strings are never reinterpreted as paths; symlink/realpath behavior is
 * untouched (lexical only).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "aria-path-equiv-"));
  tempDirs.push(dir);
  return dir;
}

const PATH_FORM = "/opt/aria-checkout";
const URI_FORM = "file:///opt/aria-checkout";
const SKILLS_ROOT = "/opt/aria-checkout/skills";

function mockExecutor(
  responses: Record<string, { stdout?: string; stderr?: string; error?: string }>,
  calls?: Array<{ command: string; args: string[] }>,
): Executor {
  return async (command: string, args: string[]) => {
    calls?.push({ command, args });
    const response = responses[`${command} ${args.join(" ")}`];
    if (!response) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

async function fixtureCheckout(): Promise<{ checkout: string; binaryUrl: string; pluginUri: string; pathForm: string }> {
  const checkout = await tempDir();
  await mkdir(join(checkout, "bin"), { recursive: true });
  const binaryPath = join(checkout, "bin", "aria.mjs");
  await writeFile(binaryPath, "#!/usr/bin/env node\n");
  const binaryUrl = pathToFileURL(binaryPath).href;
  const canonical = await resolveCheckout(binaryUrl);
  const pluginUri = pathToFileURL(canonical).href;
  const pathForm = fileURLToPath(pluginUri);
  return { checkout: canonical, binaryUrl, pluginUri, pathForm };
}

const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

describe("T008 local path/file-URI equivalence (narrow)", () => {
  it("A. path entry satisfies a file-URI target: no append, preserved, valid", () => {
    const config: Record<string, unknown> = { plugins: [PATH_FORM] };
    expect(applyAriaPluginToConfig(config, URI_FORM)).toEqual({ added: false });
    expect(config.plugins).toEqual([PATH_FORM]);

    const full = {
      plugins: [PATH_FORM],
      skills: [SKILLS_ROOT],
      experimental: { subagent_depth: 3 },
    };
    expect(validateAriaSetupConfig(full, { pluginUri: URI_FORM, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("B. file-URI entry satisfies a path target: unchanged, valid", () => {
    const config: Record<string, unknown> = { plugins: [URI_FORM] };
    expect(applyAriaPluginToConfig(config, PATH_FORM)).toEqual({ added: false });
    expect(config.plugins).toEqual([URI_FORM]);

    const full = {
      plugins: [URI_FORM],
      skills: [SKILLS_ROOT],
      experimental: { subagent_depth: 3 },
    };
    expect(validateAriaSetupConfig(full, { pluginUri: PATH_FORM, skillsRoot: SKILLS_ROOT })).toEqual([]);
  });

  it("C. [path, file-URI] is a duplicate identity, not exactly-once", () => {
    const duplicated = {
      plugins: [PATH_FORM, URI_FORM],
      skills: [SKILLS_ROOT],
      experimental: { subagent_depth: 3 },
    };
    const issues = validateAriaSetupConfig(duplicated, { pluginUri: URI_FORM, skillsRoot: SKILLS_ROOT });
    expect(issues.join("\n")).toContain("more than once");
    expect(issues.length).toBeGreaterThan(0);

    // Same in the opposite target direction.
    const reversed = validateAriaSetupConfig(duplicated, { pluginUri: PATH_FORM, skillsRoot: SKILLS_ROOT });
    expect(reversed.join("\n")).toContain("more than once");

    // Applying over a duplicate never appends a third entry.
    const config: Record<string, unknown> = { plugins: [PATH_FORM, URI_FORM] };
    expect(applyAriaPluginToConfig(config, URI_FORM)).toEqual({ added: false });
    expect(config.plugins).toEqual([PATH_FORM, URI_FORM]);
  });

  it("D. npm names and unrelated URLs retain exact semantics", () => {
    expect(isSameLocalPluginIdentity("my-plugin", PATH_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("my-plugin", URI_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("@scope/pkg", URI_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("https://example.com/plugin", URI_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("github:owner/repo", URI_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("./relative", PATH_FORM)).toBe(false);
    expect(isSameLocalPluginIdentity("../relative", URI_FORM)).toBe(false);
    // Exact equality is preserved for non-local specifiers.
    expect(isSameLocalPluginIdentity("my-plugin", "my-plugin")).toBe(true);

    // An unrelated entry is preserved and does not satisfy the ARIA target.
    const config: Record<string, unknown> = { plugins: ["my-plugin"] };
    expect(applyAriaPluginToConfig(config, URI_FORM)).toEqual({ added: true });
    expect(config.plugins).toEqual(["my-plugin", URI_FORM]);

    const missing = validateAriaSetupConfig(
      { plugins: ["my-plugin"], skills: [SKILLS_ROOT], experimental: { subagent_depth: 3 } },
      { pluginUri: URI_FORM, skillsRoot: SKILLS_ROOT },
    );
    expect(missing.join("\n")).toContain("not registered");
  });

  it("A(file). setup with path-form config + path SOURCE skips CLI and writes nothing", async () => {
    const { binaryUrl, pluginUri, pathForm } = await fixtureCheckout();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const agentsDir = join(dir, "agents");
    const worktree = await tempDir();
    await writeFile(
      configPath,
      JSON.stringify({
        default_agent: "coder",
        plugins: [pathForm],
        skills: [SKILLS_ROOT],
        experimental: { subagent_depth: 3 },
      }),
    );
    // Pre-install the 11 managed files so the repeat reports written=0.
    const preCalls: Array<{ command: string; args: string[] }> = [];
    const pre = mockExecutor(
      {
        "opencode plugin list": {
          stdout: ["ID  VERSION  SOURCE", `aria  local  ${pathForm}`].join("\n"),
        },
      },
      preCalls,
    );
    const first = await setup(binaryUrl, pre, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(first.ok).toBe(true);
    expect(first.setup!.registration.action).toBe("already registered");
    expect(first.setup!.config!.changed).toBe(false);
    expect(first.setup!.agents!.written).toBe(11);
    // No CLI mutation beyond the read-only list.
    expect(preCalls.map((c) => c.args.join(" "))).toEqual(["plugin list"]);
    const stored = JSON.parse(await readFile(configPath, "utf8")) as { plugins?: unknown };
    expect(stored.plugins).toEqual([pathForm]);

    // Repeat is fully idempotent: no CLI mutation, no config write, 0/11.
    const repeatCalls: Array<{ command: string; args: string[] }> = [];
    const repeatExecutor = mockExecutor(
      {
        "opencode plugin list": {
          stdout: ["ID  VERSION  SOURCE", `aria  local  ${pathForm}`].join("\n"),
        },
      },
      repeatCalls,
    );
    const second = await setup(binaryUrl, repeatExecutor, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(second.ok).toBe(true);
    expect(second.setup!.registration.action).toBe("already registered");
    expect(second.setup!.config!.changed).toBe(false);
    expect(second.setup!.agents!.written).toBe(0);
    expect(second.setup!.agents!.unchanged).toBe(11);
    expect(repeatCalls.map((c) => c.args.join(" "))).toEqual(["plugin list"]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(JSON.parse(await readFile(configPath, "utf8")));
    expect(pluginUri.startsWith("file://")).toBe(true);
  });

  it("B(file). file-URI SOURCE is also already-registered with no config rewrite", async () => {
    const { binaryUrl, pluginUri, pathForm } = await fixtureCheckout();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({
        default_agent: "coder",
        plugins: [pluginUri],
        skills: [SKILLS_ROOT],
        experimental: { subagent_depth: 3 },
      }),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const executor = mockExecutor(
      {
        "opencode plugin list": {
          stdout: ["ID  VERSION  SOURCE", `aria  local  ${pathForm}`].join("\n"),
        },
      },
      calls,
    );
    const result = await setup(binaryUrl, executor, okSync, {
      worktree: await tempDir(),
      files: { globalConfigPath: configPath, agentsDir: join(dir, "agents"), skillsRoot: SKILLS_ROOT },
    });
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.config!.changed).toBe(false);
    expect(calls.map((c) => c.args.join(" "))).toEqual(["plugin list"]);
    const stored = JSON.parse(await readFile(configPath, "utf8")) as { plugins?: unknown };
    expect(stored.plugins).toEqual([pluginUri]);
  });

  it("E. pristine then repeat: written=0 unchanged=11, no duplicate CLI/config mutation", async () => {
    const { binaryUrl, pluginUri, pathForm } = await fixtureCheckout();
    const dir = await tempDir();
    const configPath = join(dir, "opencode.json");
    const agentsDir = join(dir, "agents");
    const worktree = await tempDir();

    const firstCalls: Array<{ command: string; args: string[] }> = [];
    const firstExecutor = mockExecutor(
      {
        "opencode plugin list": { stdout: "No plugins found" },
        [`opencode plugin add ${pathForm}`]: { stdout: "installed" },
      },
      firstCalls,
    );
    const first = await setup(binaryUrl, firstExecutor, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(first.ok).toBe(true);
    expect(first.setup!.agents!.written).toBe(11);

    const secondCalls: Array<{ command: string; args: string[] }> = [];
    const secondExecutor = mockExecutor(
      {
        "opencode plugin list": {
          stdout: ["ID  VERSION  SOURCE", `aria  local  ${pathForm}`].join("\n"),
        },
      },
      secondCalls,
    );
    const second = await setup(binaryUrl, secondExecutor, okSync, {
      worktree,
      files: { globalConfigPath: configPath, agentsDir, skillsRoot: SKILLS_ROOT },
    });
    expect(second.ok).toBe(true);
    expect(second.setup!.registration.action).toBe("already registered");
    expect(second.setup!.config!.changed).toBe(false);
    expect(second.setup!.agents!.written).toBe(0);
    expect(second.setup!.agents!.unchanged).toBe(11);
    expect(secondCalls.map((c) => c.args.join(" "))).toEqual(["plugin list"]);
    const stored = JSON.parse(await readFile(configPath, "utf8")) as { plugins?: unknown[] };
    expect(stored.plugins?.filter((e) => typeof e === "string" && isSameLocalPluginIdentity(e, pluginUri))).toHaveLength(1);
  });
});
