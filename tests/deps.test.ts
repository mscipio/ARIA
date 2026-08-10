import { afterEach, describe, expect, it } from "vitest";
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
  stripJsoncComments,
  sha256File,
  syncEngramGitHub,
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
    expect(output).toContain("Review-Driven Coding 0.1.0");
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
