import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CODEGRAPH_MCP_COMMAND } from "../src/bootstrap.js";
import {
  CODEGRAPH_BOOTSTRAP_EVIDENCE,
  codegraphUpgradeComponent,
  detectCodegraphState,
  ensureCodegraph,
} from "../src/codegraph.js";
import type { Executor } from "../src/deps.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T013 CodeGraph lifecycle adapter: install-if-missing on a clean system via
// the demonstrated-safe ARIA-controlled path (exact npm spec, binary-only
// install, ARIA file-based V2 `mcp.servers.codegraph`; NEVER the upstream
// `codegraph install --target` legacy writer), then configure/normalize +
// validate. Every existing/ambiguous installation stays report-only with zero
// mutation (T006: no positive ownership/version evidence, no demonstrated-
// safe update). Shared: callable directly by `aria setup` and post-handoff
// by `aria upgrade` via `codegraphUpgradeComponent`.
//
// Decision/command tests + isolated filesystem integration proving the
// intended (XDG-contained V2) vs legacy (`mcp.codegraph`) paths without
// executing unsafe installers (all commands run through mock executors; all
// writes target isolated temp dirs via the explicit configDir seam).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t013-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "test root");
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  assertNotCallerGlobalPath(configDir, "configDir");
  return { root, configDir };
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
  expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
  expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
  expect(calls).not.toContain("codegraph upgrade");
}

describe("T013 lifecycle evidence + read-only detection", () => {
  it("links the demonstrated-safe T016 bootstrap path and classifies installed state", async () => {
    expect(CODEGRAPH_BOOTSTRAP_EVIDENCE?.missingPath).toBe("install");
    expect(CODEGRAPH_BOOTSTRAP_EVIDENCE?.installCommands.join(" ")).toMatch(/npm install -g/);
    expect(CODEGRAPH_BOOTSTRAP_EVIDENCE?.prohibitions.join(" ")).toMatch(/codegraph install --target/);

    // Clean system: no binary, no registration.
    const clean: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "--version") throw new Error("not found");
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const { configDir } = await makeIsolatedConfigDir();
    await expect(detectCodegraphState(clean, configDir)).resolves.toMatchObject({
      found: false,
      version: null,
      registration: "absent",
    });

    // Existing binary + V2 registration.
    const existing: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const { configDir: v2Dir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(v2Dir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] } } } }),
    );
    await expect(detectCodegraphState(existing, v2Dir)).resolves.toMatchObject({
      found: true,
      version: "1.3.1",
      registration: "v2",
    });

    // Legacy registration without a binary still counts as existing.
    const missing: Executor = async () => {
      throw new Error("not found");
    };
    const { configDir: legacyDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(legacyDir, "opencode.json"),
      JSON.stringify({ mcp: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] } } }),
    );
    await expect(detectCodegraphState(missing, legacyDir)).resolves.toMatchObject({
      found: false,
      registration: "legacy",
    });
  });
});

describe("T013 clean-system install proceeds via the validated path", () => {
  it("installs a missing CodeGraph via the exact npm spec plus ARIA V2 registration, never the upstream reconciler", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
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
      if (command === "codegraph" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      if (command === "npm" && args[0] === "install") {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("installed");
    expect(result.resultingVersion).toBe("1.4.0");
    expect(result.mutated).toBe(true);
    expect(result.mcpConnected).toBe(true);
    // Demonstrated-safe path only: exact pinned spec; never the upstream
    // reconciler, the unpinned upgrader, or a moving tag.
    expect(calls).toContain("npm install -g @colbymchenry/codegraph@1.4.0");
    expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
    expect(calls).not.toContain("codegraph upgrade");
    expect(calls.some((call) => call.includes("@latest"))).toBe(false);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.codegraph).toEqual({ type: "local", command: CODEGRAPH_MCP_COMMAND });
    // Intended V2 path only: no legacy shape, unrelated entries preserved.
    expect(written?.mcp?.codegraph).toBeUndefined();
    expect(written?.mcp?.servers?.other).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });
});

describe("T013 outdated existing install stays report-only (no demonstrated-safe update)", () => {
  it("reports installed 1.3.1 vs available 1.4.0 with zero mutation and byte-identical files", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: { servers: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] } } },
        plugins: ["unrelated-plugin"],
      }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("report-only");
    expect(result.installedVersion).toBe("1.3.1");
    expect(result.availableVersion).toBe("1.4.0");
    expect(result.resultingVersion).toBeNull();
    expect(result.mutated).toBe(false);
    expect(result.mcpConnected).toBe(true);
    // Read-only discovery ran; no mutating installer did.
    expect(calls).toContain("npm view @colbymchenry/codegraph version");
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T013 legacy registration is preserved report-only", () => {
  it("leaves the T006 legacy shape untouched and manufactures no V2 entry", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
          codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true },
        },
      }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.codegraph).toEqual({ type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true });
    expect(written?.mcp?.servers?.codegraph).toBeUndefined();
    expect(written?.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
  });

  it("leaves a registration-only existing install (no binary) report-only with no npm calls", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] } } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") throw new Error("not found");
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph disconnected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("report-only");
    expect(result.installedVersion).toBeNull();
    expect(result.mutated).toBe(false);
    expect(result.mcpConnected).toBe(false);
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T013 dual-file ambiguity fails closed", () => {
  it("mutates neither file and runs no npm installer", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["keep-json"] }));
    await writeFile(resolve(configDir, "opencode.jsonc"), JSON.stringify({ plugins: ["keep-jsonc"] }));
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") throw new Error("not found");
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph disconnected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(root, before);
  });
});

describe("T013 install validation rolls the config snapshot back", () => {
  it("restores pre-install bytes when MCP connectivity is not established", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
    const before = await snapshotTree(root);
    let installed = false;
    const executor: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph disconnected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      if (command === "npm" && args[0] === "install") {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await ensureCodegraph(executor, { configDir });

    expect(result.status).toBe("validation-failed");
    expect(result.mutated).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.mcpConnected).toBe(false);
    await expectByteIdentical(root, before);
  });
});

describe("T013 shared component wrapper", () => {
  it("completes setup-direct installs and skips report-only scopes post-handoff", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    assertNotCallerGlobalPath(configDir, "temp XDG global dir");
    let installed = false;
    const installExecutor: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      if (command === "npm" && args[0] === "install") {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const target = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

    // Setup-direct shape (no handoff needed) completes the install.
    const direct = await ensureCodegraph(installExecutor, { configDir });
    expect(direct.status).toBe("installed");

    // Post-handoff wrapper maps the same lifecycle outcome to completed.
    const { configDir: handoffDir } = await makeIsolatedConfigDir();
    let handoffInstalled = false;
    const handoffExecutor: Executor = async (command, args) => {
      if (command === "codegraph" && args[0] === "--version") {
        if (!handoffInstalled) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      if (command === "npm" && args[0] === "install") {
        handoffInstalled = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const completed = await codegraphUpgradeComponent({ target, executor: handoffExecutor, configDir: handoffDir });
    expect(completed).toMatchObject({ component: "codegraph", status: "completed", mutated: true });

    // An existing install maps to skipped with zero mutation.
    const { configDir: existingDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(existingDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] } } } }),
    );
    const before = await snapshotTree(existingDir);
    const calls: string[] = [];
    const existingExecutor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const skipped = await codegraphUpgradeComponent({ target, executor: existingExecutor, configDir: existingDir });
    expect(skipped).toMatchObject({ component: "codegraph", status: "skipped", mutated: false });
    expectZeroMutatingCalls(calls);
    await expectByteIdentical(existingDir, before);
  });
});
