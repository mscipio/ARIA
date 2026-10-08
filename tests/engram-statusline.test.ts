import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve } from "node:path";

import {
  cleanupIncompatibleStatusline,
  depsSync,
  detectIncompatibleStatusline,
  isIncompatibleStatuslineEntry,
  stripIncompatibleStatusline,
  type Executor,
} from "../src/deps.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-statusline-"));
  tempDirs.push(root);
  const configDir = resolve(root, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  return configDir;
}

function healthyExecutor(): Executor {
  const home = homedir();
  const cellarBin = `${home}/.local/Cellar/engram/1.20.0/bin/engram`;
  const healthyList = [
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
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
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
    if (command === "opencode" && args[0] === "--version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") return { stdout: healthyList, stderr: "" };
    throw new Error(`unexpected: ${key}`);
  };
}

describe("T005 statusline normalization (pure)", () => {
  it("matches only the exact incompatible entry", () => {
    expect(isIncompatibleStatuslineEntry("opencode-subagent-statusline")).toBe(true);
    expect(isIncompatibleStatuslineEntry("opencode-subagent-statusline ")).toBe(false);
    expect(isIncompatibleStatuslineEntry("other-plugin")).toBe(false);
    expect(isIncompatibleStatuslineEntry(undefined)).toBe(false);
    expect(isIncompatibleStatuslineEntry({ name: "opencode-subagent-statusline" })).toBe(false);
  });

  it("strips exact entries and preserves order plus unrelated values", () => {
    const { filtered, removed } = stripIncompatibleStatusline([
      "keep-a",
      "opencode-subagent-statusline",
      "keep-b",
      "opencode-subagent-statusline",
    ]);
    expect(removed).toBe(true);
    expect(filtered).toEqual(["keep-a", "keep-b"]);
  });

  it("reports no removal when absent", () => {
    const { filtered, removed } = stripIncompatibleStatusline(["keep-a", 42]);
    expect(removed).toBe(false);
    expect(filtered).toEqual(["keep-a", 42]);
  });
});

describe("T005 statusline cleanup (isolated config)", () => {
  it("removes the incompatible entry from cli.json/tui.json and preserves unrelated plugins and keys", async () => {
    const configDir = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "cli.json"),
      JSON.stringify(
        { $schema: "https://opencode.ai/v2/cli.json", plugins: ["opencode-subagent-statusline", "my-keep-plugin"] },
        null,
        2,
      ),
    );
    await writeFile(
      resolve(configDir, "tui.json"),
      JSON.stringify({ plugin: ["opencode-subagent-statusline", "other-keep"], theme: "dark" }, null, 2),
    );
    // Unrelated opencode.json must remain byte-identical (cleanup never touches it).
    const opencodeBefore = JSON.stringify({ plugins: ["github:mscipio/ARIA#v1.0.7"], skills: ["s"] }, null, 2);
    await writeFile(resolve(configDir, "opencode.json"), opencodeBefore);

    const detected = await detectIncompatibleStatusline(configDir);
    expect(detected.present).toBe(true);
    expect(detected.files).toHaveLength(2);

    const result = await cleanupIncompatibleStatusline(configDir);
    expect(result.removed).toBe(true);
    expect(result.removedFrom).toHaveLength(2);

    const cli = JSON.parse(await readFile(resolve(configDir, "cli.json"), "utf8"));
    expect(cli.plugins).toEqual(["my-keep-plugin"]);
    expect(cli.$schema).toBe("https://opencode.ai/v2/cli.json");

    const tui = JSON.parse(await readFile(resolve(configDir, "tui.json"), "utf8"));
    expect(tui.plugin).toEqual(["other-keep"]);
    expect(tui.theme).toBe("dark");

    expect(await readFile(resolve(configDir, "opencode.json"), "utf8")).toBe(opencodeBefore);

    const after = await detectIncompatibleStatusline(configDir);
    expect(after.present).toBe(false);
  });

  it("is a no-op when files are missing or the entry is absent", async () => {
    const configDir = await makeIsolatedConfigDir();
    const result = await cleanupIncompatibleStatusline(configDir);
    expect(result.removed).toBe(false);
    expect(result.removedFrom).toEqual([]);
  });

  it("leaves invalid JSON untouched (fail-closed per file)", async () => {
    const configDir = await makeIsolatedConfigDir();
    await writeFile(resolve(configDir, "cli.json"), "{ not json");
    const result = await cleanupIncompatibleStatusline(configDir);
    expect(result.removed).toBe(false);
    expect(await readFile(resolve(configDir, "cli.json"), "utf8")).toBe("{ not json");
  });
});

describe("T005 depsSync Engram flow removes statusline while preserving unrelated plugins", () => {
  it("homebrew Engram sync cleans pre-existing statusline entries in the isolated config", async () => {
    const configDir = await makeIsolatedConfigDir();
    await writeFile(
      resolve(configDir, "opencode.json"),
      JSON.stringify({ mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }),
    );
    await writeFile(
      resolve(configDir, "cli.json"),
      JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", plugins: ["opencode-subagent-statusline", "keep-me"] }),
    );
    await writeFile(
      resolve(configDir, "tui.json"),
      JSON.stringify({ plugin: ["opencode-subagent-statusline", "keep-tui"] }),
    );

    const result = await depsSync(healthyExecutor(), configDir);
    expect(result.engram.action).toBe("synced (homebrew)");

    const cli = JSON.parse(await readFile(resolve(configDir, "cli.json"), "utf8"));
    expect(cli.plugins).toEqual(["keep-me"]);
    const tui = JSON.parse(await readFile(resolve(configDir, "tui.json"), "utf8"));
    expect(tui.plugin).toEqual(["keep-tui"]);

    const after = await detectIncompatibleStatusline(configDir);
    expect(after.present).toBe(false);
  });
});
