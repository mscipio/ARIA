import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Executor } from "../src/deps.js";

import {
  resolveCheckout,
  parsePluginSpecifiers,
  setup,
  update,
  runInCheckout,
  type CommandResult,
} from "../src/lifecycle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Create a mock executor from a response map.
 * Commands are keyed as "command arg1 arg2 ...".
 * Throws on unexpected commands unless `allowUnexpected` is set.
 */
function mockExecutor(
  responses: Record<string, { stdout?: string; stderr?: string; error?: string }>,
  allowUnexpected = false,
): Executor {
  return async (command: string, args: string[], _options?: { cwd?: string }) => {
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    if (!response) {
      if (allowUnexpected) {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    }
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

/**
 * Create a collector executor that records every invocation and returns
 * predefined responses. Throws on unexpected commands by default.
 */
function collectingExecutor(
  responses: Record<string, { stdout?: string; stderr?: string; error?: string; exitCode?: number; exitStdout?: string; exitStderr?: string }>,
): { executor: Executor; calls: Array<{ command: string; args: string[]; options?: { cwd?: string } }> } {
  const calls: Array<{ command: string; args: string[]; options?: { cwd?: string } }> = [];
  const executor: Executor = async (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    if (response.error) {
      const err = Object.assign(new Error(response.error), {
        code: response.exitCode,
        stdout: response.exitStdout,
        stderr: response.exitStderr,
      });
      // Only assign if defined so we don't pollute with undefined props
      const errRec = err as unknown as Record<string, unknown>;
      if (response.exitCode === undefined) delete errRec.code;
      if (response.exitStdout === undefined) delete errRec.stdout;
      if (response.exitStderr === undefined) delete errRec.stderr;
      throw err;
    }
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { executor, calls };
}

/** Build a fixture checkout directory with bin/aria.mjs. When `name` is given, the checkout is a subdirectory with that name inside the temp dir. */
async function makeFixtureCheckout(name?: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-lifecycle-"));
  tempDirs.push(root);
  const checkoutDir = name ? resolve(root, name) : root;
  if (name) await mkdir(checkoutDir, { recursive: true });
  const binDir = resolve(checkoutDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(resolve(binDir, "aria.mjs"), "#!/usr/bin/env node\nconsole.log('ok');");
  return checkoutDir;
}

/** Build a file:// URL for a fixture binary */
function binaryUrl(checkout: string): string {
  return pathToFileURL(resolve(checkout, "bin", "aria.mjs")).href;
}

/** Introspection output with the given plugin registered (real OpenCode format) */
function debugInfoWithPlugin(uri: string): string {
  return [
    "OpenCode Debug Info",
    "Version: 1.18.16",
    "plugins:",
    `  - ${uri}`,
    "Other:",
    "  value",
  ].join("\n");
}

/** Introspection output with plugins section but no entries */
function debugInfoEmptyPlugins(): string {
  return [
    "OpenCode Debug Info",
    "Version: 1.18.16",
    "plugins:",
    "Other:",
    "  value",
  ].join("\n");
}

/** Introspection output without any plugins section */
function debugInfoNoPluginsSection(): string {
  return [
    "OpenCode Debug Info",
    "Version: 1.18.16",
    "Other:",
    "  value",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// resolveCheckout
// ---------------------------------------------------------------------------

describe("resolveCheckout", () => {
  it("resolves the checkout directory from a binary URL", async () => {
    const checkout = await makeFixtureCheckout();
    const url = binaryUrl(checkout);
    const resolved = await resolveCheckout(url);
    expect(resolved).toBe(checkout);
  });

  it("works independent of process.cwd()", async () => {
    const checkout = await makeFixtureCheckout();
    const url = binaryUrl(checkout);

    // Call resolveCheckout while process.cwd() is somewhere unrelated
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const resolved = await resolveCheckout(url);
      expect(resolved).toBe(checkout);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("handles deep nesting in the binary path", async () => {
    const checkout = await makeFixtureCheckout();
    // Create a deeper nested structure
    const nestedBin = resolve(checkout, "nested", "bin");
    await mkdir(nestedBin, { recursive: true });
    await writeFile(resolve(nestedBin, "aria.mjs"), "code");
    // resolveCheckout goes binDir -> parent = checkout, regardless of nesting
    // from the task spec: parent of parent of bin/
    const url = pathToFileURL(resolve(nestedBin, "aria.mjs")).href;
    const resolved = await resolveCheckout(url);
    expect(resolved).toBe(resolve(checkout, "nested"));
  });
});

// ---------------------------------------------------------------------------
// parsePluginSpecifiers
// ---------------------------------------------------------------------------

describe("parsePluginSpecifiers", () => {
  it("extracts plugin specifiers from debug info output with - list markers", () => {
    const output = [
      "OpenCode Debug Info",
      "Version: 1.18.16",
      "plugins:",
      "  - file:///home/user/review-driven-code",
      "  - file:///another/plugin",
      "Other:",
      "  value",
    ].join("\n");

    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(true);
    expect(result.specifiers).toEqual(["file:///home/user/review-driven-code", "file:///another/plugin"]);
  });

  it("strips leading - list markers from specifier lines", () => {
    const output = [
      "plugins:",
      "  - file:///home/user/review-driven-code",
      "  - file:///other/plugin",
    ].join("\n");

    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(true);
    expect(result.specifiers).toEqual(["file:///home/user/review-driven-code", "file:///other/plugin"]);
  });

  it("handles plugins: header without leading whitespace", () => {
    const output = [
      "Plugins:",
      "  - file:///home/user/review-driven-code",
      "",
    ].join("\n");

    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(true);
    expect(result.specifiers).toEqual(["file:///home/user/review-driven-code"]);
  });

  it("returns recognized=false with empty specifiers when no plugins section exists", () => {
    const output = "OpenCode Debug Info\nVersion: 1.18.16\n";
    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(false);
    expect(result.specifiers).toEqual([]);
  });

  it("returns recognized=true with empty specifiers for empty plugins section", () => {
    const output = "plugins:\nOther:\n  value";
    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(true);
    expect(result.specifiers).toEqual([]);
  });

  it("is case-insensitive for the plugins header", () => {
    const output = "PLUGINS:\n  - file:///x\n";
    const result = parsePluginSpecifiers(output);
    expect(result.recognized).toBe(true);
    expect(result.specifiers).toEqual(["file:///x"]);
  });
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe("setup", () => {
  it("registers the plugin then runs depsSync on first setup", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return {
        ok: true,
        engram: { action: "ok" },
        context7: { action: "ok" },
        codegraph: { action: "ok" },
        health: undefined,
      };
    };

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { stdout: "plugin registered" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.registration.action).toBe("registered");
    expect(result.setup!.sync.ok).toBe(true);
    expect(depsSyncCalled).toBe(true);
  });

  it("reports already registered when plugin URI is in introspected plugins list", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return {
        ok: true,
        engram: { action: "ok" },
        context7: { action: "ok" },
        codegraph: { action: "ok" },
        health: undefined,
      };
    };

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoWithPlugin(uri) },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.registration.detail).toContain("introspection");
    expect(result.setup!.sync.ok).toBe(true);
    expect(depsSyncCalled).toBe(true);
  });

  it("detects already-registered plugin from same-indent - list entry in introspection output", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    // Same-indent output: the - list marker is at the same indent as "plugins:"
    const debugOutput = [
      "OpenCode Debug Info",
      "Version: 1.18.16",
      "plugins:",
      `- ${uri}`,
      "Other:",
      "  value",
    ].join("\n");

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return {
        ok: true,
        engram: { action: "ok" },
        context7: { action: "ok" },
        codegraph: { action: "ok" },
        health: undefined,
      };
    };

    // Only configure introspection — any registration attempt would fail
    const executor = mockExecutor({
      "opencode debug info": { stdout: debugOutput },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(true);
    expect(depsSyncCalled).toBe(true);
  });

  it("does not run depsSync when registration fails with a real error", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    };

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { error: "permission denied" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.action).toBe("failed");
    expect(depsSyncCalled).toBe(false);
  });

  it("falls back when introspection is unavailable and explicit duplicate is treated as already registered", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    };

    // Introspection fails, registration reports "already registered"
    const executor = mockExecutor({
      "opencode debug info": { error: "command not found" },
      [`opencode plugin ${uri} --global`]: { error: "Error: plugin already registered" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.registration.detail).toContain("compatibility fallback");
    expect(depsSyncCalled).toBe(true);
  });

  it("fails closed on fallback when registration error is not a duplicate", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    };

    const executor = mockExecutor({
      "opencode debug info": { error: "command not found" },
      [`opencode plugin ${uri} --global`]: { error: "unknown error" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("registration");
    expect(result.setup!.registration.action).toBe("failed");
    expect(depsSyncCalled).toBe(false);
  });

  it("falls back to compatibility when introspection output has no plugins section", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    };

    // Introspection returns output without a plugins section → unrecognized format
    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoNoPluginsSection() },
      // Fallback: attempt registration succeeds
      [`opencode plugin ${uri} --global`]: { stdout: "plugin registered via fallback" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(depsSyncCalled).toBe(true);
  });

  it("treats 'already configured' as already registered in compatibility fallback", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return { ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } };
    };

    // Introspection fails, registration reports "already configured"
    const executor = mockExecutor({
      "opencode debug info": { error: "command not found" },
      [`opencode plugin ${uri} --global`]: { error: "Error: plugin already configured" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.registration.detail).toContain("compatibility fallback");
    expect(depsSyncCalled).toBe(true);
  });

  it("reports sync failure when depsSync returns ok=false", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const mockDepsSync = async () => ({
      ok: false,
      engram: { action: "install-failed", error: "download failed" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    });

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoWithPlugin(uri) },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("sync");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(false);
    expect(result.setup!.sync.error).toBeDefined();
  });

  it("catches depsSync throwing and reports as sync error", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const mockDepsSync = async () => {
      throw new Error("unexpected crash");
    };

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoWithPlugin(uri) },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("sync");
    expect(result.setup!.sync.ok).toBe(false);
    expect(result.setup!.sync.error).toContain("unexpected crash");
  });

  it("resolves checkout with spaces in path (URI escaping)", async () => {
    const checkout = await makeFixtureCheckout("my project (v2)");
    const uri = pathToFileURL(checkout).href;
    expect(uri).toContain("file://");
    expect(uri).toContain("my%20project%20(v2)");

    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoWithPlugin(uri) },
    });

    const result = await setup(binaryUrl(checkout), executor, async () => ({
      ok: true,
      engram: { action: "ok" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    }));
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
  });

  // T010: recognized-empty plugins section falls through to compatibility fallback
  it("falls back to compatibility when plugins section is recognized but empty", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return {
        ok: true,
        engram: { action: "ok" },
        context7: { action: "ok" },
        codegraph: { action: "ok" },
        health: undefined,
      };
    };

    // Introspection returns an empty plugins section (recognized=true, specifiers=[])
    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { stdout: "plugin registered via fallback" },
    });

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(depsSyncCalled).toBe(true);
  });

  // T011: run() helper preserves stdout from error, enabling "already configured" detection
  it("preserves stdout from failed exec to detect already configured in compatibility fallback", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    let depsSyncCalled = false;
    const mockDepsSync = async () => {
      depsSyncCalled = true;
      return {
        ok: true,
        engram: { action: "ok" },
        context7: { action: "ok" },
        codegraph: { action: "ok" },
        health: undefined,
      };
    };

    // Custom executor: introspections fails, registration throws with stdout containing
    // "already configured" — tests that run() extracts stdout from the error object.
    const executor: Executor = async (command, args, _options) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "opencode debug info") {
        throw new Error("command not found: opencode");
      }
      if (key === `opencode plugin ${uri} --global`) {
        const err = Object.assign(new Error("Command failed: exit code 1"), {
          stdout: "plugin already configured",
          stderr: "some error detail",
        });
        throw err;
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await setup(binaryUrl(checkout), executor, mockDepsSync);

    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.registration.detail).toContain("compatibility fallback");
    expect(depsSyncCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setup return values for CLI formatting
// ---------------------------------------------------------------------------

describe("setup return values for CLI formatting", () => {
  it("first registration returns registered + sync ok", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { stdout: "plugin registered" },
    });
    const mockSync = async () => ({ ok: true, engram: { action: "synced" }, context7: { action: "configured" }, codegraph: { action: "synced" } });
    const result = await setup(binaryUrl(checkout), executor, mockSync);
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("registered");
    expect(result.setup!.sync.ok).toBe(true);
  });

  it("already registered via introspection", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });
    const mockSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });
    const result = await setup(binaryUrl(checkout), executor, mockSync);
    expect(result.ok).toBe(true);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(true);
  });

  it("registration failure blocks sync", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const executor = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { error: "permission denied" },
    });
    const mockSync = async () => { throw new Error("should not be called"); };
    const result = await setup(binaryUrl(checkout), executor, mockSync);
    expect(result.ok).toBe(false);
    expect(result.setup!.registration.action).toBe("failed");
    expect(result.setup!.sync.ok).toBe(false);
  });

  it("sync failure reported", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });
    const mockSync = async () => ({ ok: false, engram: { action: "failed", error: "timeout" }, context7: { action: "ok" }, codegraph: { action: "ok" } });
    const result = await setup(binaryUrl(checkout), executor, mockSync);
    expect(result.ok).toBe(false);
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setup optional model configuration phase
// ---------------------------------------------------------------------------

describe("setup optional model configuration phase", () => {
  const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

  it("default setup makes no discovery or prompt call", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const configureModelsFn = vi.fn(async () => {
      throw new Error("model configuration must not run");
    });
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });

    const result = await setup(binaryUrl(checkout), executor, okSync, { configureModelsFn });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.model).toBeUndefined();
    expect(configureModelsFn).not.toHaveBeenCalled();
  });

  it("does not run the optional phase when registration or sync fails", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const configureModelsFn = vi.fn(async () => ({ status: "configured" as const, message: "done" }));

    // Registration failure short-circuits before sync and configuration.
    const failingRegistration = mockExecutor({
      "opencode debug info": { stdout: debugInfoEmptyPlugins() },
      [`opencode plugin ${uri} --global`]: { error: "permission denied" },
    });
    const registrationResult = await setup(binaryUrl(checkout), failingRegistration, okSync, {
      configure: true,
      configureModelsFn,
    });
    expect(registrationResult.stage).toBe("registration");

    // Sync failure short-circuits before configuration.
    const failingSync = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });
    const syncResult = await setup(binaryUrl(checkout), failingSync, async () => ({
      ok: false,
      engram: { action: "install-failed", error: "download failed" },
      context7: { action: "ok" },
      codegraph: { action: "ok" },
    }), { configure: true, configureModelsFn });
    expect(syncResult.stage).toBe("sync");

    expect(configureModelsFn).not.toHaveBeenCalled();
  });

  it("runs the optional phase only after successful registration and sync", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;
    const worktree = "/tmp/example-worktree";

    const configureModelsFn = vi.fn(async () => ({ status: "configured" as const, message: "done" }));
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });

    const result = await setup(binaryUrl(checkout), executor, okSync, {
      configure: true,
      worktree,
      configureModelsFn,
    });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(true);
    expect(configureModelsFn).toHaveBeenCalledTimes(1);
    expect(configureModelsFn).toHaveBeenCalledWith(worktree, {});
    expect(result.setup!.model).toEqual({ status: "configured", message: "done" });
  });

  it("reports a failed model phase without regressing registration or sync invariants", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const configureModelsFn = vi.fn(async () => ({
      status: "failed" as const,
      message: "Model configuration could not be written; no changes were persisted.",
      error: "discovery down",
    }));
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });

    const result = await setup(binaryUrl(checkout), executor, okSync, { configure: true, configureModelsFn });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("model_configuration");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(true);
    expect(result.setup!.model?.status).toBe("failed");
    expect(result.setup!.model?.error).toBe("discovery down");
  });

  it("reports a thrown model-phase error as a distinct stage without regressing setup", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const configureModelsFn = vi.fn(async () => {
      throw new Error("unexpected crash");
    });
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });

    const result = await setup(binaryUrl(checkout), executor, okSync, { configure: true, configureModelsFn });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("model_configuration");
    expect(result.setup!.registration.action).toBe("already registered");
    expect(result.setup!.sync.ok).toBe(true);
    expect(result.setup!.model?.status).toBe("failed");
    expect(result.setup!.model?.error).toContain("unexpected crash");
  });

  it("treats a non-TTY skipped model phase as successful setup", async () => {
    const checkout = await makeFixtureCheckout();
    const uri = pathToFileURL(checkout).href;

    const configureModelsFn = vi.fn(async () => ({
      status: "skipped" as const,
      message: "stdin is not a terminal",
    }));
    const executor = mockExecutor({ "opencode debug info": { stdout: debugInfoWithPlugin(uri) } });

    const result = await setup(binaryUrl(checkout), executor, okSync, { configure: true, configureModelsFn });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.setup!.model?.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  it("completes update successfully: clean tree, upstream, pull, npm ci, handoff", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "Already up to date." },
      "npm ci --omit=dev": { stdout: "added 0 packages" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "sync ok", stderr: "" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
    expect(result.update!.git.ok).toBe(true);
    expect(result.update!.npm.ok).toBe(true);
    expect(result.update!.handoff.ok).toBe(true);
    expect(result.update!.handoff.exitCode).toBe(0);
    expect(result.update!.handoff.stdout).toBe("sync ok");

    // Verify handoff command and args
    const handoffCall = calls.find((c) => c.command === process.execPath);
    expect(handoffCall).toBeDefined();
    expect(handoffCall!.args).toEqual([binPath, "deps", "sync"]);
    expect(handoffCall!.options?.cwd).toBe(checkout);

    // Verify order: git → npm → handoff (handoff is last)
    const handoffIndex = calls.findIndex((c) => c.command === process.execPath);
    const npmIndex = calls.findIndex((c) => c.args.includes("ci"));
    expect(npmIndex).toBeLessThan(handoffIndex);
  });

  it("fails on dirty working tree (including untracked)", async () => {
    const checkout = await makeFixtureCheckout();

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "?? untracked-file.txt" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(result.update!.git.ok).toBe(false);
    expect(result.update!.git.error).toContain("dirty");

    // No downstream calls
    expect(calls.length).toBe(1);
  });

  it("fails on git status error", async () => {
    const checkout = await makeFixtureCheckout();

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { error: "not a git repository" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(calls.length).toBe(1);
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.npm.error).toBe("skipped");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.exitCode).toBeNull();
    expect(result.update!.handoff.error).toBe("skipped");
  });

  it("fails when no upstream is configured", async () => {
    const checkout = await makeFixtureCheckout();

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { error: "fatal: no upstream configured" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(result.update!.git.ok).toBe(false);
    expect(result.update!.git.error).toContain("no upstream configured");

    // Only git commands called
    const nonGitCalls = calls.filter((c) => c.command !== "git");
    expect(nonGitCalls.length).toBe(0);
  });

  it("fails on git pull --ff-only failure", async () => {
    const checkout = await makeFixtureCheckout();

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { error: "fatal: Not possible to fast-forward, aborting." },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_pull");
    expect(result.update!.git.ok).toBe(false);
    expect(result.update!.git.error).toContain("git pull --ff-only failed");

    // npm and handoff should be skipped
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.exitCode).toBeNull();

    const postPullCalls = calls.filter(
      (c) => c.command === "npm" || c.command === process.execPath,
    );
    expect(postPullCalls.length).toBe(0);
  });

  it("fails on npm ci failure", async () => {
    const checkout = await makeFixtureCheckout();

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "Updating abc..def" },
      "npm ci --omit=dev": { error: "npm ERR! code E404" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("npm");
    expect(result.update!.git.ok).toBe(true);
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.npm.error).toContain("npm ci --omit=dev failed");

    // Handoff should be skipped
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.exitCode).toBeNull();

    const handoffCalls = calls.filter((c) => c.command === process.execPath);
    expect(handoffCalls.length).toBe(0);
  });

  it("captures non-zero handoff exit status with stdout and stderr", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");

    const { executor, calls } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "Already up to date." },
      "npm ci --omit=dev": { stdout: "added 0 packages" },
      [`${process.execPath} ${binPath} deps sync`]: {
        error: "Command failed with exit code 1",
        exitCode: 1,
        exitStdout: "stdout from child",
        exitStderr: "stderr from child",
      },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("handoff");
    expect(result.update!.git.ok).toBe(true);
    expect(result.update!.npm.ok).toBe(true);
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.exitCode).toBe(1);
    expect(result.update!.handoff.stdout).toBe("stdout from child");
    expect(result.update!.handoff.stderr).toBe("stderr from child");
    expect(result.update!.handoff.error).toBe("stderr from child");

    // Verify handoff was called with correct args
    const handoffCall = calls.find((c) => c.command === process.execPath);
    expect(handoffCall).toBeDefined();
    expect(handoffCall!.args).toEqual([binPath, "deps", "sync"]);
    expect(handoffCall!.options?.cwd).toBe(checkout);

    // Verify handoff is last call
    const lastCall = calls[calls.length - 1];
    expect(lastCall!.command).toBe(process.execPath);
  });

  it("handles spawn errors (process fails to start)", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");

    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "Already up to date." },
      "npm ci --omit=dev": { stdout: "added 0 packages" },
      [`${process.execPath} ${binPath} deps sync`]: { error: "spawn ENOENT" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("handoff");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.error).toContain("spawn ENOENT");
  });

  it("preserves handoff stdout and stderr in success", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");

    const executor = mockExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "" },
      "npm ci --omit=dev": { stdout: "" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "engram: ok\ncontext7: ok\ncodegraph: ok", stderr: "" },
    });

    const result = await update(binaryUrl(checkout), executor);

    expect(result.ok).toBe(true);
    expect(result.update!.handoff.exitCode).toBe(0);
    expect(result.update!.handoff.stdout).toContain("engram: ok");
  });

  it("resolves update checkout with spaces in path", async () => {
    const checkout = await makeFixtureCheckout("my project (v2)");
    const binPath = resolve(checkout, "bin", "aria.mjs");
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "" },
      "npm ci --omit=dev": { stdout: "" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "ok", stderr: "" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(true);
    expect(result.update!.handoff.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update return values for CLI formatting
// ---------------------------------------------------------------------------

describe("update return values for CLI formatting", () => {
  it("success returns all stages ok with handoff stdout", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "Already up to date." },
      "npm ci --omit=dev": { stdout: "added 0 packages" },
      [`${process.execPath} ${binPath} deps sync`]: { stdout: "engram: ok\ncontext7: ok\ncodegraph: ok", stderr: "" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(true);
    expect(result.update!.git.ok).toBe(true);
    expect(result.update!.npm.ok).toBe(true);
    expect(result.update!.handoff.ok).toBe(true);
    expect(result.update!.handoff.exitCode).toBe(0);
    expect(result.update!.handoff.stdout).toContain("engram: ok");
  });

  it("git failure returns correct stage", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "M file.ts" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(result.update!.git.ok).toBe(false);
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.handoff.exitCode).toBeNull();
  });

  it("handoff failure returns exit code and stderr", async () => {
    const checkout = await makeFixtureCheckout();
    const binPath = resolve(checkout, "bin", "aria.mjs");
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { stdout: "" },
      "npm ci --omit=dev": { stdout: "" },
      [`${process.execPath} ${binPath} deps sync`]: { error: "Command failed: exit code 1\nstderr output" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("handoff");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.git.ok).toBe(true);
    expect(result.update!.npm.ok).toBe(true);
  });

  it("precondition failure returns git_precondition stage, not git", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "?? new-file.txt" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(result.stage).not.toBe("git");
    // npm and handoff remain skipped
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.npm.error).toBe("skipped");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.error).toBe("skipped");
  });

  it("pull failure returns git_pull stage, not git", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main" },
      "git pull --ff-only": { error: "fatal: cannot fast-forward" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_pull");
    expect(result.stage).not.toBe("git");
    // npm and handoff remain skipped
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.npm.error).toBe("skipped");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.error).toBe("skipped");
  });

  it("no-upstream failure returns git_precondition stage, not git", async () => {
    const checkout = await makeFixtureCheckout();
    const { executor } = collectingExecutor({
      "git status --porcelain": { stdout: "" },
      "git rev-parse --abbrev-ref @{upstream}": { error: "fatal: no upstream" },
    });
    const result = await update(binaryUrl(checkout), executor);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("git_precondition");
    expect(result.stage).not.toBe("git");
    // npm and handoff remain skipped
    expect(result.update!.npm.ok).toBe(false);
    expect(result.update!.npm.error).toBe("skipped");
    expect(result.update!.handoff.ok).toBe(false);
    expect(result.update!.handoff.error).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// runInCheckout — CommandResult behavior
// ---------------------------------------------------------------------------

describe("runInCheckout (run helper)", () => {
  it("returns CommandResult with exitCode 0 on success", async () => {
    const executor = mockExecutor({
      "echo hello": { stdout: "hello", stderr: "" },
    });

    const result: CommandResult = await runInCheckout(executor, "/tmp", "echo", "hello");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("trims stdout and stderr on success", async () => {
    const executor = mockExecutor({
      "echo hello": { stdout: "  hello  \n", stderr: "  warning  \n" },
    });

    const result = await runInCheckout(executor, "/tmp", "echo", "hello");

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warning");
  });

  it("captures numeric exit code on failure", async () => {
    const { executor } = collectingExecutor({
      "failing cmd": { error: "Command failed", exitCode: 1 },
    });

    const result = await runInCheckout(executor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("captures string numeric exit code on failure", async () => {
    // Create an executor that throws with code: "1" (string)
    const customExecutor: Executor = async (_command, _args, _options) => {
      const err = Object.assign(new Error("Command failed"), { code: "1" });
      throw err;
    };

    const result = await runInCheckout(customExecutor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("returns exitCode null for non-numeric spawn errors", async () => {
    const customExecutor: Executor = async (_command, _args, _options) => {
      const err = Object.assign(new Error("spawn ENOENT"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      throw err;
    };

    const result = await runInCheckout(customExecutor, "/tmp", "nonexistent", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("returns exitCode null when error has no code property", async () => {
    const executor = mockExecutor({
      "failing cmd": { error: "Command failed" },
    });

    const result = await runInCheckout(executor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("preserves stdout and stderr from error object on failure", async () => {
    const { executor } = collectingExecutor({
      "failing cmd": {
        error: "Command failed",
        exitCode: 2,
        exitStdout: "partial output",
        exitStderr: "error output",
      },
    });

    const result = await runInCheckout(executor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toBe("error output");
  });

  it("falls back stderr to error message when error has no stderr property", async () => {
    const customExecutor: Executor = async (_command, _args, _options) => {
      throw new Error("process crashed");
    };

    const result = await runInCheckout(customExecutor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("process crashed");
  });

  it("returns exitCode null when code is NaN", async () => {
    const customExecutor: Executor = async (_command, _args, _options) => {
      const err = Object.assign(new Error("NaN exit"), { code: NaN });
      throw err;
    };

    const result = await runInCheckout(customExecutor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("returns exitCode null when code is Infinity", async () => {
    const customExecutor: Executor = async (_command, _args, _options) => {
      const err = Object.assign(new Error("Infinity exit"), { code: Infinity });
      throw err;
    };

    const result = await runInCheckout(customExecutor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("returns exitCode null when code is fractional", async () => {
    const customExecutor: Executor = async (_command, _args, _options) => {
      const err = Object.assign(new Error("fractional exit"), { code: 1.5 });
      throw err;
    };

    const result = await runInCheckout(customExecutor, "/tmp", "failing", "cmd");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});
