import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BOOTSTRAP_EVIDENCE,
  CODEGRAPH_MCP_COMMAND,
  ZOTPILOT_MCP_COMMAND,
  installCodegraphIfMissing,
  installQuotaIfMissing,
  installZotpilotIfMissing,
} from "../src/bootstrap.js";
import { depsSync, type Executor } from "../src/deps.js";
import { QUOTA_PLUGIN_ID } from "../src/quota.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T016 bootstrap lifecycle evidence extension.
//
// Decision/command tests + isolated filesystem integration proving intended
// (XDG-contained V2 `mcp.servers.*`) vs legacy (`mcp.<name>`) paths without
// executing unsafe installers (all commands run through mock executors; all
// writes target isolated temp dirs; per-test temp XDG roots where the native
// installer honors only the env-derived root).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t016-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "test root");
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  assertNotCallerGlobalPath(configDir, "configDir");
  return { root, configDir };
}

/** Run with a per-test temp XDG_CONFIG_HOME (native-installer root seam); restores afterwards. */
async function withTempXdg<T>(action: (xdgConfigHome: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t016-xdg-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp XDG root");
  const xdgConfigHome = resolve(root, "config");
  await mkdir(resolve(xdgConfigHome, "opencode"), { recursive: true });
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    return await action(xdgConfigHome);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
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

function quotaListRow(version: string, source: string): string {
  return `${QUOTA_PLUGIN_ID}  ${version}  ${source}`;
}

const PLUGIN_HEADER = "ID  VERSION  SOURCE";

describe("T016 evidence record", () => {
  it("covers Engram, CodeGraph, ZotPilot, and Quota with a demonstrated-safe missing-install path each (no version database)", () => {
    expect(BOOTSTRAP_EVIDENCE.map((entry) => entry.component).sort()).toEqual(["codegraph", "engram", "quota", "zotpilot"]);
    for (const entry of BOOTSTRAP_EVIDENCE) {
      expect(entry.missingPath).toBe("install");
      expect(entry.discovery.length).toBeGreaterThan(0);
      expect(entry.installCommands.length).toBeGreaterThan(0);
      expect(entry.existingGate.length).toBeGreaterThan(0);
      expect(entry.prohibitions.length).toBeGreaterThan(0);
    }
    // No compatibility database: discovery is always a live package-manager mechanism.
    for (const entry of BOOTSTRAP_EVIDENCE) {
      expect(entry.discovery).toMatch(/npm view|pip index|GitHub releases|brew/i);
    }
  });
});

describe("T016 Engram missing-install evidence (existing channels, no new installer code)", () => {
  it("installs a missing Engram via brew without legacy writes or unrelated mutation", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    let installed = false;
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") {
        if (!installed) throw new Error("not found");
        return { stdout: "engram 1.20.0", stderr: "" };
      }
      if (command === "which" && args[0] === "brew") return { stdout: "/opt/homebrew/bin/brew", stderr: "" };
      if (command === "brew" && args[0] === "install") {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") {
        return {
          stdout: ["engram connected", "context7 connected", "codegraph connected", "3 server(s)"].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);

    expect(result.engram.action).toBe("synced (homebrew)");
    expect(calls).toContain("brew install gentleman-programming/tap/engram");
    // Existing ownership gates unchanged: no legacy-writing or shared-env installer ran.
    expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("zotpilot "))).toBe(false);
    await expectByteIdentical(root, before);
  });
});

describe("T016 CodeGraph install-if-missing", () => {
  it("installs a missing CodeGraph via npm plus ARIA V2 registration, never the upstream reconciler", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { other: { type: "remote", url: "https://example.invalid/mcp" } } }, plugins: ["unrelated-plugin"] }),
    );
    const calls: string[] = [];
    let installed = false;
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "codegraph 1.4.0", stderr: "" };
      }
      if (command === "npm" && args[0] === "view") return { stdout: "1.4.0\n", stderr: "" };
      if (command === "npm" && args[0] === "install") {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["codegraph connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installCodegraphIfMissing(executor, configDir);

    expect(result.status).toBe("installed");
    expect(result.installedVersion).toBe("1.4.0");
    expect(result.mutated).toBe(true);
    expect(calls).toContain("npm install -g @colbymchenry/codegraph@1.4.0");
    expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
    expect(calls.some((call) => call === "codegraph upgrade")).toBe(false);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.codegraph).toEqual({ type: "local", command: CODEGRAPH_MCP_COMMAND });
    // Intended V2 path only: no legacy shape, unrelated entries preserved.
    expect(written?.mcp?.codegraph).toBeUndefined();
    expect(written?.mcp?.servers?.other).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });

  it("leaves an existing CodeGraph installation ownership-gated/report-only and byte-identical", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codegraph" && args[0] === "--version") return { stdout: "codegraph 1.3.1", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installCodegraphIfMissing(executor, configDir);

    expect(result.status).toBe("already-present");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
    await expectByteIdentical(root, before);
  });
});

describe("T016 ZotPilot install-if-missing", () => {
  it("installs a missing ZotPilot user-scoped via pip plus ARIA V2 registration, never a mutating zotpilot subcommand", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
    const calls: string[] = [];
    let installed = false;
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "python3" && args.includes("index")) {
        return { stdout: "zotpilot (0.5.3)\nAvailable versions: 0.5.3, 0.5.2\n", stderr: "" };
      }
      if (command === "python3" && args.includes("install")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installZotpilotIfMissing(executor, configDir);

    expect(result.status).toBe("installed");
    expect(result.installedVersion).toBe("0.5.3");
    expect(calls).toContain("python3 -m pip install --user zotpilot==0.5.3");
    expect(calls.some((call) => call.startsWith("zotpilot upgrade") || call.startsWith("zotpilot register") || call.startsWith("zotpilot install"))).toBe(false);
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.zotpilot).toEqual({ type: "local", command: ZOTPILOT_MCP_COMMAND });
    expect(written?.mcp?.zotpilot).toBeUndefined();
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });

  it("leaves an existing ZotPilot registration ownership-gated/report-only and byte-identical", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { zotpilot: { type: "local", command: ["zotpilot", "mcp", "serve"] } } } }),
    );
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "zotpilot" && args[0] === "--version") return { stdout: "zotpilot 0.5.3", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installZotpilotIfMissing(executor, configDir);

    expect(result.status).toBe("already-present");
    expect(result.mutated).toBe(false);
    expect(calls.some((call) => call.startsWith("python3 "))).toBe(false);
    await expectByteIdentical(root, before);
  });

  it("adds the V2 entry without touching a legacy codegraph entry or unrelated settings (intended vs legacy paths)", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
          codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true },
        },
        plugins: ["unrelated-plugin"],
      }),
    );
    let installed = false;
    const executor: Executor = async (command, args) => {
      if (command === "zotpilot" && args[0] === "--version") {
        if (!installed) throw new Error("not found");
        return { stdout: "zotpilot 0.5.3", stderr: "" };
      }
      if (command === "python3" && args.includes("index")) {
        return { stdout: "Available versions: 0.5.3\n", stderr: "" };
      }
      if (command === "python3" && args.includes("install")) {
        installed = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "opencode" && args[0] === "mcp") {
        return { stdout: ["zotpilot connected", "1 server(s)"].join("\n"), stderr: "" };
      }
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installZotpilotIfMissing(executor, configDir);

    expect(result.status).toBe("installed");
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.servers?.zotpilot).toEqual({ type: "local", command: ZOTPILOT_MCP_COMMAND });
    // Legacy codegraph entry preserved exactly; no legacy zotpilot shape manufactured.
    expect(written?.mcp?.codegraph).toEqual({ type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true });
    expect(written?.mcp?.servers?.codegraph).toBeUndefined();
    expect(written?.mcp?.zotpilot).toBeUndefined();
    expect(written?.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
    expect(written?.plugins).toEqual(["unrelated-plugin"]);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([resolve(configDir, "opencode.json")]);
  });
});

describe("T016 Quota install-if-missing", () => {
  it("installs a missing Quota via the native plugin command after npm-view discovery", async () => {
    await withTempXdg(async (xdgConfigHome) => {
      const configDir = resolve(xdgConfigHome, "opencode");
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      const calls: string[] = [];
      let added = false;
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
          if (!added) return { stdout: "No plugins found", stderr: "" };
          return { stdout: [PLUGIN_HEADER, quotaListRow("5.1.0", "@slkiser/opencode-quota@5.1.0")].join("\n"), stderr: "" };
        }
        if (command === "npm" && args[0] === "view") return { stdout: "5.1.0\n", stderr: "" };
        if (command === "opencode" && args[0] === "plugin" && args[1] === "add") {
          added = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      // No pre-existing config file: the native installer owns creation; the
      // plugin list is the registration source of truth.
      const result = await installQuotaIfMissing(executor);

      expect(result.status).toBe("installed");
      expect(result.installedVersion).toBe("5.1.0");
      expect(result.mutated).toBe(true);
      expect(calls).toContain("opencode plugin add @slkiser/opencode-quota@5.1.0");
    });
  });

  it("leaves an observed Quota target to the upgrade-only adapter with zero mutation", async () => {
    await withTempXdg(async (xdgConfigHome) => {
      const configDir = resolve(xdgConfigHome, "opencode");
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(
        resolve(configDir, "opencode.json"),
        JSON.stringify({ plugins: ["@slkiser/opencode-quota@5.0.2", "unrelated-plugin"] }),
      );
      const before = await snapshotTree(configDir);
      const calls: string[] = [];
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
          return { stdout: [PLUGIN_HEADER, quotaListRow("5.0.2", "@slkiser/opencode-quota@5.0.2")].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await installQuotaIfMissing(executor);

      expect(result.status).toBe("already-present");
      expect(result.mutated).toBe(false);
      expect(calls.some((call) => call.includes("plugin add"))).toBe(false);
      expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
      await expectByteIdentical(configDir, before);
    });
  });

  it("fails closed report-only when the explicit config dir diverges from the effective root", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await installQuotaIfMissing(executor, { configDir });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rolls the config snapshot back when install validation fails", async () => {
    await withTempXdg(async (xdgConfigHome) => {
      const configDir = resolve(xdgConfigHome, "opencode");
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
      const before = await snapshotTree(configDir);
      const executor: Executor = async (command, args) => {
        if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
          // Installer ran, but the quota registration surface never appears.
          return { stdout: "No plugins found", stderr: "" };
        }
        if (command === "npm" && args[0] === "view") return { stdout: "5.1.0\n", stderr: "" };
        if (command === "opencode" && args[0] === "plugin" && args[1] === "add") return { stdout: "", stderr: "" };
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await installQuotaIfMissing(executor);

      expect(result.status).toBe("validation-failed");
      expect(result.mutated).toBe(true);
      expect(result.rolledBack).toBe(true);
      await expectByteIdentical(configDir, before);
    });
  });
});
