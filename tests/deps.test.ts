import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  depsSync,
  detectEngramSource,
  doctor,
  doctorExitCode,
  formatDoctor,
  formatSyncResult,
  parseMcpList,
  isCoreSemverTag,
  discoverConfigPath,
  resolveCommand,
  buildComSpecArgs,
  stripJsoncComments,
  sha256File,
  syncEngramGitHub,
  defaultExecutor,
  type DependencyFileOps,
  type DepsStatus,
  type Executor,
  type SyncResult,
} from "../src/deps.js";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function mockExecutor(responses: Record<string, { stdout?: string; stderr?: string; error?: string }>): Executor {
  return async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    if (response.error) throw new Error(response.error);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
}

/** Build mock executor entries for a Homebrew-managed engram at the given cellar path. */
function brewMocks(cellarBin: string, cellarRoot: string): Record<string, { stdout: string }> {
  return {
    "brew list --formula": { stdout: "engram" },
    "which engram": { stdout: cellarBin },
    "brew --cellar": { stdout: cellarRoot },
    "brew update": { stdout: "" },
    "brew upgrade engram": { stdout: "" },
    "engram setup opencode": { stdout: "" },
  };
}

/** Build mock executor entries for a non-Homebrew engram at the given path. */
function nonBrewMocks(binPath: string, cellarRoot: string): Record<string, { stdout: string }> {
  return {
    "brew list --formula": { stdout: "node\nyarn" },
    "which engram": { stdout: binPath },
    "brew --cellar": { stdout: cellarRoot },
  };
}

function githubFileOps(checksums: string, hash = "abc123"): DependencyFileOps {
  return {
    readText: async () => checksums,
    realpath: async (path) => path,
    sha256: async () => hash,
  };
}

/** Common codegraph mock entries. */
const codegraphMocks: Record<string, { stdout: string }> = {
  "codegraph --version": { stdout: "1.3.1" },
  "codegraph upgrade": { stdout: "" },
  "codegraph install --target opencode --location global --yes": { stdout: "" },
};

function allHealthyMcpList(): string {
  return [
    "MCP Servers",
    "",
    "codegraph connected",
    "codegraph serve --mcp",
    "",
    "context7 connected",
    "https://mcp.context7.com/mcp",
    "",
    "engram connected",
    "engram mcp --tools=agent",
    "",
    "zotpilot connected",
    "zotpilot mcp serve",
    "",
    "4 server(s)",
  ].join("\n");
}

function allHealthyExecutor(): Executor {
  return mockExecutor({
    "opencode --version": { stdout: "1.18.15" },
    "engram version": { stdout: "engram 1.20.0" },
    "codegraph --version": { stdout: "1.3.1" },
    "opencode mcp list": { stdout: allHealthyMcpList() },
  });
}

function noDepsExecutor(): Executor {
  return async () => {
    throw new Error("command not found");
  };
}

async function makeEmptyConfigDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-config-"));
  tempDirs.push(root);
  const configDir = resolve(root, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));
  return configDir;
}

async function makeConfigDirWith(overrides: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-config-"));
  tempDirs.push(root);
  const configDir = resolve(root, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ mcp: overrides }));
  return configDir;
}

/** Build a GitHub releases list response with the given entries. */
function buildReleasesJson(releases: Array<{ tag: string; draft?: boolean; prerelease?: boolean; assets?: string[] }>): string {
  return JSON.stringify(
    releases.map((r) => ({
      tag_name: r.tag,
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? false,
      assets: (r.assets ?? []).map((name) => ({
        name,
        browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/${r.tag}/${name}`,
      })),
    }))
  );
}

/** Build a valid checksums.txt content for the given asset name and hash. */
function buildChecksumsTxt(assetName: string, hash: string): string {
  return `${hash}  ${assetName}\n`;
}

// ---------------------------------------------------------------------------
// isCoreSemverTag
// ---------------------------------------------------------------------------

describe("isCoreSemverTag", () => {
  it("accepts valid core semver tags", () => {
    expect(isCoreSemverTag("v1.0.0")).toBe(true);
    expect(isCoreSemverTag("v0.1.0")).toBe(true);
    expect(isCoreSemverTag("v1.20.0")).toBe(true);
    expect(isCoreSemverTag("v100.200.300")).toBe(true);
  });

  it("rejects prerelease tags", () => {
    expect(isCoreSemverTag("v1.0.0-beta")).toBe(false);
    expect(isCoreSemverTag("v1.0.0-rc.1")).toBe(false);
    expect(isCoreSemverTag("v1.0.0-alpha.2")).toBe(false);
  });

  it("rejects tags with build metadata", () => {
    expect(isCoreSemverTag("v1.0.0+build.123")).toBe(false);
  });

  it("rejects non-semver tags", () => {
    expect(isCoreSemverTag("latest")).toBe(false);
    expect(isCoreSemverTag("release-1.0")).toBe(false);
    expect(isCoreSemverTag("v1.0")).toBe(false);
    expect(isCoreSemverTag("1.0.0")).toBe(false);
    expect(isCoreSemverTag("")).toBe(false);
  });
});

describe("detectEngramSource", () => {
  it("recognizes a Homebrew symlink that resolves into the cellar", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-brew-"));
    tempDirs.push(root);
    const cellar = resolve(root, "Cellar");
    const cellarBin = resolve(cellar, "engram", "1.20.0", "bin", "engram");
    const linkedBin = resolve(root, "bin", "engram");
    await mkdir(resolve(cellarBin, ".."), { recursive: true });
    await mkdir(resolve(linkedBin, ".."), { recursive: true });
    await writeFile(cellarBin, "binary");
    await symlink(cellarBin, linkedBin);

    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      "brew list --formula": { stdout: "engram" },
      "which engram": { stdout: linkedBin },
      "brew --cellar": { stdout: cellar },
    });

    expect(await detectEngramSource(executor)).toBe("homebrew");
  });

  it("does not classify a non-Homebrew binary as Homebrew", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-brew-"));
    tempDirs.push(root);
    const cellar = resolve(root, "Cellar");
    const binPath = resolve(root, "local", "bin", "engram");
    await mkdir(resolve(binPath, ".."), { recursive: true });
    await writeFile(binPath, "binary");

    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      "brew list --formula": { stdout: "engram" },
      "which engram": { stdout: binPath },
      "brew --cellar": { stdout: cellar },
    });

    expect(await detectEngramSource(executor)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// discoverConfigPath + stripJsoncComments
// ---------------------------------------------------------------------------

describe("discoverConfigPath", () => {
  it("returns .json path when it exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-jsonc-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "opencode.json"), "{}");
    expect(discoverConfigPath(root)).toBe(resolve(root, "opencode.json"));
  });

  it("returns .jsonc path when only .jsonc exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-jsonc-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "opencode.jsonc"), "{}");
    expect(discoverConfigPath(root)).toBe(resolve(root, "opencode.jsonc"));
  });

  it("prefers .json over .jsonc", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-jsonc-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "opencode.json"), "{}");
    await writeFile(resolve(root, "opencode.jsonc"), "{}");
    expect(discoverConfigPath(root)).toBe(resolve(root, "opencode.json"));
  });

  it("returns null when neither exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-jsonc-"));
    tempDirs.push(root);
    expect(discoverConfigPath(root)).toBeNull();
  });
});

describe("stripJsoncComments", () => {
  it("strips single-line comments", () => {
    const input = `{ // comment\n  "key": "value" // trailing\n}`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({ key: "value" });
  });

  it("strips trailing commas", () => {
    const input = `{\n  "key": "value",\n}`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({ key: "value" });
  });

  it("handles complex JSONC", () => {
    const input = `{
  // This is a comment
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
    },
  },
}`;
    const parsed = JSON.parse(stripJsoncComments(input));
    expect(parsed.mcp.context7.type).toBe("remote");
    expect(parsed.mcp.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("preserves URLs with double slashes", () => {
    const input = `{\n  "url": "https://example.com/path"\n}`;
    const parsed = JSON.parse(stripJsoncComments(input));
    expect(parsed.url).toBe("https://example.com/path");
  });

  it("preserves comment markers and escapes inside strings", () => {
    const input = String.raw`{"message":"foo // bar","quoted":"say \"/* hello */\""}`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({
      message: "foo // bar",
      quoted: 'say "/* hello */"',
    });
  });

  it("strips block comments", () => {
    const input = `{
      /* server configuration */
      "enabled": true, /* keep this property */
    }`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({ enabled: true });
  });
});

describe("sha256File", () => {
  it("hashes a file with Node crypto", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-hash-"));
    tempDirs.push(root);
    const path = resolve(root, "payload.tar.gz");
    await writeFile(path, "engram payload");

    expect(await sha256File(path)).toBe("b7ee9f45c36d39b85a8c1b21f8521d91638bfa5022e612311cf1c87696870358");
  });

  it("rejects when the file cannot be read", async () => {
    await expect(sha256File(resolve(tmpdir(), "rdc-missing-payload"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseMcpList
// ---------------------------------------------------------------------------

describe("parseMcpList", () => {
  it("parses all three connected", () => {
    const output = allHealthyMcpList();
    const result = parseMcpList(output);
    expect(result.engram).toBe(true);
    expect(result.context7).toBe(true);
    expect(result.codegraph).toBe(true);
  });

  it("parses individual MCP missing", () => {
    const output = [
      "MCP Servers",
      "",
      "context7 connected",
      "https://mcp.context7.com/mcp",
      "",
      "1 server(s)",
    ].join("\n");
    const result = parseMcpList(output);
    expect(result.engram).toBe(false);
    expect(result.context7).toBe(true);
    expect(result.codegraph).toBe(false);
  });

  it("parses individual MCP disconnected", () => {
    const output = [
      "MCP Servers",
      "",
      "engram disconnected",
      "engram mcp --tools=agent",
      "",
      "context7 connected",
      "https://mcp.context7.com/mcp",
      "",
      "codegraph connected",
      "codegraph serve --mcp",
      "",
      "3 server(s)",
    ].join("\n");
    const result = parseMcpList(output);
    expect(result.engram).toBe(false);
    expect(result.context7).toBe(true);
    expect(result.codegraph).toBe(true);
  });

  it("parses MCP error status", () => {
    const output = [
      "MCP Servers",
      "",
      "engram error",
      "engram mcp --tools=agent",
      "",
      "2 server(s)",
    ].join("\n");
    const result = parseMcpList(output);
    expect(result.engram).toBe(false);
  });

  it("handles empty output", () => {
    const result = parseMcpList("");
    expect(result.engram).toBe(false);
    expect(result.context7).toBe(false);
    expect(result.codegraph).toBe(false);
  });

  it("handles opencode mcp list failure", () => {
    const result = parseMcpList("Error: cannot connect");
    expect(result.engram).toBe(false);
    expect(result.context7).toBe(false);
    expect(result.codegraph).toBe(false);
  });

  it("ignores unrelated servers", () => {
    const output = [
      "MCP Servers",
      "",
      "zotpilot connected",
      "zotpilot mcp serve",
      "",
      "engram connected",
      "engram mcp --tools=agent",
      "",
      "1 server(s)",
    ].join("\n");
    const result = parseMcpList(output);
    expect(result.engram).toBe(true);
    expect(result.context7).toBe(false);
    expect(result.codegraph).toBe(false);
  });

  it("exposes optional ZotPilot presence without changing the legacy shape", () => {
    const withZot = parseMcpList(allHealthyMcpList());
    expect(withZot.zotpilot).toEqual({ listed: true, connected: true });
    expect(withZot.engram).toBe(true);

    const withoutZot = parseMcpList("engram connected\nengram mcp --tools=agent\n");
    expect(withoutZot.zotpilot).toBeUndefined();
    expect(withoutZot.listFailed).toBeUndefined();
  });

  it("reports ZotPilot listed but disconnected", () => {
    const output = [
      "MCP Servers",
      "",
      "zotpilot disconnected",
      "zotpilot mcp serve",
      "",
      "1 server(s)",
    ].join("\n");
    const result = parseMcpList(output);
    expect(result.zotpilot).toEqual({ listed: true, connected: false });
  });
});

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

describe("doctor", () => {
  it("reports healthy status when all deps and MCPs present", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const status = await doctor(allHealthyExecutor(), configDir);
    expect(status.opencode.found).toBe(true);
    expect(status.opencode.version).toBe("1.18.15");
    expect(status.engram.found).toBe(true);
    expect(status.engram.version).toBe("1.20.0");
    expect(status.engram.connected).toBe(true);
    expect(status.codegraph.found).toBe(true);
    expect(status.codegraph.version).toBe("1.3.1");
    expect(status.codegraph.connected).toBe(true);
    expect(status.context7.configured).toBe(true);
    expect(status.context7.connected).toBe(true);
  });

  it("reports missing deps", async () => {
    const configDir = await makeEmptyConfigDir();
    const status = await doctor(noDepsExecutor(), configDir);
    expect(status.opencode.found).toBe(false);
    expect(status.engram.found).toBe(false);
    expect(status.engram.connected).toBe(false);
    expect(status.codegraph.found).toBe(false);
    expect(status.codegraph.connected).toBe(false);
    expect(status.context7.configured).toBe(false);
    expect(status.context7.connected).toBe(false);
  });

  it("CLI exists but MCP disconnected", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const executor = mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram disconnected", "engram mcp --tools=agent",
          "context7 connected", "https://mcp.context7.com/mcp",
          "codegraph disconnected", "codegraph serve --mcp",
          "2 server(s)",
        ].join("\n"),
      },
    });
    const status = await doctor(executor, configDir);
    expect(status.engram.found).toBe(true);
    expect(status.engram.connected).toBe(false);
    expect(status.codegraph.found).toBe(true);
    expect(status.codegraph.connected).toBe(false);
  });

  it("Context7 configured correctly but disconnected", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const executor = mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram connected", "engram mcp --tools=agent",
          "context7 disconnected", "https://mcp.context7.com/mcp",
          "codegraph connected", "codegraph serve --mcp",
          "3 server(s)",
        ].join("\n"),
      },
    });
    const status = await doctor(executor, configDir);
    expect(status.context7.configured).toBe(true);
    expect(status.context7.connected).toBe(false);
  });

  it("opencode mcp list failure marks all MCPs disconnected", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const executor = mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": { error: "cannot connect" },
    });
    const status = await doctor(executor, configDir);
    expect(status.engram.connected).toBe(false);
    expect(status.context7.connected).toBe(false);
    expect(status.codegraph.connected).toBe(false);
  });

  it("exit code 0 when all healthy", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const status = await doctor(allHealthyExecutor(), configDir);
    expect(doctorExitCode(status)).toBe(0);
  });

  it("exit code 1 when any MCP disconnected", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });

    const engramDown = await doctor(mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram disconnected", "engram mcp",
          "context7 connected", "https://mcp.context7.com/mcp",
          "codegraph connected", "codegraph serve --mcp",
          "3 server(s)",
        ].join("\n"),
      },
    }), configDir);
    expect(doctorExitCode(engramDown)).toBe(1);

    const ctx7Down = await doctor(mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram connected", "engram mcp",
          "context7 disconnected", "https://mcp.context7.com/mcp",
          "codegraph connected", "codegraph serve --mcp",
          "3 server(s)",
        ].join("\n"),
      },
    }), configDir);
    expect(doctorExitCode(ctx7Down)).toBe(1);

    const cgDown = await doctor(mockExecutor({
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram connected", "engram mcp",
          "context7 connected", "https://mcp.context7.com/mcp",
          "codegraph disconnected", "codegraph serve --mcp",
          "3 server(s)",
        ].join("\n"),
      },
    }), configDir);
    expect(doctorExitCode(cgDown)).toBe(1);
  });

  it("exit code 1 when CLI missing", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const status = await doctor(mockExecutor({
      "opencode --version": { error: "not found" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    }), configDir);
    expect(doctorExitCode(status)).toBe(1);
  });

  it("does not mutate anything", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error("unexpected");
    };

    await doctor(executor, configDir);
    for (const call of calls) {
      expect(call).not.toContain("install");
      expect(call).not.toContain("upgrade");
      expect(call).not.toContain("setup");
      expect(call).not.toContain("mcp add");
    }
  });

  it("exposes optional ZotPilot presence and mcp-list failure without disturbing the legacy shape", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const base = {
      "opencode --version": { stdout: "1.18.15" },
      "engram version": { stdout: "engram 1.20.0" },
      "codegraph --version": { stdout: "1.3.1" },
    };

    const withZot = await doctor(mockExecutor({
      ...base,
      "opencode mcp list": { stdout: allHealthyMcpList() },
    }), configDir);
    expect(withZot.zotpilot).toEqual({ listed: true, connected: true });
    expect(withZot.mcpListFailed).toBeUndefined();
    expect(withZot.engram.connected).toBe(true);

    const withoutZot = await doctor(mockExecutor({
      ...base,
      "opencode mcp list": { stdout: "engram connected\nengram mcp --tools=agent\n" },
    }), configDir);
    expect(withoutZot.zotpilot).toBeUndefined();
    expect(withoutZot.mcpListFailed).toBeUndefined();

    const failed = await doctor(mockExecutor({
      ...base,
      "opencode mcp list": { error: "cannot connect" },
    }), configDir);
    expect(failed.zotpilot).toBeUndefined();
    expect(failed.mcpListFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatDoctor
// ---------------------------------------------------------------------------

describe("formatDoctor", () => {
  it("formats complete output with connected MCPs", () => {
    const status: DepsStatus = {
      opencode: { found: true, version: "1.18.15" },
      engram: { found: true, version: "1.20.0", connected: true },
      context7: { configured: true, connected: true },
      codegraph: { found: true, version: "1.3.1", connected: true },
    };
    const output = formatDoctor("0.1.0", status);
    expect(output).toContain("ARIA 0.1.0");
    expect(output).toContain("OpenCode     [OK] 1.18.15");
    expect(output).toContain("Engram       [OK] 1.20.0");
    expect(output).toContain("Context7     [OK] configured");
    expect(output).toContain("CodeGraph    [OK] 1.3.1");
    expect(output).toContain("engram     [OK] connected");
    expect(output).toContain("context7   [OK] connected");
    expect(output).toContain("codegraph  [OK] connected");
  });

  it("formats missing deps and disconnected MCPs", () => {
    const status: DepsStatus = {
      opencode: { found: false, version: null },
      engram: { found: false, version: null, connected: false },
      context7: { configured: false, connected: false },
      codegraph: { found: false, version: null, connected: false },
    };
    const output = formatDoctor("0.1.0", status);
    expect(output).toContain("OpenCode     [FAIL] not found");
    expect(output).toContain("Engram       [FAIL] not found");
    expect(output).toContain("Context7     [FAIL] not configured");
    expect(output).toContain("CodeGraph    [FAIL] not found");
    expect(output).toContain("engram     [FAIL] not connected");
    expect(output).toContain("context7   [FAIL] not connected");
    expect(output).toContain("codegraph  [FAIL] not connected");
  });

  it("shows CLI present but MCP disconnected", () => {
    const status: DepsStatus = {
      opencode: { found: true, version: "1.18.15" },
      engram: { found: true, version: "1.20.0", connected: false },
      context7: { configured: true, connected: false },
      codegraph: { found: true, version: "1.3.1", connected: false },
    };
    const output = formatDoctor("0.1.0", status);
    expect(output).toContain("Engram       [OK] 1.20.0");
    expect(output).toContain("engram     [FAIL] not connected");
    expect(output).toContain("context7   [FAIL] not connected");
    expect(output).toContain("codegraph  [FAIL] not connected");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- Engram homebrew path
// ---------------------------------------------------------------------------

describe("depsSync -- Engram homebrew", () => {
  it("checks for Homebrew through the injected executor when Engram is missing", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram") throw new Error("not found");
      if (command === "which" && args[0] === "brew") throw new Error("not found");
      if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: "[]", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.engram.action).toBe("no-asset");
    expect(calls).toContain("which brew");
    expect(calls).not.toContain("brew install gentleman-programming/tap/engram");
  });

  it("detects Homebrew-managed engram and upgrades via brew", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.engram.action).toBe("synced (homebrew)");
    expect(calls).toContain("brew update");
    expect(calls).toContain("brew upgrade engram");
    expect(calls).toContain("engram setup opencode");
  });

  it("selects the versioned Linux asset from a realistic v1.20.0 release", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const calls: string[] = [];
    const checksumsHash = "abc123def456";
    const releasesJson = buildReleasesJson([
      {
        tag: "v1.20.0",
        assets: [
          "checksums.txt",
          "engram_1.20.0_darwin_amd64.tar.gz",
          "engram_1.20.0_darwin_arm64.tar.gz",
          "engram_1.20.0_linux_amd64.tar.gz",
          "engram_1.20.0_linux_arm64.tar.gz",
        ],
      },
    ]);
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: `${home}/.local/bin/engram`, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("api.github.com") && a.includes("/releases") && !a.includes("/releases/"))) {
        return { stdout: releasesJson, stderr: "" };
      }
      if (command === "curl" && args.some((a) => a.includes("engram_1.20.0_linux_amd64.tar.gz"))) return { stdout: "", stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("checksums.txt"))) return { stdout: "", stderr: "" };
      if (command === "tar") return { stdout: "", stderr: "" };
      if (command === "find") return { stdout: `${home}/.rdc-tmp/extract/engram`, stderr: "" };
      if (command === "cp") return { stdout: "", stderr: "" };
      if (command === "rm") return { stdout: "", stderr: "" };
      if (command === "mkdir") return { stdout: "", stderr: "" };
      if (command === "chmod") return { stdout: "", stderr: "" };
      if (command === "mv") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir, githubFileOps(buildChecksumsTxt("engram_1.20.0_linux_amd64.tar.gz", checksumsHash), checksumsHash));
    expect(result.ok).toBe(true);
    expect(result.engram.action).toBe("synced (github)");
    expect(calls).toContain("curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100");
    expect(calls.some((c) => c.includes("/v1.20.0/engram_1.20.0_linux_amd64.tar.gz"))).toBe(true);
    expect(calls.some((c) => c.includes("engram setup opencode"))).toBe(true);
    expect(calls.some((c) => c.includes("sha256sum"))).toBe(false);
  });

  it("skips update when already on latest GitHub release", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { stdout: releasesJson },
      "engram setup opencode": { stdout: "" },
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
      ...codegraphMocks,
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.engram.action).toBe("already-latest");
  });

  it("GitHub release fetch failure is reported", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.19.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { error: "network error" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("fetch-failed");
    expect(result.engram.error).toContain("Failed to fetch releases");
  });

  it("GitHub release with no matching asset is reported", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_darwin_arm64.tar.gz"] },
    ]);
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.19.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { stdout: releasesJson },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("no-asset");
    expect(result.engram.error).toContain("No stable release found");
  });

  it("brew update failure is reported", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "brew update": { error: "network unreachable" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("brew-update-failed");
  });

  it("malformed/non-core release tag is skipped", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0-beta.1", assets: ["engram_1.20.0-beta.1_linux_amd64.tar.gz"] },
      { tag: "latest", assets: ["engram_latest_linux_amd64.tar.gz"] },
    ]);
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.19.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { stdout: releasesJson },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("no-asset");
  });

  it("draft/prerelease releases are skipped", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.21.0", draft: true, assets: ["engram_1.21.0_linux_amd64.tar.gz"] },
      { tag: "v1.20.1", prerelease: true, assets: ["engram_1.20.1_linux_amd64.tar.gz"] },
    ]);
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.19.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { stdout: releasesJson },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("no-asset");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- Context7
// ---------------------------------------------------------------------------

describe("depsSync -- Context7", () => {
  it("configures context7 when missing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-config-"));
    tempDirs.push(root);
    const configDir = resolve(root, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));

    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    let addCalled = false;
    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "add") {
        // Simulate opencode mcp add writing to the config file
        addCalled = true;
        await writeFile(resolve(configDir, "opencode.json"), JSON.stringify({
          mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true } },
        }));
        return { stdout: "", stderr: "" };
      }
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(addCalled).toBe(true);
    expect(result.context7.action).toBe("configured");
    expect(result.ok).toBe(true);
  });

  it("context7 already configured skips add", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.context7.action).toBe("already-configured");
  });

  it("reads JSONC config for Context7 detection", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-jsonc-"));
    tempDirs.push(root);
    const configDir = resolve(root, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      resolve(configDir, "opencode.jsonc"),
      `{
  // Context7 MCP server
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
    },
  },
}`
    );

    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.context7.action).toBe("already-configured");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- CodeGraph
// ---------------------------------------------------------------------------

describe("depsSync -- CodeGraph", () => {
  it("installs codegraph via npm when missing", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    let codegraphVersionCalls = 0;
    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") {
        codegraphVersionCalls++;
        if (codegraphVersionCalls === 1) throw new Error("not found");
        return { stdout: "1.3.1", stderr: "" };
      }
      if (command === "npm" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.codegraph.action).toBe("synced");
  });

  it("upgrades codegraph via codegraph upgrade when present", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(calls).toContain("codegraph upgrade");
    expect(calls).toContain("codegraph install --target opencode --location global --yes");
    expect(calls).not.toContain("npm install -g @colbymchenry/codegraph@latest");
  });

  it("codegraph upgrade failure is reported", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "codegraph --version": { stdout: "1.3.1" },
      "codegraph upgrade": { error: "upgrade failed" },
      "codegraph install --target opencode --location global --yes": { stdout: "" },
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.codegraph.action).toBe("upgrade-failed");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- failure propagation
// ---------------------------------------------------------------------------

describe("depsSync -- failure propagation", () => {
  it("reports engram setup failure", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "engram setup opencode": { error: "setup failed" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.error).toContain("setup failed");
  });

  it("reports codegraph npm install failure", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "engram setup opencode": { stdout: "" },
      "codegraph --version": { error: "not found" },
      "npm install -g @colbymchenry/codegraph@latest": { error: "permission denied" },
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.codegraph.error).toContain("npm install");
    expect(result.codegraph.error).toContain("permission denied");
  });

  it("reports context7 add failure", async () => {
    const configDir = await makeEmptyConfigDir();
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "engram setup opencode": { stdout: "" },
      "opencode mcp add context7 --url https://mcp.context7.com/mcp": { error: "opencode not found" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.context7.error).toContain("opencode mcp add context7");
  });

  it("continues to later deps after earlier failure", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      "engram setup opencode": { error: "setup failed" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.engram.error).toContain("setup failed");
    expect(result.context7.action).toBe("already-configured");
    expect(result.codegraph.action).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- checksum verification (fail closed)
// ---------------------------------------------------------------------------

describe("depsSync -- checksum verification", () => {
  it("fails when checksums.txt cannot be read", async () => {
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const executor: Executor = async (command, args) => {
      if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: releasesJson, stderr: "" };
      if (command === "curl") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };
    const fileOps: DependencyFileOps = {
      ...githubFileOps(""),
      readText: async () => { throw new Error("permission denied"); },
    };

    const result = await syncEngramGitHub(executor, fileOps);
    expect(result.action).toBe("checksum-read-failed");
    expect(result.error).toContain("permission denied");
  });

  it("fails when checksums.txt download fails", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "node", stderr: "" };
      if (command === "curl" && args.some((arg) => arg.includes("api.github.com"))) return { stdout: releasesJson, stderr: "" };
      if (command === "curl" && args.some((arg) => arg.includes("checksums.txt"))) throw new Error("checksum download failed");
      if (command === "curl") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("checksum-download-failed");
  });

  it("fails when checksum entry is missing for asset", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const checksumsContent = "abc123  engram_1.20.0_darwin_arm64.tar.gz\n";

    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: `${home}/.local/bin/engram`, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("api.github.com") && a.includes("/releases") && !a.includes("/releases/"))) return { stdout: releasesJson, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("engram_1.20.0_linux_amd64.tar.gz"))) return { stdout: "", stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("checksums.txt"))) return { stdout: "", stderr: "" };
      if (command === "mkdir") return { stdout: "", stderr: "" };
      if (command === "tar") return { stdout: "", stderr: "" };
      if (command === "find") return { stdout: `${home}/.rdc-tmp/extract/engram`, stderr: "" };
      if (command === "rm") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir, githubFileOps(checksumsContent));
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("checksum-entry-missing");
  });

  it("fails when checksum hash computation fails", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const checksumsContent = "abc123  engram_1.20.0_linux_amd64.tar.gz\n";

    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: `${home}/.local/bin/engram`, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("api.github.com") && a.includes("/releases") && !a.includes("/releases/"))) return { stdout: releasesJson, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("engram_1.20.0_linux_amd64.tar.gz"))) return { stdout: "", stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("checksums.txt"))) return { stdout: "", stderr: "" };
      if (command === "mkdir") return { stdout: "", stderr: "" };
      if (command === "tar") return { stdout: "", stderr: "" };
      if (command === "find") return { stdout: `${home}/.rdc-tmp/extract/engram`, stderr: "" };
      if (command === "rm") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir, {
      ...githubFileOps(checksumsContent),
      sha256: async () => { throw new Error("read failed"); },
    });
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("hash-compute-failed");
  });

  it("fails when checksum mismatches", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const checksumsContent = "expected_hash  engram_1.20.0_linux_amd64.tar.gz\n";

    const executor: Executor = async (command, args) => {
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.19.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "node\nyarn", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: `${home}/.local/bin/engram`, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("api.github.com") && a.includes("/releases") && !a.includes("/releases/"))) return { stdout: releasesJson, stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("engram_1.20.0_linux_amd64.tar.gz"))) return { stdout: "", stderr: "" };
      if (command === "curl" && args.some((a) => a.includes("checksums.txt"))) return { stdout: "", stderr: "" };
      if (command === "mkdir") return { stdout: "", stderr: "" };
      if (command === "tar") return { stdout: "", stderr: "" };
      if (command === "find") return { stdout: `${home}/.rdc-tmp/extract/engram`, stderr: "" };
      if (command === "rm") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${command} ${args.join(" ")}`);
    };

    const result = await depsSync(executor, configDir, githubFileOps(checksumsContent, "different_hash"));
    expect(result.ok).toBe(false);
    expect(result.engram.action).toBe("checksum-mismatch");
    expect(result.engram.error).toContain("expected_hash");
    expect(result.engram.error).toContain("different_hash");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- final health verification
// ---------------------------------------------------------------------------

describe("depsSync -- final health verification", () => {
  it("sync succeeds when final health is healthy", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(true);
    expect(result.health).toBeDefined();
    expect(result.health!.engram.found).toBe(true);
    expect(result.health!.engram.connected).toBe(true);
    expect(result.health!.context7.configured).toBe(true);
    expect(result.health!.context7.connected).toBe(true);
    expect(result.health!.codegraph.found).toBe(true);
    expect(result.health!.codegraph.connected).toBe(true);
  });

  it("sync fails when installer succeeds but MCP is disconnected", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.20.0" },
      ...brewMocks(cellarBin, `${home}/.local/Cellar`),
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": {
        stdout: [
          "MCP Servers",
          "engram disconnected", "engram mcp --tools=agent",
          "context7 connected", "https://mcp.context7.com/mcp",
          "codegraph connected", "codegraph serve --mcp",
          "3 server(s)",
        ].join("\n"),
      },
    });

    const result = await depsSync(executor, configDir);
    expect(result.ok).toBe(false);
    expect(result.engram.error).toBeFalsy();
    expect(result.health).toBeDefined();
    expect(result.health!.engram.connected).toBe(false);
    const output = formatSyncResult(result);
    expect(output).toContain("Health:");
    expect(output).toContain("engram     [FAIL] not connected");
    expect(output).toContain("context7   [OK] connected");
    expect(output).toContain("codegraph  [OK] connected");
  });
});

// ---------------------------------------------------------------------------
// depsSync -- serialization
// ---------------------------------------------------------------------------

describe("depsSync -- serialization", () => {
  it("runs sync operations sequentially, not concurrently", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
    const callOrder: string[] = [];
    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      callOrder.push(key);
      if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
      if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
      if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
      if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
      if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
      if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "add") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
      if (command === "codegraph" && args[0] === "upgrade") return { stdout: "", stderr: "" };
      if (command === "codegraph" && args[0] === "install") return { stdout: "", stderr: "" };
      if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
      if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: allHealthyMcpList(), stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };

    await depsSync(executor, configDir);

    const engramSetupIdx = callOrder.findIndex((c) => c.includes("engram setup"));
    const context7AddIdx = callOrder.findIndex((c) => c.includes("mcp add context7"));
    const codegraphInstallIdx = callOrder.findIndex((c) => c.includes("codegraph install"));

    if (engramSetupIdx >= 0 && context7AddIdx >= 0) {
      expect(engramSetupIdx).toBeLessThan(context7AddIdx);
    }
    if (context7AddIdx >= 0 && codegraphInstallIdx >= 0) {
      expect(context7AddIdx).toBeLessThan(codegraphInstallIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// depsSync -- platform support
// ---------------------------------------------------------------------------

describe("depsSync -- platform support", () => {
  it("succeeds on current platform (linux x64)", async () => {
    const configDir = await makeConfigDirWith({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    });
    const home = homedir();
    const releasesJson = buildReleasesJson([
      { tag: "v1.20.0", assets: ["engram_1.20.0_linux_amd64.tar.gz"] },
    ]);
    const checksumsHash = "abc123";
    const executor = mockExecutor({
      "engram version": { stdout: "engram 1.19.0" },
      ...nonBrewMocks(`${home}/.local/bin/engram`, `${home}/.local/Cellar`),
      [`curl -fsSL https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100`]: { stdout: releasesJson },
      [`curl -fsSL -o`]: { stdout: "" },
      [`curl -fsSL`]: { stdout: "" },
      [`tar`]: { stdout: "" },
      [`find`]: { stdout: `${home}/.tmp/extract/engram`, stderr: "" },
      [`mkdir`]: { stdout: "", stderr: "" },
      [`cp`]: { stdout: "", stderr: "" },
      [`chmod`]: { stdout: "", stderr: "" },
      [`mv`]: { stdout: "", stderr: "" },
      [`rm`]: { stdout: "", stderr: "" },
      [`engram setup opencode`]: { stdout: "", stderr: "" },
      ...codegraphMocks,
      "opencode --version": { stdout: "1.18.15" },
      "opencode mcp list": { stdout: allHealthyMcpList() },
    });

    const result = await depsSync(executor, configDir, githubFileOps(buildChecksumsTxt("engram_1.20.0_linux_amd64.tar.gz", checksumsHash), checksumsHash));
    expect(result.engram.action).not.toBe("unsupported-platform");
  });
});

// ---------------------------------------------------------------------------
// formatSyncResult
// ---------------------------------------------------------------------------

describe("formatSyncResult", () => {
  it("formats success", () => {
    const result: SyncResult = {
      ok: true,
      engram: { action: "synced (homebrew)", version: "1.20.0" },
      context7: { action: "configured" },
      codegraph: { action: "synced", version: "1.3.1" },
    };
    const output = formatSyncResult(result);
    expect(output).toContain("[OK] synced (homebrew) (1.20.0)");
    expect(output).toContain("[OK] configured");
    expect(output).toContain("[OK] synced (1.3.1)");
    expect(output).toContain("[OK] All required dependencies synchronized.");
  });

  it("formats failures", () => {
    const result: SyncResult = {
      ok: false,
      engram: { action: "setup-failed", error: "setup failed" },
      context7: { action: "already-configured" },
      codegraph: { action: "install-failed", error: "npm permission denied" },
    };
    const output = formatSyncResult(result);
    expect(output).toContain("[FAIL] setup failed");
    expect(output).toContain("[OK] already-configured");
    expect(output).toContain("[FAIL] npm permission denied");
    expect(output).toContain("[FAIL] Some dependencies failed to synchronize.");
  });
});

// ---------------------------------------------------------------------------
// resolveCommand
// ---------------------------------------------------------------------------

describe("resolveCommand", () => {
  it("returns command as-is with useComSpec: false on non-Windows", () => {
    expect(resolveCommand("npm", "/usr/bin:/bin", ".COM;.EXE", "linux")).toEqual({
      command: "npm",
      useComSpec: false,
    });
    expect(resolveCommand("opencode", "/usr/bin:/bin", ".COM;.EXE", "darwin")).toEqual({
      command: "opencode",
      useComSpec: false,
    });
  });

  it("resolves .cmd shim with useComSpec: true on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.cmd"), "@echo off");

    const result = resolveCommand("npm", binDir, ".CMD;.EXE", "win32");
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe(resolve(binDir, "npm.cmd"));
  });

  it("resolves .exe with useComSpec: false on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "git.exe"), "binary");

    const result = resolveCommand("git", binDir, ".CMD;.EXE", "win32");
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe(resolve(binDir, "git.exe"));
  });

  it("prefers .cmd over .exe when both exist on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.cmd"), "@echo off");
    await writeFile(resolve(binDir, "npm.exe"), "binary");

    const result = resolveCommand("npm", binDir, ".CMD;.EXE", "win32");
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe(resolve(binDir, "npm.cmd"));
  });

  it("uses .bat when .cmd is absent on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.bat"), "@echo off");

    // Include .BAT in pathExt since the test wants to resolve .bat shims
    const result = resolveCommand("npm", binDir, ".CMD;.BAT;.EXE", "win32");
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe(resolve(binDir, "npm.bat"));
  });

  it("resolves from PATH directory with spaces on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "Program Files", "npm");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.cmd"), "@echo off");

    const result = resolveCommand("npm", binDir, ".CMD", "win32");
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe(resolve(binDir, "npm.cmd"));
    // Verify the resolved path contains the space
    expect(result.command).toContain("Program Files");
  });

  it("passes through absolute path with extension on Windows", () => {
    const result = resolveCommand(
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Windows",
      ".EXE",
      "win32",
    );
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe("C:\\Program Files\\Git\\bin\\git.exe");
  });

  it("passes through forward-slash path with .cmd extension needing ComSpec", () => {
    const result = resolveCommand(
      "C:/Program Files/nodejs/npm.cmd",
      "C:\\Windows",
      ".CMD",
      "win32",
    );
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe("C:/Program Files/nodejs/npm.cmd");
  });

  it("passes through explicit .bat path needing ComSpec", () => {
    const result = resolveCommand(
      "D:\\tools\\script.bat",
      "C:\\Windows",
      ".BAT",
      "win32",
    );
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe("D:\\tools\\script.bat");
  });

  it("returns original command when not found in PATH on Windows", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);

    const result = resolveCommand("nonexistent", root, ".CMD;.EXE", "win32");
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe("nonexistent");
  });

  it("scans multiple PATH directories in directory-first order", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const firstDir = resolve(root, "first");
    const secondDir = resolve(root, "second");
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    // Place .exe in first dir, .cmd in second dir.
    // With directory-first iteration, firstDir wins over secondDir.
    await writeFile(resolve(firstDir, "npm.exe"), "binary");
    await writeFile(resolve(secondDir, "npm.cmd"), "@echo off");

    const pathEnv = [firstDir, secondDir].join(";");
    const result = resolveCommand("npm", pathEnv, ".CMD;.EXE", "win32");
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe(resolve(firstDir, "npm.exe"));
  });

  it("uses pathExt parameter to control extension scan order", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.cmd"), "@echo off");
    await writeFile(resolve(binDir, "npm.exe"), "binary");

    // With ".EXE;.CMD" order, .exe should win over .cmd
    const result = resolveCommand("npm", binDir, ".EXE;.CMD", "win32");
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe(resolve(binDir, "npm.exe"));
  });

  it("resolves extension from pathExt without leading dot", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(resolve(binDir, "npm.bat"), "@echo off");

    // pathExt entries without a leading dot are normalized
    const result = resolveCommand("npm", binDir, "BAT;CMD", "win32");
    expect(result.useComSpec).toBe(true);
    expect(result.command).toBe(resolve(binDir, "npm.bat"));
  });

  it("uses probe parameter instead of existsSync for file checks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rdc-cmd-"));
    tempDirs.push(root);
    const binDir = resolve(root, "bin");
    await mkdir(binDir, { recursive: true });

    // File exists on disk but probe overrides to return false for .cmd
    await writeFile(resolve(binDir, "npm.cmd"), "@echo off");
    await writeFile(resolve(binDir, "npm.exe"), "binary");

    const probeCalls: string[] = [];
    const probe = (path: string) => {
      probeCalls.push(path);
      // Return false for .cmd, true for .exe
      return path.endsWith(".exe");
    };

    const result = resolveCommand("npm", binDir, ".CMD;.EXE", "win32", probe);
    expect(result.useComSpec).toBe(false);
    expect(result.command).toBe(resolve(binDir, "npm.exe"));
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls.some((p) => p.endsWith(".cmd"))).toBe(true);
    expect(probeCalls.some((p) => p.endsWith(".exe"))).toBe(true);
  });

  it("defaultExecutor passes arguments as separate array elements (not concatenated)", async () => {
    // Verify that defaultExecutor preserves arguments containing characters
    // that could be dangerous if concatenated into a shell command string
    // (e.g. &, |, >, <, ^, %, !). On the current platform, resolveCommand
    // returns useComSpec: false, so the args go directly to execFileAsync.
    // The test validates that the executor correctly returns the argument
    // values, confirming they were passed as separate array elements.
    const result = await defaultExecutor("node", [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "arg&with&ampersand",
      "arg|with|pipe",
    ]);
    const parsed = JSON.parse(result.stdout) as string[];
    expect(parsed).toContain("arg&with&ampersand");
    expect(parsed).toContain("arg|with|pipe");
  });

  it("defaultExecutor executes a real command on the current platform", async () => {
    // Smoke test: defaultExecutor should work for a basic command.
    const result = await defaultExecutor("node", ["-e", "process.stdout.write('ok')"]);
    expect(result.stdout).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// buildComSpecArgs — CMD argument escaping
// ---------------------------------------------------------------------------

describe("buildComSpecArgs", () => {
  it("returns /s /c with the command as the first part of the command string", () => {
    const result = buildComSpecArgs("npm.cmd", ["install"]);
    expect(result).toEqual(["/s", "/c", '"npm.cmd install"']);
  });

  it("quotes arguments containing spaces", () => {
    const result = buildComSpecArgs("npm.cmd", ["arg with spaces"]);
    expect(result[0]).toBe("/s");
    expect(result[1]).toBe("/c");
    expect(result[2]).toBe('"npm.cmd "arg with spaces""');
  });

  it("escapes % as %% to prevent environment variable expansion", () => {
    const result = buildComSpecArgs("npm.cmd", ["%USERPROFILE%"]);
    expect(result[2]).toBe('"npm.cmd "%%USERPROFILE%%""');
  });

  it("escapes ! as !! to prevent delayed expansion", () => {
    const result = buildComSpecArgs("npm.cmd", ["hello!"]);
    expect(result[2]).toBe('"npm.cmd "hello!!""');
  });

  it("escapes & as it is a CMD command separator", () => {
    const result = buildComSpecArgs("npm.cmd", ["build & test"]);
    expect(result[2]).toBe('"npm.cmd "build & test""');
  });

  it("escapes | as it is a CMD pipe operator", () => {
    const result = buildComSpecArgs("npm.cmd", ["grep | sort"]);
    expect(result[2]).toBe('"npm.cmd "grep | sort""');
  });

  it("escapes > as it is a CMD redirect operator", () => {
    const result = buildComSpecArgs("npm.cmd", ["out > file.txt"]);
    expect(result[2]).toBe('"npm.cmd "out > file.txt""');
  });

  it("escapes < as it is a CMD redirect operator", () => {
    const result = buildComSpecArgs("npm.cmd", ["input < file.txt"]);
    expect(result[2]).toBe('"npm.cmd "input < file.txt""');
  });

  it("escapes ^ as it is a CMD escape character", () => {
    const result = buildComSpecArgs("npm.cmd", ["a^b"]);
    // The outer " wraps everything; start of string after outer " should be npm.cmd
    expect(result[2]!.startsWith('"npm.cmd "')).toBe(true);
    expect(result[2]).toContain("a^b");
  });

  it("escapes internal double quotes as \"\" inside outer quotes", () => {
    const result = buildComSpecArgs("npm.cmd", ['say "hello"']);
    expect(result[2]).toBe('"npm.cmd "say ""hello""""');
  });

  it("does not quote simple alphanumeric arguments", () => {
    const result = buildComSpecArgs("npm.cmd", ["install", "lodash", "--save"]);
    expect(result[2]).toBe('"npm.cmd install lodash --save"');
  });

  it("quotes the command itself when it contains spaces", () => {
    const result = buildComSpecArgs("C:\\Program Files\\nodejs\\npm.cmd", ["install"]);
    // The command path is quoted (has spaces), and the whole thing is outer-quoted.
    expect(result[2]).toBe('""C:\\Program Files\\nodejs\\npm.cmd" install"');
  });

  it("handles multiple mixed arguments correctly", () => {
    const result = buildComSpecArgs("npm.cmd", [
      "run",
      "build",
      "--name",
      "foo & bar",
      "--out",
      ">NUL",
      '--msg',
      'say "%PATH%"',
    ]);
    expect(result[2]).toBe(
      '"npm.cmd run build --name "foo & bar" --out ">NUL" --msg "say ""%%PATH%%""""'
    );
  });

  it("metacharacters are always safe from interpretation", () => {
    // Each metacharacter is verified to appear only inside quotes
    // and escaped when needed, making it impossible for cmd.exe to
    // interpret it as an operator.
    const metachars = ["&", "|", ">", "<", "^", "%", "!", '"'];
    for (const ch of metachars) {
      const result = buildComSpecArgs("test.cmd", [`data${ch}more`]);
      const cmdStr = result[2]!;
      // The command string after the command name should not contain
      // bare (unquoted, unescaped) metacharacters.
      const afterCommand = cmdStr.slice("test.cmd".length);
      // Every metacharacter in the args portion must be inside double quotes
      if (ch === "%") {
        // % is doubled: one input % produces %% in output
        expect(cmdStr).toContain("%%");
      } else if (ch === "!") {
        expect(cmdStr).toContain("!!");
      } else if (ch === '"') {
        // double quotes are doubled inside outer quotes: one " → ""
        expect(cmdStr).toContain('""');
      } else {
        // Other metacharacters are inside quotes
        expect(afterCommand).toContain(`"data${ch}more"`);
      }
    }
  });

  it("outer-quotes the command string for cmd /s /c so /s strips them", () => {
    // cmd /s /c strips the outer quotes, leaving the individually-quoted
    // parts for CMD's parser. This verifies the full outer-wrapping contract.
    const result = buildComSpecArgs("npm.cmd", ["install", "pkg"]);
    expect(result[0]).toBe("/s");
    expect(result[1]).toBe("/c");
    // Outer quotes wrap everything; /s strips them.
    expect(result[2]).toBe('"npm.cmd install pkg"');
  });

  it("outer-quotes complex commands with mixed individual quoting for cmd /s /c", () => {
    // Simulates a realistic ComSpec call: command path with spaces, args with metachars.
    const result = buildComSpecArgs("C:\\Program Files\\nodejs\\npm.cmd", [
      "run",
      "build",
      "--name",
      "foo & bar",
      "--flag",
      ">NUL",
    ]);
    // The /s flag strips the outer pair of quotes, leaving:
    // "C:\Program Files\nodejs\npm.cmd" run build --name "foo & bar" --flag ">NUL"
    expect(result[2]).toBe(
      '""C:\\Program Files\\nodejs\\npm.cmd" run build --name "foo & bar" --flag ">NUL""'
    );
  });
});

// ---------------------------------------------------------------------------
// defaultExecutor ComSpec branch
// ---------------------------------------------------------------------------

describe("defaultExecutor ComSpec branch", () => {
  // Hoisted tracking mock and intercept flag.
  // vi.hoisted runs before imports, so these are available to the mock factory.
  const { mockExecFile, interceptState } = vi.hoisted(() => {
    const state = { intercept: false };
    return { mockExecFile: vi.fn(), interceptState: state };
  });

  vi.mock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Import util.promisify.custom so we can replicate the real execFile's
    // custom promisify contract (resolves with { stdout, stderr }, not just stdout).
    const { promisify } = await vi.importActual<typeof import("node:util")>("node:util");
    const customSymbol = promisify.custom;

    function spyExecFile(file: string, args: string[], options: unknown, callback: unknown) {
      // Fix up the 3-arg case (promisify may omit options if fn.length !== 4)
      let opts: Record<string, unknown> | undefined;
      let cb: (err: unknown, stdout: unknown, stderr: unknown) => void;
      if (typeof options === "function") {
        cb = options as (err: unknown, stdout: unknown, stderr: unknown) => void;
        opts = undefined;
      } else {
        opts = options as Record<string, unknown> | undefined;
        cb = callback as (err: unknown, stdout: unknown, stderr: unknown) => void;
      }

      // Track every call so tests can assert on captured arguments
      mockExecFile(file, args, opts);

      // When intercepting ComSpec calls, fake success — we cannot run
      // cmd.exe on Linux, but the assertion happens before execution.
      if (interceptState.intercept && (file === "cmd.exe" || file.endsWith("\\cmd.exe"))) {
        cb(null, Buffer.from(""), Buffer.from(""));
        return;
      }

      // Delegate to the real execFile for everything else so existing
      // tests (e.g. defaultExecutor("node", ...)) still work.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.execFile as any)(file, args, opts, cb);
    }

    // Set the custom promisify symbol so promisify(spyExecFile) correctly
    // resolves with { stdout, stderr } instead of just the first value.
    (spyExecFile as unknown as Record<symbol, unknown>)[customSymbol] = function customPromisify(
      file: string,
      args: string[],
      options?: Record<string, unknown>,
    ): Promise<{ stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const cb = (err: Error | null, stdout: Buffer | string, stderr: Buffer | string) => {
          if (err) return reject(err);
          resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
        };
        spyExecFile(file, args, options, cb);
      });
    };

    return {
      ...actual,
      execFile: spyExecFile,
    };
  });

  let tempDir!: string;
  let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalPath: string | undefined;
  let originalComSpec: string | undefined;

  beforeEach(async () => {
    // Clear calls accumulated from tests in other describe blocks that
    // also exercise defaultExecutor (and thus the shared execFile mock).
    mockExecFile.mockClear();

    tempDir = await mkdtemp(resolve(tmpdir(), "rdc-comspec-"));
    tempDirs.push(tempDir);

    // Mock process.platform to "win32" so resolveCommand takes the Windows path
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    // Set PATH to the temp directory so resolveCommand finds the .cmd shim
    originalPath = process.env.PATH;
    process.env.PATH = tempDir;

    // Ensure ComSpec defaults to "cmd.exe" (no env override on Linux)
    originalComSpec = process.env.ComSpec;
    delete process.env.ComSpec;

    // Enable ComSpec call interception so we don't try to run cmd.exe
    interceptState.intercept = true;
  });

  afterEach(() => {
    platformSpy?.mockRestore();
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (originalComSpec !== undefined) {
      process.env.ComSpec = originalComSpec;
    } else {
      delete process.env.ComSpec;
    }
    interceptState.intercept = false;
    mockExecFile.mockClear();
  });

  /** Write a .cmd shim in the temp PATH dir and return its resolved path. */
  async function writeTestCmd(name = "test-cmd.cmd"): Promise<string> {
    const cmdPath = resolve(tempDir, name);
    await writeFile(cmdPath, "@echo off");
    return cmdPath;
  }

  // -----------------------------------------------------------------------
  // Basic ComSpec invocation
  // -----------------------------------------------------------------------

  it("invokes ComSpec for a .cmd shim found in PATH", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["hello"], { cwd: "/tmp" });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, execArgs, opts] = mockExecFile.mock.calls[0]!;
    expect(file).toBe("cmd.exe");
    expect(execArgs[0]).toBe("/s");
    expect(execArgs[1]).toBe("/c");
    expect(execArgs[2]).toBe(`"${cmdPath} hello"`);
    expect(opts).toHaveProperty("shell", false);
    expect(opts).toHaveProperty("cwd", "/tmp");
    expect(opts).toHaveProperty("timeout", 120_000);
  });

  it("passes shell: false to execFile even when no cwd is provided", async () => {
    await writeTestCmd();
    await defaultExecutor("test-cmd", ["arg"], {});

    const [, , opts] = mockExecFile.mock.calls[0]!;
    expect(opts).toHaveProperty("shell", false);
  });

  // -----------------------------------------------------------------------
  // Metacharacter escaping — one test per metacharacter (& | > < ^ % !)
  // -----------------------------------------------------------------------

  it("escapes & metacharacter in ComSpec command string", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["build & run"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    expect(execArgs[2]).toBe(`"${cmdPath} "build & run""`);
  });

  it("escapes | metacharacter in ComSpec command string", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["grep | sort"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    expect(execArgs[2]).toBe(`"${cmdPath} "grep | sort""`);
  });

  it("escapes > metacharacter in ComSpec command string", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["> NUL"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    expect(execArgs[2]).toBe(`"${cmdPath} "> NUL""`);
  });

  it("escapes < metacharacter in ComSpec command string", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["< input"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    expect(execArgs[2]).toBe(`"${cmdPath} "< input""`);
  });

  it("escapes ^ metacharacter in ComSpec command string", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["a^b"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    // ^ is a metacharacter; the arg should be quoted.
    expect(execArgs[2]!.startsWith(`"${cmdPath} "`)).toBe(true);
    expect(execArgs[2]).toContain('"a^b"');
  });

  it("doubles % to %% to prevent environment variable expansion", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["%USERPROFILE%"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    // % must be doubled, and the arg must be quoted (CMD_METACHAR_RE matches %)
    expect(execArgs[2]).toBe(`"${cmdPath} "%%USERPROFILE%%""`);
  });

  it("doubles ! to !! to prevent delayed expansion", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", ["hello!"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    // ! must be doubled, and the arg must be quoted
    expect(execArgs[2]).toBe(`"${cmdPath} "hello!!""`);
  });

  // -----------------------------------------------------------------------
  // Multi-arg and edge cases
  // -----------------------------------------------------------------------

  it("handles multiple arguments with mixed metacharacters", async () => {
    const cmdPath = await writeTestCmd();
    await defaultExecutor("test-cmd", [
      "run",
      "build",
      "--name",
      "foo & bar",
      "--flag",
      ">NUL",
    ]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    // buildComSpecArgs quotes each arg individually.
    // Simple args: run, build, --name, --flag (no quoting needed)
    // Dangerous args: "foo & bar", ">NUL" (quoted)
    // Outer wrap: /s strips
    expect(execArgs[2]).toBe(
      `"${cmdPath} run build --name "foo & bar" --flag ">NUL""`
    );
  });

  it("quotes the .cmd path itself when it contains spaces", async () => {
    // Create a directory with a space in the name
    const spacedDir = resolve(tempDir, "Program Files", "cmd-tools");
    await mkdir(spacedDir, { recursive: true });
    const fullPath = resolve(spacedDir, "test-cmd.cmd");
    await writeFile(fullPath, "@echo off");

    // PATH must include the spaced dir so resolveCommand finds the .cmd shim
    process.env.PATH = spacedDir;

    await defaultExecutor("test-cmd", ["install"]);

    const [, execArgs] = mockExecFile.mock.calls[0]!;
    // The resolved command path has spaces, so it gets individually quoted
    expect(execArgs[2]).toBe(`""${fullPath}" install"`);
  });

  it("invokes ComSpec with the default cmd.exe when ComSpec env is unset", async () => {
    await writeTestCmd();
    await defaultExecutor("test-cmd", ["arg"]);

    const [file] = mockExecFile.mock.calls[0]!;
    expect(file).toBe("cmd.exe");
  });
});
