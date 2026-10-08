import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTEXT7_REMOTE_URL,
  depsSync,
  doctor,
  isCanonicalContext7Entry,
  type Executor,
} from "../src/deps.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "t009-context7-"));
  tempDirs.push(root);
  const configDir = resolve(root, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  return configDir;
}

function healthyMcpList(): string {
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
    "3 server(s)",
  ].join("\n");
}

/** Executor for a Homebrew-managed engram; records every shell invocation. */
function syncExecutor(calls: string[]): Executor {
  const home = homedir();
  const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
  return async (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "engram" && args[0] === "version") return { stdout: "engram 1.20.0", stderr: "" };
    if (command === "brew" && args[0] === "list") return { stdout: "engram", stderr: "" };
    if (command === "which" && args[0] === "engram") return { stdout: cellarBin, stderr: "" };
    if (command === "brew" && args[0] === "--cellar") return { stdout: `${home}/.local/Cellar`, stderr: "" };
    if (command === "brew" && args[0] === "update") return { stdout: "", stderr: "" };
    if (command === "brew" && args[0] === "upgrade") return { stdout: "", stderr: "" };
    if (command === "engram" && args[0] === "setup") return { stdout: "", stderr: "" };
    if (command === "codegraph" && args[0] === "--version") return { stdout: "1.3.1", stderr: "" };
    if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: healthyMcpList(), stderr: "" };
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
}

describe("T009 Context7 remote-only adapter", () => {
  it("recognizes only the exact canonical remote entry", () => {
    expect(isCanonicalContext7Entry({ type: "remote", url: CONTEXT7_REMOTE_URL })).toBe(true);
    expect(isCanonicalContext7Entry({ type: "remote", url: CONTEXT7_REMOTE_URL, enabled: true })).toBe(true);
    expect(isCanonicalContext7Entry({ type: "remote", url: "https://mcp.context7.com/sse" })).toBe(false);
    expect(isCanonicalContext7Entry({ type: "local", command: ["context7"] })).toBe(false);
    expect(isCanonicalContext7Entry({ type: "remote", url: CONTEXT7_REMOTE_URL, enabled: false })).toBe(false);
    expect(isCanonicalContext7Entry("https://mcp.context7.com/mcp")).toBe(false);
    expect(isCanonicalContext7Entry(undefined)).toBe(false);
  });

  it("normalizes a wrong remote URL in place, preserving unrelated servers and keys", async () => {
    const configDir = await makeConfigDir();
    const before = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          context7: { type: "remote", url: "https://mcp.context7.com/sse" },
          engram: { type: "local", command: ["engram", "mcp"] },
        },
      },
      unrelated: { keep: true },
    };
    await writeFile(resolve(configDir, "opencode.json"), JSON.stringify(before));

    const calls: string[] = [];
    const result = await depsSync(syncExecutor(calls), configDir);

    expect(result.context7.action).toBe("configured");
    expect(result.context7.error).toBeUndefined();
    // Remote-only: no local package install/upgrade and no mcp-add shell.
    expect(calls.some((call) => call.includes("mcp add"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);

    const after = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8")) as {
      mcp?: { servers?: Record<string, unknown> };
      unrelated?: unknown;
      $schema?: unknown;
    };
    expect(after.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
    expect(after.mcp?.servers?.engram).toEqual({ type: "local", command: ["engram", "mcp"] });
    expect(after.unrelated).toEqual({ keep: true });
    expect(after.$schema).toBe("https://opencode.ai/config.json");

    const status = await doctor(syncExecutor([]), configDir);
    expect(status.context7.configured).toBe(true);
  });

  it("migrates a lone legacy entry to the canonical servers shape", async () => {
    const configDir = await makeConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { context7: { type: "remote", url: "https://old.example.com" } }, keep: 1 }),
    );

    const calls: string[] = [];
    const result = await depsSync(syncExecutor(calls), configDir);

    expect(result.context7.action).toBe("configured");
    const after = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8")) as {
      mcp?: Record<string, unknown>;
      keep?: unknown;
    };
    expect(after.mcp?.["servers"]).toEqual({ context7: { type: "remote", url: "https://mcp.context7.com/mcp" } });
    expect(after.mcp?.["context7"]).toBeUndefined();
    expect(after.keep).toBe(1);
  });

  it("fails closed on conflicting servers + legacy registrations, mutating nothing", async () => {
    const configDir = await makeConfigDir();
    const path = resolve(configDir, "opencode.json");
    await writeFile(
      path,
      JSON.stringify({
        mcp: {
          servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
          context7: { type: "remote", url: "https://other.example.com" },
        },
      }),
    );
    const before = await readFile(path, "utf8");

    const result = await depsSync(syncExecutor([]), configDir);

    expect(result.context7.action).toBe("add-failed");
    expect(result.context7.error).toContain("conflicting");
    expect(await readFile(path, "utf8")).toBe(before);

    const status = await doctor(syncExecutor([]), configDir);
    expect(status.context7.configured).toBe(false);
  });

  it("fails closed when both opencode.json and opencode.jsonc exist, leaving both byte-identical", async () => {
    const configDir = await makeConfigDir();
    const jsonPath = resolve(configDir, "opencode.json");
    const jsoncPath = resolve(configDir, "opencode.jsonc");
    await writeFile(jsonPath, JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: CONTEXT7_REMOTE_URL } } } }));
    await writeFile(jsoncPath, `{\n  // isolated jsonc\n  "mcp": {}\n}\n`);
    const beforeJson = await readFile(jsonPath, "utf8");
    const beforeJsonc = await readFile(jsoncPath, "utf8");

    const result = await depsSync(syncExecutor([]), configDir);

    expect(result.context7.action).toBe("add-failed");
    expect(result.context7.error).toContain("both");
    expect(await readFile(jsonPath, "utf8")).toBe(beforeJson);
    expect(await readFile(jsoncPath, "utf8")).toBe(beforeJsonc);
  });
});
