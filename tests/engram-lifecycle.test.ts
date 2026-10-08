import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openCodeGlobalDir } from "../src/paths.js";
import { detectEngramState, engramUpgradeComponent, ensureEngram, ENGRAM_BOOTSTRAP_EVIDENCE } from "../src/engram.js";
import type { DependencyFileOps, Executor } from "../src/deps.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T012 Engram lifecycle adapter: detect (version + homebrew vs github asset),
// install-if-missing OR update-if-outdated via the demonstrated-safe path
// (detected channel + `engram setup opencode` + T016 bootstrap evidence),
// then normalize V2/XDG and validate version + MCP connectivity. T005
// statusline cleanup is reused by import (no duplicate logic).
// Already-current short-circuits the version update but not normalization.
// Shared: callable directly by `aria setup` (no handoff) AND post-handoff by
// `aria upgrade` via `engramUpgradeComponent`.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function stubFileOps(overrides: Partial<DependencyFileOps> = {}): DependencyFileOps {
  return {
    readText: async () => "",
    realpath: async (path) => path,
    sha256: async () => "",
    ...overrides,
  };
}

async function withTempXdg<T>(action: (xdgConfigHome: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t012-xdg-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp XDG root");
  const xdgConfigHome = resolve(root, "config");
  await mkdir(resolve(xdgConfigHome, "opencode"), { recursive: true });
  assertNotCallerGlobalPath(xdgConfigHome, "temp XDG_CONFIG_HOME");
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    return await action(xdgConfigHome);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

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

function releasesJson(tag: string, assets: string[]): string {
  return JSON.stringify([
    {
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: assets.map((name) => ({
        name,
        browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/${tag}/${name}`,
      })),
    },
  ]);
}

describe("T012 Engram lifecycle evidence + detection", () => {
  it("links the demonstrated-safe T016 bootstrap path and detects version + channel", async () => {
    expect(ENGRAM_BOOTSTRAP_EVIDENCE?.missingPath).toBe("install");
    expect(ENGRAM_BOOTSTRAP_EVIDENCE?.installCommands.join(" ")).toMatch(/engram setup opencode/);

    const fileOps = stubFileOps();
    const homebrew: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "engram version") return { stdout: "engram 1.20.0", stderr: "" };
      if (key === "brew list --formula") return { stdout: "engram", stderr: "" };
      if (key === "which engram") return { stdout: "/Cellar/engram/1.20.0/bin/engram", stderr: "" };
      if (key === "brew --cellar") return { stdout: "/Cellar", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    await expect(detectEngramState(homebrew, fileOps)).resolves.toMatchObject({
      found: true,
      version: "1.20.0",
      channel: "homebrew",
    });

    const github: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "engram version") return { stdout: "engram 1.19.0", stderr: "" };
      if (key === "brew list --formula") return { stdout: "node\nyarn", stderr: "" };
      if (key === "which engram") return { stdout: "/home/u/.local/bin/engram", stderr: "" };
      if (key === "brew --cellar") return { stdout: "/Cellar", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    await expect(detectEngramState(github, fileOps)).resolves.toMatchObject({
      found: true,
      version: "1.19.0",
      channel: "unknown",
    });

    const missing: Executor = async (command, args) => {
      if (command === "engram") throw new Error("not found");
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    await expect(detectEngramState(missing, fileOps)).resolves.toMatchObject({ found: false, channel: "missing" });
  });
});

describe("T012 clean-install bootstraps via the brew path", () => {
  it("installs a missing Engram, removes the statusline, and preserves unrelated entries", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(
        resolve(configDir, "opencode.json"),
        JSON.stringify({
          mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } },
          plugins: ["unrelated-plugin"],
        }),
      );
      await writeFile(resolve(configDir, "cli.json"), JSON.stringify({ plugins: ["opencode-subagent-statusline", "keep-me"] }));
      await writeFile(resolve(configDir, "tui.json"), JSON.stringify({ plugin: ["opencode-subagent-statusline", "keep-tui"] }));

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
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram connected", "context7 connected", "2 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await ensureEngram(executor);

      expect(result.status).toBe("installed");
      expect(result.resultingVersion).toBe("1.20.0");
      expect(result.mutated).toBe(true);
      expect(result.mcpConnected).toBe(true);
      expect(result.statuslineAbsent).toBe(true);
      expect(calls).toContain("brew install gentleman-programming/tap/engram");
      expect(calls).toContain("engram setup opencode");
      expect(calls.some((call) => call.includes("api.github.com"))).toBe(false);

      const cli = JSON.parse(await readFile(resolve(configDir, "cli.json"), "utf8"));
      expect(cli.plugins).toEqual(["keep-me"]);
      const tui = JSON.parse(await readFile(resolve(configDir, "tui.json"), "utf8"));
      expect(tui.plugin).toEqual(["keep-tui"]);
      const main = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
      expect(main.mcp.servers.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
      expect(main.plugins).toEqual(["unrelated-plugin"]);
    });
  });
});

describe("T012 already-current short-circuits the update but normalizes", () => {
  it("skips the GitHub download, still runs setup + statusline cleanup, and validates", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
      await writeFile(resolve(configDir, "cli.json"), JSON.stringify({ plugins: ["opencode-subagent-statusline", "keep-me"] }));

      const calls: string[] = [];
      const json = releasesJson("v1.20.0", ["engram_1.20.0_linux_amd64.tar.gz"]);
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
        if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
        if (command === "which" && args[0] === "engram") return { stdout: "/home/u/.local/bin/engram", stderr: "" };
        if (command === "brew" && args[0] === "--cellar") return { stdout: "/Cellar", stderr: "" };
        if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: json, stderr: "" };
        if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram connected", "1 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await ensureEngram(executor, { fileOps: stubFileOps() });

      expect(result.status).toBe("already-current");
      expect(result.resultingVersion).toBe("1.20.0");
      expect(result.mcpConnected).toBe(true);
      expect(result.statuslineAbsent).toBe(true);
      expect(calls).toContain("engram setup opencode");
      // No versioned-asset download on the short-circuit path.
      expect(calls.some((call) => call.includes("engram_1.20.0_linux_amd64.tar.gz") && call.includes("-o"))).toBe(false);
      const cli = JSON.parse(await readFile(resolve(configDir, "cli.json"), "utf8"));
      expect(cli.plugins).toEqual(["keep-me"]);
      const main = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
      expect(main.plugins).toEqual(["unrelated-plugin"]);
    });
  });
});

describe("T012 outdated GitHub install updates and validates", () => {
  it("replaces 1.19.0 with the checksum-verified 1.20.0 asset and keeps unrelated entries", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(
        resolve(configDir, "opencode.json"),
        JSON.stringify({ mcp: { servers: { other: { type: "remote", url: "https://example.invalid/mcp" } } } }),
      );

      const calls: string[] = [];
      const hash = "abc123def456";
      const asset = "engram_1.20.0_linux_amd64.tar.gz";
      const json = releasesJson("v1.20.0", [asset, "engram_1.20.0_darwin_arm64.tar.gz"]);
      let version = "1.19.0";
      const fileOps = stubFileOps({
        readText: async () => `${hash}  ${asset}\n`,
        sha256: async () => hash,
      });
      const executor: Executor = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "engram" && args[0] === "version") return { stdout: `engram ${version}`, stderr: "" };
        if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
        if (command === "which" && args[0] === "engram") return { stdout: "/home/u/.local/bin/engram", stderr: "" };
        if (command === "brew" && args[0] === "--cellar") return { stdout: "/Cellar", stderr: "" };
        if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: json, stderr: "" };
        if (command === "curl") return { stdout: "", stderr: "" };
        if (command === "mkdir" || command === "tar" || command === "cp" || command === "chmod") return { stdout: "", stderr: "" };
        if (command === "find") return { stdout: "/tmp/aria-engram-x/extract/engram", stderr: "" };
        if (command === "mv") {
          version = "1.20.0";
          return { stdout: "", stderr: "" };
        }
        if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram connected", "1 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await ensureEngram(executor, { fileOps });

      expect(result.status).toBe("upgraded");
      expect(result.installedVersion).toBe("1.19.0");
      expect(result.resultingVersion).toBe("1.20.0");
      expect(result.mutated).toBe(true);
      expect(result.mcpConnected).toBe(true);
      expect(result.statuslineAbsent).toBe(true);
      expect(calls.some((call) => call.includes(asset))).toBe(true);
      expect(calls).toContain("engram setup opencode");
      const main = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
      expect(main.mcp.servers.other).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    });
  });
});

describe("T012 validation rolls the config snapshot back", () => {
  it("restores pre-change bytes when MCP connectivity is not established", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
      const before = await snapshotTree(configDir);

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
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram disconnected", "1 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };

      const result = await ensureEngram(executor);

      expect(result.status).toBe("validation-failed");
      expect(result.mutated).toBe(true);
      expect(result.rolledBack).toBe(true);
      expect(result.mcpConnected).toBe(false);
      expect(calls).toContain("brew install gentleman-programming/tap/engram");
      await expectByteIdentical(configDir, before);
    });
  });
});

describe("T012 XDG guard fails closed", () => {
  it("leaves a divergent explicit dir untouched with zero executor calls", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-t012-divergent-"));
    tempDirs.push(root);
    const other = resolve(root, "config", "opencode");
    await mkdir(other, { recursive: true });
    assertNotCallerGlobalPath(other, "divergent configDir");
    const before = await snapshotTree(root);
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      throw new Error(`must not run: ${command} ${args.join(" ")}`);
    };

    const result = await ensureEngram(executor, { configDir: other });

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
    await expectByteIdentical(root, before);
  });
});

describe("T012 shared component wrapper", () => {
  it("completes setup-direct and post-handoff calls and skips divergent scopes", async () => {
    await withTempXdg(async () => {
      const configDir = openCodeGlobalDir();
      assertNotCallerGlobalPath(configDir, "temp XDG global dir");
      await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ plugins: ["unrelated-plugin"] }));
      const json = releasesJson("v1.20.0", ["engram_1.20.0_linux_amd64.tar.gz"]);
      const executor: Executor = async (command, args) => {
        if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
        if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
        if (command === "which" && args[0] === "engram") return { stdout: "/home/u/.local/bin/engram", stderr: "" };
        if (command === "brew" && args[0] === "--cellar") return { stdout: "/Cellar", stderr: "" };
        if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: json, stderr: "" };
        if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
        if (command === "opencode" && args[0] === "mcp") {
          return { stdout: ["engram connected", "1 server(s)"].join("\n"), stderr: "" };
        }
        throw new Error(`unexpected: ${command} ${args.join(" ")}`);
      };
      const target = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };

      const completed = await engramUpgradeComponent({ target, executor, configDir });
      expect(completed.component).toBe("engram");
      expect(completed.status).toBe("completed");

      // Same adapter with no handoff needed (setup-direct shape still works).
      const direct = await ensureEngram(executor);
      expect(["already-current", "installed", "upgraded"]).toContain(direct.status);

      const other = resolve(await mkdtemp(resolve(tmpdir(), "rdc-t012-scope-")), "opencode");
      tempDirs.push(resolve(other, ".."));
      await mkdir(other, { recursive: true });
      assertNotCallerGlobalPath(other, "divergent scope dir");
      const skipped = await engramUpgradeComponent({
        target,
        executor: async () => {
          throw new Error("must not run on a divergent scope");
        },
        configDir: other,
      });
      expect(skipped).toMatchObject({ component: "engram", status: "skipped", mutated: false });
    });
  });
});
