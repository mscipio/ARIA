import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ZOTPILOT_MCP_COMMAND } from "../src/bootstrap.js";
import type { Executor } from "../src/deps.js";
import { getPermissionsForRole } from "../src/permissions.js";
import {
  ZOTPILOT_BOOTSTRAP_EVIDENCE,
  classifyZotpilotOwnership,
  detectZotpilotOwnership,
  detectZotpilotState,
  ensureZotpilot,
  zotpilotUpgradeComponent,
} from "../src/zotpilot.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T014 ZotPilot lifecycle adapter: install-if-missing on a clean system via
// the demonstrated-safe ARIA-controlled path (exact pip `==` spec,
// user-scoped `--user` install, ARIA file-based V2 `mcp.servers.zotpilot`;
// NEVER a mutating `zotpilot` subcommand, `conda` mutation, bare pip without
// `--user`, or a legacy `mcp.zotpilot` write), OR update-if-outdated ONLY with
// established user-scoped ownership plus a positively identified newer exact
// release; every other installation stays report-only with zero mutation
// (T006 shared conda provenance, unknown provenance, legacy shapes).
// Shared: callable directly by `aria setup` and post-handoff by
// `aria upgrade` via `zotpilotUpgradeComponent`.
//
// Decision/command tests + isolated filesystem integration proving the
// intended (XDG-contained V2) vs legacy (`mcp.zotpilot`) paths without
// executing unsafe installers (all commands run through mock executors; all
// writes target isolated temp dirs via the explicit configDir seam; ownership
// home dirs are isolated temp dirs via the explicit homeDir seam).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t014-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "test root");
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  assertNotCallerGlobalPath(configDir, "configDir");
  return { root, configDir };
}

async function makeIsolatedHome(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t014-home-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "test home root");
  const homeDir = resolve(root, "home");
  await mkdir(homeDir, { recursive: true });
  assertNotCallerGlobalPath(homeDir, "homeDir");
  return homeDir;
}

/** Snapshot every file's bytes under a directory (recursive). */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        entries.set(path, await readFile(path, "utf8"));
      } catch {
        await walk(path);
      }
    }
  }
  await walk(root);
  return entries;
}

async function expectByteIdentical(root: string, before: Map<string, string>): Promise<void> {
  const after = await snapshotTree(root);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) {
    expect(after.get(path)).toBe(bytes);
  }
}

function expectZeroMutatingCalls(calls: string[]): void {
  expect(calls.some((call) => call.includes("pip install"))).toBe(false);
  expect(calls.some((call) => call.startsWith("zotpilot upgrade"))).toBe(false);
  expect(calls.some((call) => call.startsWith("zotpilot register"))).toBe(false);
  expect(calls.some((call) => call.startsWith("zotpilot install"))).toBe(false);
  expect(calls.some((call) => call.startsWith("conda "))).toBe(false);
}

describe("T014 lifecycle evidence + read-only detection + ownership gate", () => {
  it("links the demonstrated-safe T016 bootstrap path and classifies state plus user-scoped ownership", async () => {
    expect(ZOTPILOT_BOOTSTRAP_EVIDENCE?.missingPath).toBe("install");
    expect(ZOTPILOT_BOOTSTRAP_EVIDENCE?.installCommands.join(" ")).toMatch(/pip install --user/);
    expect(ZOTPILOT_BOOTSTRAP_EVIDENCE?.prohibitions.join(" ")).toMatch(/zotpilot upgrade/);

    // Clean system: no binary, no registration.
    const clean: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") throw new Error("not found");
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const { configDir } = await makeIsolatedConfigDir();
    await expect(detectZotpilotState(clean, configDir)).resolves.toMatchObject({
      found: false,
      version: null,
      registration: "absent",
    });

    // Existing binary + V2 registration.
    const existing: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const { configDir: v2Dir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(v2Dir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } } }),
    );
    await expect(detectZotpilotState(existing, v2Dir)).resolves.toMatchObject({
      found: true,
      version: "0.5.3",
      registration: "v2",
    });

    // Legacy registration without a binary still counts as existing.
    const missing: Executor = async () => {
      throw new Error("not found");
    };
    const { configDir: legacyDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(legacyDir, "opencode.json"),
      JSON.stringify({ mcp: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } }),
    );
    await expect(detectZotpilotState(missing, legacyDir)).resolves.toMatchObject({
      found: false,
      registration: "legacy",
    });

    // Ownership predicate: user site inside the home dir is user-scoped;
    // shared conda markers win even inside the home dir; system locations
    // outside the home dir are shared (never user-scoped on guess).
    const homeDir = await makeIsolatedHome();
    expect(classifyZotpilotOwnership(join(homeDir, ".local/lib/python3.12/site-packages"), homeDir)).toBe("user-scoped");
    expect(classifyZotpilotOwnership(join(homeDir, "miniforge3/envs/zotpilot/lib/python3.12/site-packages"), homeDir)).toBe("shared");
    expect(classifyZotpilotOwnership("/opt/miniforge3/envs/zotpilot/lib/python3.12/site-packages", homeDir)).toBe("shared");
    expect(classifyZotpilotOwnership("/usr/local/lib/python3.12/site-packages", homeDir)).toBe("shared");

    // Ownership probe reads only `pip show` Location (never mutates).
    const probeCalls: string[] = [];
    const probe: Executor = async (command, args) => {
      probeCalls.push(`${command} ${args.join(" ")}`);
      if (command === "python3" && args.join(" ") === "-m pip show zotpilot") {
        return { stdout: `Name: zotpilot\nVersion: 0.5.3\nLocation: ${join(homeDir, ".local/lib/python3.12/site-packages")}\n`, stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    await expect(detectZotpilotOwnership(probe, homeDir)).resolves.toMatchObject({ ownership: "user-scoped" });
    expectZeroMutatingCalls(probeCalls);
  });
});

describe("T014 clean-system install proceeds via the validated path", () => {
  it("installs a missing ZotPilot user-scoped via pip plus ARIA V2 registration, never a mutating subcommand", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: { servers: { other: { type: "remote", url: "https://example.invalid/mcp" } } },
        plugins: ["unrelated-plugin"],
      }),
    );
    const calls: string[] = [];
    let installed = false;
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.5.3, 0.5.2\n", stderr: "" };
      if (command === "python3" && args.includes("install")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("installed");
    expect(result.resultingVersion).toBe("0.5.3");
    expect(result.mutated).toBe(true);
    expect(result.mcpConnected).toBe(true);
    expect(result.ownership).toBe("user-scoped");
    // Demonstrated-safe path only: user-scoped pinned spec; never a mutating
    // zotpilot subcommand, conda mutation, bare pip without --user, or a
    // moving tag.
    expect(calls).toContain("python3 -m pip install --user zotpilot==0.5.3");
    expect(calls.some((call) => call.startsWith("zotpilot upgrade") || call.startsWith("zotpilot register") || call.startsWith("zotpilot install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("conda "))).toBe(false);
    expect(calls.some((call) => call.includes("@latest"))).toBe(false);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.zotpilot).toEqual({ type: "local", command: ZOTPILOT_MCP_COMMAND });
    // Intended V2 path only: no legacy shape, unrelated entries preserved.
    expect(written?.mcp?.zotpilot).toBeUndefined();
    expect(written?.mcp?.servers?.other).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });
});

describe("T014 shared-conda existing install stays report-only (T006 gate)", () => {
  it("reports installed 0.5.3 vs available 0.6.0 with zero mutation and byte-identical files", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: { servers: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } },
        plugins: ["unrelated-plugin"],
      }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.join(" ") === "-m pip show zotpilot") {
        return { stdout: "Name: zotpilot\nVersion: 0.5.3\nLocation: /opt/miniforge3/envs/zotpilot/lib/python3.12/site-packages\n", stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.6.0, 0.5.3\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("report-only");
    expect(result.installedVersion).toBe("0.5.3");
    expect(result.availableVersion).toBe("0.6.0");
    expect(result.resultingVersion).toBeNull();
    expect(result.mutated).toBe(false);
    expect(result.mcpConnected).toBe(true);
    expect(result.ownership).toBe("shared");
    // Read-only probes ran; no mutating installer did.
    expect(calls).toContain("python3 -m pip show zotpilot");
    expect(calls).toContain("python3 -m pip index versions zotpilot");
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T014 user-scoped outdated install updates via the demonstrated-safe mechanism", () => {
  it("updates 0.5.3 to 0.6.0 with user-scoped pip, preserving V2 byte-exact and the pinned permission policy", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    const userSite = join(homeDir, ".local/lib/python3.12/site-packages");
    const v2Entry = { type: "local", command: ["zotpilot", "mcp", "serve"] };
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: { servers: { zotpilot: v2Entry, other: { type: "remote", url: "https://example.invalid/mcp" } } },
        plugins: ["unrelated-plugin"],
      }),
    );
    const permissionsBefore = JSON.stringify(getPermissionsForRole("researcher"));
    const calls: string[] = [];
    let currentVersion = "0.5.3";
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: `zotpilot ${currentVersion}`, stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.join(" ") === "-m pip show zotpilot") {
        return { stdout: `Name: zotpilot\nVersion: ${currentVersion}\nLocation: ${userSite}\n`, stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.6.0, 0.5.3\n", stderr: "" };
      if (command === "python3" && args.includes("install")) {
        currentVersion = "0.6.0";
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("updated");
    expect(result.installedVersion).toBe("0.5.3");
    expect(result.resultingVersion).toBe("0.6.0");
    expect(result.availableVersion).toBe("0.6.0");
    expect(result.mutated).toBe(true);
    expect(result.mcpConnected).toBe(true);
    expect(result.ownership).toBe("user-scoped");
    // Demonstrated-safe mechanism only: user-scoped pinned spec; never a
    // mutating zotpilot subcommand, conda mutation, or bare pip.
    expect(calls).toContain("python3 -m pip install --user zotpilot==0.6.0");
    expect(calls.some((call) => call.startsWith("zotpilot upgrade") || call.startsWith("zotpilot register") || call.startsWith("zotpilot install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("conda "))).toBe(false);
    // Direct V2 registration preserved byte-exact; unrelated entries kept; no
    // legacy shape manufactured.
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.zotpilot).toEqual(v2Entry);
    expect(written?.mcp?.servers?.other).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(written?.mcp?.zotpilot).toBeUndefined();
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    // Pinned permission policy untouched (researcher keeps the exact
    // allow/ask ZotPilot tool split with no wildcard grant).
    expect(JSON.stringify(getPermissionsForRole("researcher"))).toBe(permissionsBefore);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });

  it("reports already-current with zero mutation when the user-scoped install equals the discovered release", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.join(" ") === "-m pip show zotpilot") {
        return { stdout: `Name: zotpilot\nVersion: 0.5.3\nLocation: ${join(homeDir, ".local/lib/python3.12/site-packages")}\n`, stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.5.3, 0.5.2\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("already-current");
    expect(result.installedVersion).toBe("0.5.3");
    expect(result.mutated).toBe(false);
    expect(result.ownership).toBe("user-scoped");
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T014 legacy registration is preserved report-only", () => {
  it("leaves the T006 legacy shape untouched and manufactures no V2 entry", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
          zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"], enabled: true },
        },
      }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expectZeroMutatingCalls(calls);
    // Legacy short-circuits before any ownership/discovery probe runs.
    expect(calls.some((call) => call.includes("pip show") || call.includes("pip index"))).toBe(false);
    await expectByteIdentical(root, before);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.zotpilot).toEqual({ type: "local", command: ["zotpilot", "mcp", "serve"], enabled: true });
    expect(written?.mcp?.servers?.zotpilot).toBeUndefined();
    expect(written?.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
  });
});

describe("T014 dual-file ambiguity fails closed", () => {
  it("mutates neither file and runs no pip installer", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["keep-json"] }));
    await writeFile(resolve(configDir, "opencode.jsonc"), JSON.stringify({ plugins: ["keep-jsonc"] }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") throw new Error("not found");
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot disconnected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.includes("pip "))).toBe(false);
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T014 install validation rolls the config snapshot back", () => {
  it("restores pre-install bytes when MCP connectivity is not established", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
    const before = await snapshotTree(root);
    let installed = false;
    const executor: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot disconnected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.5.3\n", stderr: "" };
      if (command === "python3" && args.includes("install")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureZotpilot(executor, { configDir, homeDir });

    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.mcpConnected).toBe(false);
    await expectByteIdentical(root, before);
  });
});

describe("T014 shared component wrapper", () => {
  it("completes setup-direct installs and skips report-only scopes post-handoff", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const homeDir = await makeIsolatedHome();
    assertNotCallerGlobalPath(configDir, "temp XDG global dir");
    let installed = false;
    const installExecutor: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.5.3\n", stderr: "" };
      if (command === "python3" && args.includes("install")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const target = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

    // Setup-direct shape (no handoff needed) completes the install.
    const direct = await ensureZotpilot(installExecutor, { configDir, homeDir });
    expect(direct.status).toBe("installed");

    // Post-handoff wrapper maps the same lifecycle outcome to completed.
    const { configDir: handoffDir } = await makeIsolatedConfigDir();
    let handoffInstalled = false;
    const handoffExecutor: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") {
        if (!handoffInstalled) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.5.3\n", stderr: "" };
      if (command === "python3" && args.includes("install")) {
        handoffInstalled = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const completed = await zotpilotUpgradeComponent({ target, executor: handoffExecutor, configDir: handoffDir });
    expect(completed).toMatchObject({ component: "zotpilot", status: "completed", mutated: true });

    // A shared-ownership existing install maps to skipped with zero mutation.
    const { configDir: existingDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(existingDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } } }),
    );
    const before = await snapshotTree(existingDir);
    const calls: string[] = [];
    const existingExecutor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "python3" && args.join(" ") === "-m pip show zotpilot") {
        return { stdout: "Name: zotpilot\nVersion: 0.5.3\nLocation: /opt/miniforge3/envs/zotpilot/lib/python3.12/site-packages\n", stderr: "" };
      }
      if (command === "python3" && args.includes("index")) return { stdout: "Available versions: 0.6.0, 0.5.3\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const skipped = await zotpilotUpgradeComponent({ target, executor: existingExecutor, configDir: existingDir });
    expect(skipped).toMatchObject({ component: "zotpilot", status: "skipped", mutated: false });
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(existingDir, before);
  });
});
