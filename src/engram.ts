// ---------------------------------------------------------------------------
// T012 — Engram lifecycle adapter (shared by `aria setup` and `aria upgrade`).
//
// Detect installed state (version + install channel: homebrew vs github
// asset), install-if-missing OR update-if-outdated via the demonstrated-safe
// path (detected channel + `engram setup opencode` + the T016 bootstrap
// evidence in `src/bootstrap.ts`), then configure/normalize V2/XDG and
// validate version + MCP connectivity.
//
// - Already-current short-circuits the version update but not the required
//   normalization (`engram setup opencode` + T005 statusline cleanup).
// - T005 statusline cleanup/normalization is REUSED by import from
//   `src/deps.ts`; no duplicate logic lives here.
// - Binding: this adapter is shared — callable directly by `aria setup`
//   (no handoff needed) AND post-handoff by `aria upgrade` via
//   `engramUpgradeComponent` (already-current ARIA needs no self-replacement).
// - XDG-contained: an explicit `configDir` that diverges from the effective
//   OpenCode global dir fails closed as report-only (the native
//   `engram setup opencode` honors only the env-derived root; the Executor
//   carries no env seam, so targeting cannot be verified — same guard as the
//   T007 Quota adapter). Dual `opencode.json` + `opencode.jsonc` ambiguity
//   likewise fails closed with zero mutation (T002).
// - Validation is version + `opencode mcp list` connectivity + statusline
//   absence; validation/setup failures restore the snapshotted global config
//   where feasible (the installed binary itself is left in place and
//   reported, same rule as the T016 bootstrap + T007 adapters).
// ---------------------------------------------------------------------------

import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BOOTSTRAP_EVIDENCE } from "./bootstrap.js";
import {
  cleanupIncompatibleStatusline,
  detectEngram,
  detectEngramSource,
  detectIncompatibleStatusline,
  detectMcpConnectivity,
  syncEngramGitHub,
  syncEngramHomebrew,
  type DependencyFileOps,
  type Executor,
} from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";

/** Demonstrated-safe missing-install evidence owning this adapter's path (T016). */
export const ENGRAM_BOOTSTRAP_EVIDENCE = BOOTSTRAP_EVIDENCE.find((entry) => entry.component === "engram");

/** Install channel as detected (`github` updates take the GitHub asset path). */
export type EngramChannel = "homebrew" | "unknown" | "missing";

export type EngramLifecycleStatus =
  | "installed"
  | "upgraded"
  | "already-current"
  | "report-only"
  | "install-failed"
  | "update-failed"
  | "setup-failed"
  | "validation-failed";

export interface EngramLifecycleResult {
  status: EngramLifecycleStatus;
  /** Version observed before any mutation (null when absent/unknown). */
  installedVersion: string | null;
  /** Version observed after a successful mutation (null unless installed/upgraded/current). */
  resultingVersion: string | null;
  channel: EngramChannel;
  detail: string;
  /** True only when a mutating command ran or a config file changed. */
  mutated: boolean;
  /** True when a config snapshot was restored after a failure. */
  rolledBack?: boolean;
  mcpConnected: boolean;
  statuslineAbsent: boolean;
}

export interface EngramLifecycleOptions {
  /** Explicit global config dir (XDG-contained; omits to the effective root). */
  configDir?: string;
  /** Filesystem seam for channel detection + GitHub-asset verification. */
  fileOps?: DependencyFileOps;
}

export interface EngramState {
  found: boolean;
  version: string | null;
  channel: EngramChannel;
}

/**
 * Read-only installed-state probe: version via `engram version` plus the
 * install channel via Homebrew-cellar ownership. `unknown` covers every
 * non-Homebrew existing install and takes the checksum-verified GitHub asset
 * path on update (per T016); `missing` means no binary was found. Never
 * mutates.
 */
export async function detectEngramState(executor: Executor, fileOps?: DependencyFileOps): Promise<EngramState> {
  const detected = await detectEngram(executor);
  if (!detected.found) return { found: false, version: null, channel: "missing" };
  const source = fileOps === undefined ? await detectEngramSource(executor) : await detectEngramSource(executor, fileOps);
  const channel: EngramChannel = source === "homebrew" ? "homebrew" : "unknown";
  return { found: true, version: detected.version, channel };
}

type FileSnapshot = { path: string; raw: Buffer | null };

function managedPaths(base: string): string[] {
  return [join(base, "opencode.json"), join(base, "opencode.jsonc"), join(base, "cli.json"), join(base, "tui.json")];
}

async function snapshotManagedFiles(base: string): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const path of managedPaths(base)) {
    try {
      snapshots.push({ path, raw: await readFile(path) });
    } catch {
      snapshots.push({ path, raw: null });
    }
  }
  return snapshots;
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<boolean> {
  let ok = true;
  for (const snapshot of snapshots) {
    try {
      if (snapshot.raw === null) {
        await rm(snapshot.path, { force: true });
      } else {
        await writeFile(snapshot.path, snapshot.raw);
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

async function snapshotsChanged(snapshots: FileSnapshot[]): Promise<boolean> {
  for (const snapshot of snapshots) {
    let current: Buffer | null = null;
    try {
      current = await readFile(snapshot.path);
    } catch {
      current = null;
    }
    if (snapshot.raw === null && current === null) continue;
    if (snapshot.raw === null || current === null) return true;
    if (!snapshot.raw.equals(current)) return true;
  }
  return false;
}

function reportOnly(channel: EngramChannel, detail: string): EngramLifecycleResult {
  return {
    status: "report-only",
    installedVersion: null,
    resultingVersion: null,
    channel,
    detail,
    mutated: false,
    mcpConnected: false,
    statuslineAbsent: false,
  };
}

async function tryExec(
  executor: Executor,
  command: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await executor(command, args);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Shared lifecycle: install-if-missing OR update-if-outdated via the
 * detected channel, then normalize (`engram setup opencode` + T005 cleanup)
 * and validate version + MCP connectivity.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `engramUpgradeComponent`); it takes no handoff payload
 * and performs no ARIA self-replacement.
 */
export async function ensureEngram(executor: Executor, options: EngramLifecycleOptions = {}): Promise<EngramLifecycleResult> {
  const configDir = options.configDir;
  const fileOps = options.fileOps;

  // XDG guard: the native `engram setup opencode` honors only the
  // env-derived global root (the Executor carries no env seam), so a
  // divergent explicit dir fails closed with zero executor calls.
  if (configDir !== undefined && resolve(configDir) !== resolve(openCodeGlobalDir())) {
    return reportOnly(
      "unknown",
      "explicit config dir diverges from the effective OpenCode global dir; native setup targeting cannot be verified, leaving Engram untouched",
    );
  }

  const base = openCodeGlobalDir(configDir);
  const snapshots = await snapshotManagedFiles(base);

  // Dual-file ambiguity (T002): never guess which file is redundant.
  const beforeJson = snapshots[0]?.raw ?? null;
  const beforeJsonc = snapshots[1]?.raw ?? null;
  if (beforeJson !== null && beforeJsonc !== null) {
    const jsonPath = snapshots[0]?.path ?? join(base, "opencode.json");
    const jsoncPath = snapshots[1]?.path ?? join(base, "opencode.jsonc");
    return reportOnly(
      "unknown",
      `global ${jsonPath} and ${jsoncPath} both exist; dual-file ambiguity fails closed with neither file mutated`,
    );
  }

  const initial = await detectEngramState(executor, fileOps);
  const wasMissing = !initial.found;

  // Run the demonstrated-safe install/update for the detected channel and
  // return the sync action for status mapping (validation happens below).
  type SyncAction = { action: string; version?: string; error?: string };
  let sync: SyncAction;
  if (wasMissing) {
    const brewProbe = await tryExec(executor, "which", ["brew"]);
    if (brewProbe.ok && brewProbe.stdout.trim() !== "") {
      const installed = await tryExec(executor, "brew", ["install", "gentleman-programming/tap/engram"]);
      if (installed.ok) {
        const setup = await tryExec(executor, "engram", ["setup", "opencode"]);
        if (setup.ok) {
          try {
            await cleanupIncompatibleStatusline(configDir);
          } catch {
            // Best-effort: setup already succeeded; cleanup failure is
            // surfaced by the statusline validation below, never masked here.
          }
        } else {
          const rolledBack = await restoreSnapshots(snapshots);
          const statusline = await detectIncompatibleStatusline(configDir);
          return {
            status: "setup-failed",
            installedVersion: null,
            resultingVersion: null,
            channel: "missing",
            detail: `engram setup opencode failed (${setup.stderr}); no version is established`,
            mutated: true,
            rolledBack,
            mcpConnected: false,
            statuslineAbsent: !statusline.present,
          };
        }
        const verify = await detectEngram(executor);
        if (!verify.found) {
          const rolledBack = await restoreSnapshots(snapshots);
          const statusline = await detectIncompatibleStatusline(configDir);
          return {
            status: "install-failed",
            installedVersion: null,
            resultingVersion: null,
            channel: "missing",
            detail: "engram not found after brew install; no version is established",
            mutated: true,
            rolledBack,
            mcpConnected: false,
            statuslineAbsent: !statusline.present,
          };
        }
        sync = { action: "synced (homebrew)", version: verify.version ?? undefined };
      } else {
        const github = fileOps === undefined
          ? await syncEngramGitHub(executor, undefined, configDir)
          : await syncEngramGitHub(executor, fileOps, configDir);
        sync = github;
      }
    } else {
      const github = fileOps === undefined
        ? await syncEngramGitHub(executor, undefined, configDir)
        : await syncEngramGitHub(executor, fileOps, configDir);
      sync = github;
    }
  } else if (initial.channel === "homebrew") {
    sync = await syncEngramHomebrew(executor, configDir);
  } else {
    const github = fileOps === undefined
      ? await syncEngramGitHub(executor, undefined, configDir)
      : await syncEngramGitHub(executor, fileOps, configDir);
    sync = github;
  }

  const PRE_MUTATION_ACTIONS = new Set([
    "unsupported-platform",
    "fetch-failed",
    "parse-failed",
    "no-asset",
    "tmpdir-failed",
    "download-failed",
    "checksum-download-failed",
    "checksum-read-failed",
    "checksum-entry-missing",
    "hash-compute-failed",
    "checksum-mismatch",
    "mkdir-failed",
    "extract-failed",
    "find-failed",
    "copy-failed",
    "chmod-failed",
    "replace-failed",
    "brew-update-failed",
  ]);
  const okActions = new Set(["synced (homebrew)", "synced (github)", "already-latest"]);
  if (!okActions.has(sync.action)) {
    const channel: EngramChannel = wasMissing ? "missing" : initial.channel;
    const statusline = await detectIncompatibleStatusline(configDir);
    if (PRE_MUTATION_ACTIONS.has(sync.action)) {
      return {
        status: wasMissing ? "install-failed" : "update-failed",
        installedVersion: initial.version,
        resultingVersion: null,
        channel,
        detail: sync.error ?? `Engram ${wasMissing ? "install" : "update"} failed (${sync.action}) with no persistent change`,
        mutated: false,
        mcpConnected: false,
        statuslineAbsent: !statusline.present,
      };
    }
    const rolledBack = await restoreSnapshots(snapshots);
    const kind: EngramLifecycleStatus = sync.action === "setup-failed" ? "setup-failed" : wasMissing ? "install-failed" : "update-failed";
    return {
      status: kind,
      installedVersion: initial.version,
      resultingVersion: null,
      channel,
      detail: `${sync.error ?? `Engram ${wasMissing ? "install" : "update"} failed (${sync.action})`}. Global config ${rolledBack ? "restored to the pre-change bytes" : "restore failed; state is exactly as left"}. The installed binary is left in place and reported, never guessed.`,
      mutated: true,
      rolledBack,
      mcpConnected: false,
      statuslineAbsent: !statusline.present,
    };
  }

  // Post-change validation: version + MCP connectivity + statusline absence.
  // The sync paths already ran best-effort statusline cleanup; one more
  // idempotent pass here guarantees the acceptance invariant without
  // duplicating the removal logic.
  try {
    await cleanupIncompatibleStatusline(configDir);
  } catch {
    // Surfaced below via the absence check.
  }
  const final = await detectEngram(executor);
  const mcp = await detectMcpConnectivity(executor);
  const statusline = await detectIncompatibleStatusline(configDir);
  const connected = mcp.engram === true;
  const absent = !statusline.present;
  const channel: EngramChannel = wasMissing ? (initial.channel === "missing" ? "missing" : initial.channel) : initial.channel;
  if (!final.found || !connected || !absent) {
    const rolledBack = await restoreSnapshots(snapshots);
    const problems = [
      !final.found ? "engram binary not found after change" : null,
      final.found && !final.version ? "engram version not positively identified after change" : null,
      !connected ? (mcp.listFailed === true ? "`opencode mcp list` unavailable; connectivity not positively confirmed" : "engram not connected in `opencode mcp list`") : null,
      !absent ? `incompatible statusline still registered (${statusline.files.join(", ")})` : null,
    ].filter((part): part is string => part !== null);
    return {
      status: "validation-failed",
      installedVersion: initial.version,
      resultingVersion: final.version,
      channel,
      detail: `post-change validation failed (${problems.join("; ")}). ${rolledBack ? "Global config restored to the pre-change bytes." : "Global config restore failed; state is exactly as left."} The installed binary is left in place and reported, never guessed.`,
      mutated: true,
      rolledBack,
      mcpConnected: connected,
      statuslineAbsent: absent,
    };
  }

  const changed = await snapshotsChanged(snapshots);
  const versionChanged = (initial.version ?? null) !== (final.version ?? null);
  if (wasMissing) {
    return {
      status: "installed",
      installedVersion: null,
      resultingVersion: final.version,
      channel,
      detail: `Engram ${final.version ?? "unknown"} installed via the demonstrated-safe ${sync.action === "synced (homebrew)" ? "Homebrew" : "GitHub asset"} path with \`engram setup opencode\`; validated via engram version + opencode mcp list (connected) with the incompatible statusline absent and unrelated entries preserved`,
      mutated: true,
      rolledBack: false,
      mcpConnected: true,
      statuslineAbsent: true,
    };
  }
  if (sync.action === "already-latest" || !versionChanged) {
    return {
      status: "already-current",
      installedVersion: initial.version,
      resultingVersion: final.version,
      channel,
      detail: `Engram ${final.version ?? "unknown"} is already current; version update short-circuited with required normalization applied (setup + statusline cleanup) and validated via engram version + opencode mcp list (connected)`,
      mutated: changed,
      rolledBack: false,
      mcpConnected: true,
      statuslineAbsent: true,
    };
  }
  return {
    status: "upgraded",
    installedVersion: initial.version,
    resultingVersion: final.version,
    channel,
    detail: `Engram ${initial.version ?? "unknown"} upgraded to ${final.version ?? "unknown"} via the detected ${initial.channel === "homebrew" ? "Homebrew" : "GitHub asset"} path with \`engram setup opencode\`; validated via engram version + opencode mcp list (connected) with the incompatible statusline absent and unrelated entries preserved`,
    mutated: true,
    rolledBack: false,
    mcpConnected: true,
    statuslineAbsent: true,
  };
}

/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.engram` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — Engram versions are
 * discovered at runtime (never a version database).
 */
export async function engramUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome> {
  void ctx.target;
  const result = await ensureEngram(ctx.executor, { configDir: ctx.configDir });
  switch (result.status) {
    case "installed":
    case "upgraded":
    case "already-current":
      return { component: "engram", status: "completed", detail: result.detail, mutated: result.mutated };
    case "report-only":
      return { component: "engram", status: "skipped", detail: result.detail, mutated: false };
    case "install-failed":
    case "update-failed":
    case "setup-failed":
    case "validation-failed":
      return {
        component: "engram",
        status: result.rolledBack === true ? "rolled-back" : "unresolved",
        detail: result.detail,
        mutated: true,
      };
  }
}
