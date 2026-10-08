import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { setup } from "../src/lifecycle.js";
import { defaultGlobalConfigPath } from "../src/setup-config.js";
import { assertNotCallerGlobalPath, callerPathsSnapshot } from "./test-isolation.js";

// ---------------------------------------------------------------------------
// T019 — ONE ambient-canary regression.
//
// Proves the setup/lifecycle suite leaves caller config/data/state
// byte-identical: canary files are pre-seeded in the live caller roots,
// the previously-leaking `setup()` flows run under the restored ambient
// (caller) env with explicit temp `files` paths, and the caller roots are
// asserted byte-identical afterwards (canaries untouched, no new/modified/
// deleted bytes). Canaries are removed at the end, restoring the exact
// pre-test state. Without explicit `files` isolation these same flows
// wrote `file://...rdc-lifecycle-*` registrations into the caller config.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type DirSnapshot =
  | { exists: false }
  | { exists: true; entries: Record<string, string> };

async function snapshotDir(dir: string): Promise<DirSnapshot> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { exists: false };
  } catch {
    return { exists: false };
  }
  const entries: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries[relative(dir, full)] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }
  await walk(dir);
  return { exists: true, entries };
}

/**
 * Files under `dir` modified at/after `sinceMs` whose bytes contain `marker`.
 * Bounds the scan to the test window: live daemon stores (logs, WAL) mutate
 * continuously, so only recently-touched files can implicate this run.
 * Unreadable files are skipped (the strict config-dir snapshot above remains
 * the authoritative byte-identical proof).
 */
async function recentFilesContaining(dir: string, marker: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    return found;
  }
  if (!isDir) return found;
  async function walk(current: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      try {
        const info = await stat(full);
        if (info.isDirectory()) {
          await walk(full);
        } else if (info.isFile() && info.mtimeMs >= sinceMs - 1000) {
          const text = await readFile(full, "utf8");
          if (text.includes(marker)) found.push(relative(dir, full));
        }
      } catch {
        // Transient/unreadable: not provable as a leak vector; skip.
      }
    }
  }
  await walk(dir);
  return found.sort();
}

async function makeFixtureCheckout(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rdc-canary-"));
  tempDirs.push(root);
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "aria.mjs"), "#!/usr/bin/env node\n");
  return root;
}

function mockExecutorFor(checkout: string, listed: boolean): Executor {
  return async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "opencode plugin list") {
      return {
        stdout: listed ? ["ID  VERSION  SOURCE", `aria  local  ${checkout}`].join("\n") : "No plugins found",
        stderr: "",
      };
    }
    if (key === `opencode plugin add ${checkout}`) return { stdout: "plugin registered", stderr: "" };
    throw new Error(`Unexpected command: ${key}`);
  };
}

const okSync = async () => ({ ok: true, engram: { action: "ok" }, context7: { action: "ok" }, codegraph: { action: "ok" } });

describe("T019 ambient canary", () => {
  it("leaves caller config/data/state byte-identical while setup runs under the ambient env", async () => {    const caller = callerPathsSnapshot();

    // Sanity: the harness sandbox is active (current env is not the caller).
    expect(resolve(process.env.HOME as string)).not.toBe(resolve(caller.home));
    // And the guard recognizes the caller roots as caller paths.
    assertNotCallerGlobalPath(resolve(tmpdir(), "aria-canary-probe"), "canary probe");

    const roots = [caller.globalConfigDir, caller.globalDataDir, caller.globalStateDir];
    // Live daemons append to data/state stores (logs, WAL) continuously, so
    // those roots are not byte-stable across any time window and are never
    // snapshotted. The config root is the suite's write surface: it is
    // snapshotted strictly. Data/state are covered by the windowed leak-
    // marker scan below (no file touched during this run may reference this
    // run's fixture checkouts).
    const windowStartMs = Date.now();
    const configBefore = await snapshotDir(caller.globalConfigDir);
    const leakMarker = "rdc-canary-";

    // Pre-seed canary files (new unique names; caller bytes never modified).
    // Seeded in the config root always; in data/state roots only when the
    // root already exists (never create a caller root just for the canary).
    const canaryName = `__aria-t019-canary-${process.pid}.json`;
    const canaryContent = JSON.stringify({ canary: "t019", pid: process.pid });
    const seeded: string[] = [];
    for (const root of roots) {
      const exists = root === caller.globalConfigDir
        ? configBefore.exists
        : await stat(root).then((info) => info.isDirectory(), () => false);
      if (exists) {
        const canaryPath = join(root, canaryName);
        await writeFile(canaryPath, canaryContent);
        seeded.push(canaryPath);
      }
    }

    // Run the previously-leaking flows under the restored ambient env with
    // explicit temp files paths (the T019 containment under test).
    const sandboxEnv = { ...process.env };
    const restoreCallerEnv = () => {
      process.env.HOME = caller.home;
      if (caller.xdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = caller.xdgConfigHome;
      if (caller.xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = caller.xdgDataHome;
      if (caller.xdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = caller.xdgStateHome;
      if (caller.engramDataDir === undefined) delete process.env.ENGRAM_DATA_DIR;
      else process.env.ENGRAM_DATA_DIR = caller.engramDataDir;
    };
    try {
      restoreCallerEnv();
      // The ambient default really is the caller global path here — without
      // explicit `files` these flows would write to it (the original leak).
      expect(defaultGlobalConfigPath()).toBe(join(caller.globalConfigDir, "opencode.json"));

      for (const listed of [false, true]) {
        const checkout = await makeFixtureCheckout();
        const filesRoot = await mkdtemp(resolve(tmpdir(), "rdc-canary-files-"));
        tempDirs.push(filesRoot);
        const files = {
          globalConfigPath: join(filesRoot, "opencode.json"),
          agentsDir: join(filesRoot, "agents"),
          skillsRoot: join(filesRoot, "skills"),
        };
        assertNotCallerGlobalPath(files.globalConfigPath, "canary setup files.globalConfigPath");
        assertNotCallerGlobalPath(files.agentsDir, "canary setup files.agentsDir");
        const result = await setup(
          pathToFileURL(join(checkout, "bin", "aria.mjs")).href,
          mockExecutorFor(checkout, listed),
          okSync,
          { files },
        );
        expect(result.ok).toBe(true);
      }
    } finally {
      for (const [key, value] of Object.entries(sandboxEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // Caller config root byte-identical: canary untouched, nothing else
    // changed. (Data/state roots are live daemon stores — see marker scan.)
    {
      const after = await snapshotDir(caller.globalConfigDir);
      if (!configBefore.exists) {
        expect(after).toEqual({ exists: false });
      } else {
        expect(after.exists).toBe(true);
        const expected = { ...(configBefore as { entries: Record<string, string> }).entries };
        for (const canaryPath of seeded) {
          if (canaryPath.startsWith(`${caller.globalConfigDir}/`)) {
            expected[relative(caller.globalConfigDir, canaryPath)] = createHash("sha256")
              .update(canaryContent)
              .digest("hex");
          }
        }
        expect((after as { entries: Record<string, string> }).entries).toEqual(expected);
      }
    }
    // Every seeded canary intact, and no file touched during this run's
    // window references this run's fixture checkouts.
    for (const canaryPath of seeded) {
      expect(await readFile(canaryPath, "utf8")).toBe(canaryContent);
    }
    for (const root of roots) {
      expect(await recentFilesContaining(root, leakMarker, windowStartMs)).toEqual([]);
    }

    // Remove canaries: caller config root returns to the exact pre-test state.
    await Promise.all(seeded.map((path) => rm(path, { force: true })));
    expect(await snapshotDir(caller.globalConfigDir)).toEqual(configBefore);
    for (const canaryPath of seeded) {
      await expect(stat(canaryPath).then(() => true, () => false)).resolves.toBe(false);
    }
  }, 60000);
});
