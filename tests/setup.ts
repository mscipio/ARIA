import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

// ---------------------------------------------------------------------------
// T019 — global test-harness sandbox.
//
// Every test that may write (setup/lifecycle flows, CLI subprocesses, dep
// syncs) must resolve caller-independent paths. The ambient environment may
// carry caller locations (HOME, XDG_*_HOME, ENGRAM_DATA_DIR) that point at
// live workstation config (e.g. the isolated OpenCode V2 global config).
// Sandbox all five here so default resolution (`~/.config/opencode`,
// `$XDG_CONFIG_HOME/opencode`, Engram data) lands under a temp root even
// when a test omits explicit path overrides. Explicit per-test temp paths
// (`files:{globalConfigPath,agentsDir,...}`, isolated fixture envs) remain
// the primary containment; this sandbox is the backstop.
//
// The pre-sandbox caller locations are captured on `globalThis` so the
// ambient-canary regression and the isolation guard can prove the suite
// leaves caller config/data/state byte-identical.
// ---------------------------------------------------------------------------

export interface AriaCallerPaths {
  home: string;
  xdgConfigHome: string | undefined;
  xdgDataHome: string | undefined;
  xdgStateHome: string | undefined;
  engramDataDir: string | undefined;
  /** Caller global config/data/state roots the suite must never mutate. */
  globalConfigDir: string;
  globalDataDir: string;
  globalStateDir: string;
}

declare global {
  var __ARIA_CALLER_PATHS__: AriaCallerPaths | undefined;
  var __ARIA_SANDBOX_ROOT__: string | undefined;
}

function callerPaths(): AriaCallerPaths {
  const home = process.env.HOME ?? homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || undefined;
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || undefined;
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim() || undefined;
  const engramDataDir = process.env.ENGRAM_DATA_DIR?.trim() || undefined;
  return {
    home,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    engramDataDir,
    globalConfigDir: xdgConfigHome ? join(xdgConfigHome, "opencode") : join(home, ".config", "opencode"),
    globalDataDir: xdgDataHome ? join(xdgDataHome, "opencode") : join(home, ".local", "share", "opencode"),
    globalStateDir: xdgStateHome ? join(xdgStateHome, "opencode") : join(home, ".local", "state", "opencode"),
  };
}

const caller = callerPaths();
globalThis.__ARIA_CALLER_PATHS__ = caller;

const savedEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  ENGRAM_DATA_DIR: process.env.ENGRAM_DATA_DIR,
};

const sandboxRoot = mkdtempSync(resolve(tmpdir(), "aria-vitest-sandbox-"));
globalThis.__ARIA_SANDBOX_ROOT__ = sandboxRoot;

const sandbox = {
  HOME: join(sandboxRoot, "home"),
  XDG_CONFIG_HOME: join(sandboxRoot, "config"),
  XDG_DATA_HOME: join(sandboxRoot, "data"),
  XDG_STATE_HOME: join(sandboxRoot, "state"),
  ENGRAM_DATA_DIR: join(sandboxRoot, "engram-data"),
};
for (const dir of Object.values(sandbox)) mkdirSync(dir, { recursive: true });

// Guard: the sandbox must not coincide with any caller location (a shared
// tmpdir prefix is fine; exact equality would mean no isolation).
for (const [key, dir] of Object.entries(sandbox)) {
  const callerDir = key === "HOME"
    ? caller.home
    : key === "XDG_CONFIG_HOME"
      ? caller.xdgConfigHome
      : key === "XDG_DATA_HOME"
        ? caller.xdgDataHome
        : key === "XDG_STATE_HOME"
          ? caller.xdgStateHome
          : caller.engramDataDir;
  if (callerDir && resolve(callerDir) === resolve(dir)) {
    throw new Error(`T019 sandbox collision: ${key} sandbox equals the caller value (${callerDir})`);
  }
}

process.env.HOME = sandbox.HOME;
process.env.XDG_CONFIG_HOME = sandbox.XDG_CONFIG_HOME;
process.env.XDG_DATA_HOME = sandbox.XDG_DATA_HOME;
process.env.XDG_STATE_HOME = sandbox.XDG_STATE_HOME;
process.env.ENGRAM_DATA_DIR = sandbox.ENGRAM_DATA_DIR;

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandboxRoot, { recursive: true, force: true });
});
