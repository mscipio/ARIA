import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { depsSync, type Executor } from "../src/deps.js";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// T006 shared evidence gate: isolated filesystem integration.
//
// Proves depsSync performs zero config mutation for the non-managed
// CodeGraph/ZotPilot integrations: neither the intended V2 location
// (`mcp.servers.*` in the isolated global config) nor any legacy location
// (`mcp.codegraph` / `mcp.zotpilot` shapes, dual-file siblings, or files
// outside the isolated dir) is created, removed, or rewritten -- without
// executing any unsafe upstream installer.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
        const text = await readFile(path, "utf8");
        entries.set(path, text);
      } catch {
        await walk(path);
      }
    }
  }
  await walk(root);
  return entries;
}

function healthyMocks(calls: string[], codegraphVersion: string | null): Executor {
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
    if (command === "codegraph" && args[0] === "--version") {
      if (codegraphVersion === null) throw new Error("not found");
      return { stdout: codegraphVersion, stderr: "" };
    }
    if (command === "opencode" && args[0] === "--version") return { stdout: "1.18.15", stderr: "" };
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
      return {
        stdout: [
          "MCP Servers",
          "engram connected", "engram mcp --tools=agent",
          "context7 connected", "https://mcp.context7.com/mcp",
          "codegraph connected", "codegraph serve --mcp",
          "zotpilot connected", "zotpilot mcp serve",
          "4 server(s)",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
}

/** Isolated global config dir pre-seeded with a legacy codegraph entry + V2 context7. */
async function makeIsolatedDirWithLegacyCodegraph(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-t006-"));
  tempDirs.push(root);
  const configDir = resolve(root, "config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(configDir, "opencode.json"),
    JSON.stringify({
      mcp: {
        servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
        // Legacy shape previously written by the pre-gate upstream installer.
        codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true },
      },
    }),
  );
  return { root, configDir };
}

describe("T006 gate -- isolated filesystem (no legacy writes, no V2 writes)", () => {
  it("leaves the isolated config byte-identical when codegraph is present", async () => {
    const { root, configDir } = await makeIsolatedDirWithLegacyCodegraph();
    const before = await snapshotTree(root);
    const calls: string[] = [];

    const result = await depsSync(healthyMocks(calls, "1.3.1"), configDir);

    expect(result.codegraph.action).toBe("observed-not-managed");
    expect(result.codegraph.version).toBe("1.3.1");

    // No upstream installer ran (nothing to reconcile with).
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
    expect(calls).not.toContain("codegraph upgrade");
    // ZotPilot stays non-managed: depsSync never invokes a zotpilot command.
    expect(calls.some((call) => call === "zotpilot --version" || call.startsWith("zotpilot "))).toBe(false);

    // Intended (V2) and legacy paths alike are untouched: byte-identical tree.
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      expect(after.get(path)).toBe(bytes);
    }

    // Legacy entry preserved as-is; no V2 codegraph entry was manufactured.
    const written = JSON.parse(await readFile(resolve(configDir, "opencode.json"), "utf8"));
    expect(written?.mcp?.codegraph).toEqual({ type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true });
    expect(written?.mcp?.servers?.codegraph).toBeUndefined();
    expect(written?.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
  });

  it("leaves the isolated config byte-identical when codegraph is missing", async () => {
    const { root, configDir } = await makeIsolatedDirWithLegacyCodegraph();
    const before = await snapshotTree(root);
    const calls: string[] = [];

    const result = await depsSync(healthyMocks(calls, null), configDir);

    expect(result.codegraph.action).toBe("observed-not-managed");
    expect(result.codegraph.error).toBeUndefined();
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
    expect(calls.some((call) => call.startsWith("codegraph install"))).toBe(false);
    expect(calls).not.toContain("codegraph upgrade");
    expect(calls.some((call) => call === "zotpilot --version" || call.startsWith("zotpilot "))).toBe(false);

    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      expect(after.get(path)).toBe(bytes);
    }
  });
});
