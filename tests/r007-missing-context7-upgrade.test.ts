import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runDepsUpgrades, runSetupDependencies } from "../src/dependencies.js";
import type { Executor } from "../src/deps.js";
import { checkUpgradeInventory, formatDepsUpgradeProposal } from "../src/upgrade.js";
import { assertNotCallerGlobalPath } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// R007 — missing Context7 under `aria deps --upgrade` (focused regression
// with a TRULY all-missing config: no pre-seeded Context7).
//
// An absent/missing Context7 remote endpoint stays report-only under
// `--upgrade --yes` (never created/installed there); creation belongs
// exclusively to `aria setup`, which keeps installing it through the same
// shared lifecycle.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeIsolatedConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-r007-"));
  tempDirs.push(root);
  assertNotCallerGlobalPath(root, "temp root");
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

function expectSameTree(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
}

/** Mutating commands the confirmed missing-Context7 path must never run. */
const THIRD_PARTY_MUTATIONS = [
  "brew install",
  "brew upgrade",
  "npm install -g",
  "python3 -m pip install",
  "opencode plugin add",
  "opencode plugin remove",
  "opencode plugin update",
  "opencode-quota update",
  "engram setup",
  "codegraph install",
  "codegraph upgrade",
  "zotpilot upgrade",
  "zotpilot register",
  "zotpilot install",
];

/** All-missing world: no binary, no registration, no config file, no network. */
function missingWorldExecutor(calls: string[]): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const key = `${command} ${args.join(" ")}`;
    if (key === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
    if (key === "opencode mcp list") return { stdout: "MCP Servers\n", stderr: "" };
    if (key === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (key === "engram version") throw new Error("not found");
    if (key === "codegraph --version") throw new Error("not found");
    if (key === "zotpilot --version") throw new Error("not found");
    if (key === "npm view @slkiser/opencode-quota version") throw new Error("network unavailable");
    throw new Error(`Unexpected command: ${key}`);
  };
}

describe("R007 missing Context7 stays report-only under confirmed deps --upgrade", () => {
  it("proposal promises no action, confirmed path performs zero installs/creates, and the config stays byte-identical", async () => {
    const { root, configDir } = await makeIsolatedConfigDir();
    // TRULY all-missing: the config dir is empty (no pre-seeded Context7).
    const before = await snapshotTree(root);
    const calls: string[] = [];

    // (1) The unconfirmed proposal promises no action for the missing endpoint.
    const check = await checkUpgradeInventory(missingWorldExecutor(calls), {
      configDir,
      currentVersion: "1.0.15",
      availableOverride: null,
    });
    const context7Row = check.components.find((row) => row.component === "context7");
    expect(context7Row?.status).toBe("skipped");
    const proposal = formatDepsUpgradeProposal(check);
    expect(proposal).toContain("context7: installed=- available=- status=skipped");
    expect(proposal).toContain("no action: nothing installed (missing installs belong to `aria setup`)");
    expect(proposal).toContain("No changes were made.");

    // (2) The confirmed path (`aria deps --upgrade --yes` wiring) performs
    // zero installs/creates: every outcome skipped, nothing mutated.
    const confirmedCalls: string[] = [];
    const result = await runDepsUpgrades(missingWorldExecutor(confirmedCalls), { configDir });
    expect(result.outcomes.map((outcome) => outcome.component).sort()).toEqual([
      "codegraph",
      "context7",
      "engram",
      "quota",
      "zotpilot",
    ]);
    for (const outcome of result.outcomes) {
      expect(outcome.status).toBe("skipped");
      expect(outcome.mutated).toBe(false);
    }
    const context7 = result.outcomes.find((outcome) => outcome.component === "context7");
    expect(context7?.detail).toContain("aria setup");
    expect(result.ok).toBe(true);
    for (const call of confirmedCalls) {
      expect(THIRD_PARTY_MUTATIONS.some((mutation) => call.startsWith(mutation))).toBe(false);
    }

    // (3) The config tree is byte-identical: no file was created or modified.
    expectSameTree(before, await snapshotTree(root));
  });

  it("setup still installs the missing Context7 endpoint where required", async () => {
    const { configDir } = await makeIsolatedConfigDir();
    const calls: string[] = [];

    const result = await runSetupDependencies(missingWorldExecutor(calls), { configDir });

    const context7 = result.outcomes.find((outcome) => outcome.component === "context7");
    expect(context7?.status).toBe("completed");
    const written = JSON.parse(await readFile(join(configDir, "opencode.json"), "utf8")) as {
      mcp?: { servers?: { context7?: unknown } };
    };
    expect(written?.mcp?.servers?.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
  });
});
