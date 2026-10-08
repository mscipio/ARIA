import { resolve } from "node:path";

import type { AriaCallerPaths } from "./setup.js";

// ---------------------------------------------------------------------------
// T019 — isolation guard for setup/lifecycle tests.
//
// Fails any test that resolves a default caller global path: pass every
// `setup()` `files:{globalConfigPath,agentsDir,...}` temp path (and any
// other resolved global path a test may write) through
// `assertNotCallerGlobalPath` before use. Under the `tests/setup.ts`
// sandbox the caller locations are captured pre-sandbox on `globalThis`;
// the fallback derives them from the current env (correct when the sandbox
// is active only if the caller had no XDG overrides — the primary path is
// the captured snapshot).
// ---------------------------------------------------------------------------

function capturedCaller(): AriaCallerPaths | undefined {
  return (globalThis as { __ARIA_CALLER_PATHS__?: AriaCallerPaths }).__ARIA_CALLER_PATHS__;
}

export function callerPathsSnapshot(): AriaCallerPaths {
  const captured = capturedCaller();
  if (captured) return captured;
  const home = process.env.HOME ?? "/nonexistent-aria-test-home";
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || undefined;
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || undefined;
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim() || undefined;
  return {
    home,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    engramDataDir: process.env.ENGRAM_DATA_DIR?.trim() || undefined,
    globalConfigDir: xdgConfigHome ? `${xdgConfigHome}/opencode` : `${home}/.config/opencode`,
    globalDataDir: xdgDataHome ? `${xdgDataHome}/opencode` : `${home}/.local/share/opencode`,
    globalStateDir: xdgStateHome ? `${xdgStateHome}/opencode` : `${home}/.local/state/opencode`,
  };
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`);
}

/** True when `candidate` is the caller global config dir (or inside it). */
export function isCallerGlobalPath(candidate: string): boolean {
  const caller = callerPathsSnapshot();
  return (
    isWithinOrEqual(caller.globalConfigDir, candidate) ||
    isWithinOrEqual(caller.globalDataDir, candidate) ||
    isWithinOrEqual(caller.globalStateDir, candidate)
  );
}

/**
 * Fail the test when `candidate` resolves to a caller global path.
 * Every `setup()` files temp path must pass this before use.
 */
export function assertNotCallerGlobalPath(candidate: string, label: string): void {
  if (isCallerGlobalPath(candidate)) {
    throw new Error(
      `${label} resolves to a caller global path (${candidate}); ` +
        `point it at an isolated temp dir instead (T019 harness isolation)`,
    );
  }
}
