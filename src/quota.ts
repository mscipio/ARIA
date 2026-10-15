import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { stripJsoncComments, type Executor } from "./deps.js";
import {
  defaultDelay,
  verifyPersistedThenConverge,
  type DelayFn,
  type ListConvergenceBound,
  type PersistedRead,
} from "./list-convergence.js";
import { openCodeGlobalDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Quota 5 dual policy (T007) — upgrade-only single owner
// ---------------------------------------------------------------------------
//
// Quota 5 stays optional: the setup bootstrap lifecycle (`ensureQuotaForLifecycle`
// in `./dependencies.js`: absent → install-if-missing via `installQuotaIfMissing`
// in `./bootstrap.js`; identified Quota 5 → gated update via `upgradeQuota` below)
// may manage it under safety/ownership gates. The legacy `deps sync` path
// (`depsSync` in `./deps.js`) remains non-version-chasing and does not
// independently chase or install Quota (`SyncResult` carries no quota field,
// and the setup file phases never write quota entries).
// This module is the single upgrade-only owner, consumed by the future
// `aria upgrade` orchestration (T010):
//
// - `checkQuotaUpgrade` is strictly read-only inventory (`opencode plugin
//   list` plus the XDG-contained global config): installed spec/version plus
//   a status. Unknown or unsafe targets report observed/unmanaged with zero
//   mutation.
// - `upgradeQuota` upgrades an already-installed Quota 5 ONLY when its
//   installed npm target is positively identified as Quota 5 (exactly one
//   distinct exact-semver `5.x` spec across the plugin list and the global
//   config) AND the native `opencode-quota update --dry-run` preview exits
//   cleanly for that target on OpenCode 2 with no downgrade risk.
//   Each attempted upgrade is validated (the plugin list still carries the
//   quota plugin exactly once and the global config still carries a quota
//   entry with unrelated entries preserved — the TUI and server surfaces)
//   and the snapshotted global config is rolled back where feasible.
//
// Failure anywhere before the apply leaves every file byte-identical. The
// package-cache cleanup the updater performs after its own config
// verification cannot be rolled back and is reported, never guessed.
//
// Evidence basis (read-only; no upstream installer was executed): Quota 5 is
// an OpenCode V2 server plugin (`@slkiser/opencode-quota.server`, providing
// the `quota_status` tool, slash commands, quota RPC for the TUI surfaces,
// and session hooks) installed as an npm spec such as
// `@slkiser/opencode-quota@5.0.2` in the global `plugins[]`. Its supported
// update mechanism is its own `update` command (`--dry-run` previews without
// writing; `--yes` applies only safe setting/cache work after the preview
// and never moves or deletes secrets). Quota 5 needs OpenCode 2: on
// OpenCode 1 the updater pins Quota to `@4`, so OpenCode 1 is an unsafe
// target for a Quota 5 upgrade and stays report-only.

/** npm package providing Quota. */
export const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";

/** V2 server plugin ID registered by the Quota package. */
export const QUOTA_PLUGIN_ID = "@slkiser/opencode-quota.server";

/** Only this major is eligible for a managed Quota upgrade. */
export const QUOTA_MAJOR = 5;

/** Binary invoked for the native update preview/apply (never for setup/sync). */
const QUOTA_UPDATE_BIN = "opencode-quota";

/**
 * Moving tags the updater keeps as written (never positively versioned, so
 * never eligible as an identified upgrade target).
 */
const QUOTA_MOVING_TAGS = new Set(["latest", "next", "4"]);

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * True when the text names exactly the Quota package (npm spec, plugin ID,
 * or config entry). A fork such as `@slkiser/opencode-quota-extra` does not
 * match: the character after the package name must end the name or start a
 * version/namespace suffix (`@`, `.`, `/`, `:`).
 */
export function mentionsQuotaPackage(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const index = text.indexOf(QUOTA_PACKAGE_NAME);
  if (index === -1) return false;
  const next = text[index + QUOTA_PACKAGE_NAME.length];
  return next === undefined || next === "@" || next === "." || next === "/" || next === ":";
}

export type QuotaChannel = "npm" | "foreign";

export interface QuotaSpecInfo {
  /** Raw spec text as found (config entry or plugin-list SOURCE). */
  spec: string;
  /** `npm` for exactly the Quota package; `foreign` for quota-related names on another channel. */
  channel: QuotaChannel;
  /** Pinned version or tag when the npm spec carries one; null when bare. */
  version: string | null;
}

/**
 * Classify a plugin spec string. Returns null when the spec is not
 * quota-related at all (unrelated entries are ignored, never upgraded).
 * Quota-related names that are not plain npm specs for exactly this package
 * (Git specs, file paths, local directories, similarly named forks that
 * passed the caller pre-filter) report the `foreign` channel so the adapter
 * fails closed with `unsupported-ownership` instead of guessing.
 */
export function describeQuotaSpec(spec: string): QuotaSpecInfo | null {
  if (!mentionsQuotaPackage(spec)) return null;
  if (spec === QUOTA_PACKAGE_NAME) return { spec, channel: "npm", version: null };
  if (spec.startsWith(`${QUOTA_PACKAGE_NAME}@`)) {
    const version = spec.slice(QUOTA_PACKAGE_NAME.length + 1);
    if (version.length === 0 || version.includes("/") || version.includes(" ") || version.includes("#")) {
      return { spec, channel: "foreign", version: null };
    }
    return { spec, channel: "npm", version };
  }
  return { spec, channel: "foreign", version: null };
}

/** Leading major of a dotted version; null when absent or unparseable. */
export function quotaMajor(version: string | null): number | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\./);
  const majorText = match?.[1];
  if (majorText === undefined) return null;
  const major = Number.parseInt(majorText, 10);
  return Number.isFinite(major) ? major : null;
}

/** V2 `opencode plugin list` row that names the Quota package. */
export interface QuotaListEntry {
  id: string;
  version: string;
  /** SOURCE column: the installed target. */
  target: string;
}

/**
 * Extract quota rows from `opencode plugin list` output. Returns null when
 * the output shape is unrecognized (never guessed); an empty array when the
 * list is recognized and carries no quota rows.
 */
export function quotaEntriesFromPluginList(stdout: string): QuotaListEntry[] | null {
  const lines = stdout.split("\n");
  if (lines.some((line) => line.trim().toLowerCase() === "no plugins found")) return [];
  const headerIndex = lines.findIndex((line) => /^\s*ID\s+VERSION\s+SOURCE\s*$/i.test(line));
  if (headerIndex === -1) return null;
  const entries: QuotaListEntry[] = [];
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    // ID and VERSION contain no spaces; SOURCE is the remainder (paths may
    // contain spaces).
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
    const id = match?.[1];
    const version = match?.[2];
    const target = match?.[3]?.trim();
    if (!id || !version || !target) continue;
    if (mentionsQuotaPackage(id) || mentionsQuotaPackage(target)) {
      entries.push({ id, version, target });
    }
  }
  return entries;
}

function specFromPluginEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const pkg = (entry as Record<string, unknown>)["package"];
    if (typeof pkg === "string") return pkg;
  }
  return null;
}

/** Every plugin spec string in the parsed global config (`plugins`/`plugin`). */
function allPluginSpecsFromConfig(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const root = parsed as Record<string, unknown>;
  const specs: string[] = [];
  for (const key of ["plugins", "plugin"] as const) {
    const list = root[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const spec = specFromPluginEntry(entry);
      if (spec !== null) specs.push(spec);
    }
  }
  return specs;
}

/** Quota plugin specs in the parsed global config (string/tuple/object forms). */
export function quotaSpecsFromConfig(parsed: unknown): string[] {
  return allPluginSpecsFromConfig(parsed).filter((spec) => mentionsQuotaPackage(spec));
}

export type QuotaIdentification =
  | { kind: "absent" }
  | { kind: "identified"; spec: string; version: string }
  | { kind: "unknown-target"; reason: string }
  | { kind: "unsupported-ownership"; reason: string };

/**
 * Positively identify the installed Quota target from the union of
 * plugin-list SOURCE values and global-config specs. Exactly one distinct
 * exact-semver `5.x` npm spec identifies; anything else fails closed:
 * absent (nothing installed), unknown-target (ambiguous or not positively
 * versioned — never guessed), or unsupported-ownership (foreign channel or
 * a major this policy does not upgrade).
 */
export function identifyQuotaTarget(listSpecs: string[], configSpecs: string[]): QuotaIdentification {
  const distinct = [...new Set([...listSpecs, ...configSpecs])];
  if (distinct.length === 0) return { kind: "absent" };
  if (distinct.length > 1) {
    return {
      kind: "unknown-target",
      reason: `multiple distinct quota targets observed (${distinct.join(", ")}); refusing to guess`,
    };
  }
  const spec = distinct[0];
  if (spec === undefined) return { kind: "absent" };
  const info = describeQuotaSpec(spec);
  if (info === null) {
    return { kind: "unknown-target", reason: `quota target is not positively identified (${spec})` };
  }
  if (info.channel !== "npm") {
    return {
      kind: "unsupported-ownership",
      reason: `quota installed from a non-npm channel (${spec}); ownership unsupported, leaving untouched`,
    };
  }
  if (info.version === null) {
    return {
      kind: "unknown-target",
      reason: `quota spec carries no version (${spec}); installed version not positively identified`,
    };
  }
  if (QUOTA_MOVING_TAGS.has(info.version)) {
    return {
      kind: "unknown-target",
      reason: `quota spec is a moving tag (${spec}); installed version not positively identified`,
    };
  }
  if (!EXACT_SEMVER_RE.test(info.version)) {
    return {
      kind: "unknown-target",
      reason: `quota version is not an exact release (${spec}); installed target not positively identified`,
    };
  }
  const major = quotaMajor(info.version);
  if (major !== QUOTA_MAJOR) {
    return {
      kind: "unsupported-ownership",
      reason: `quota major is ${major ?? "unknown"} (this policy upgrades only Quota ${QUOTA_MAJOR}); leaving untouched`,
    };
  }
  return { kind: "identified", spec, version: info.version };
}

type QuotaConfigState =
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "single"; path: string; raw: Buffer; specs: string[]; parsed: unknown; unparseable: boolean };

/**
 * Read the XDG-contained global config for quota specs. Both
 * `opencode.json` and `opencode.jsonc` existing is dual-file ambiguity
 * (T002): fail closed with `ambiguous` and mutate neither file.
 */
async function readQuotaConfigState(configDir?: string): Promise<QuotaConfigState> {
  const base = openCodeGlobalDir(configDir);
  const jsonPath = join(base, "opencode.json");
  const jsoncPath = join(base, "opencode.jsonc");
  let jsonRaw: Buffer | null = null;
  let jsoncRaw: Buffer | null = null;
  try {
    jsonRaw = await readFile(jsonPath);
  } catch {
    jsonRaw = null;
  }
  try {
    jsoncRaw = await readFile(jsoncPath);
  } catch {
    jsoncRaw = null;
  }
  if (jsonRaw !== null && jsoncRaw !== null) return { kind: "ambiguous" };
  if (jsonRaw !== null) {
    return parseQuotaConfigFile(jsonPath, jsonRaw, false);
  }
  if (jsoncRaw !== null) {
    return parseQuotaConfigFile(jsoncPath, jsoncRaw, true);
  }
  return { kind: "missing" };
}

function parseQuotaConfigFile(path: string, raw: Buffer, jsonc: boolean): QuotaConfigState {
  try {
    const text = raw.toString("utf8");
    const normalized = jsonc ? stripJsoncComments(text) : text;
    const parsed: unknown = JSON.parse(normalized);
    return { kind: "single", path, raw, specs: quotaSpecsFromConfig(parsed), parsed, unparseable: false };
  } catch {
    return { kind: "single", path, raw, specs: [], parsed: null, unparseable: true };
  }
}

async function runPluginList(executor: Executor): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const result = await executor("opencode", ["plugin", "list"]);
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false };
  }
}

function parseOpenCodeMajor(output: string): number | null {
  const match = output.match(/(\d+)\.\d+\.\d+/);
  const majorText = match?.[1];
  if (majorText === undefined) return null;
  const major = Number.parseInt(majorText, 10);
  return Number.isFinite(major) ? major : null;
}

export type QuotaCheckStatus = "skipped" | "unmanaged-observed" | "unknown-target" | "unsupported-ownership";

/**
 * T007 inventory semantics (existing vocabulary, no new statuses):
 * - `skipped` — informational: no Quota installation observed, nothing to do.
 * - `unmanaged-observed` — informational observation: a positively
 *   identified Quota 5 is present. This inventory never versions it;
 *   version action is owned exclusively by the gated `upgradeQuota` /
 *   bootstrap lifecycle below, never by `deps sync`.
 * - `unknown-target` — blocker/action-needed: the installed target is not
 *   positively identified (ambiguous sources, an unversioned spec, or a
 *   moving tag such as `@latest`). Fail-closed: no updater invocation and
 *   no mutation.
 * - `unsupported-ownership` — intentionally unmanaged: a foreign channel
 *   or a major outside the Quota 5 policy. Left untouched, never upgraded.
 */

export interface QuotaCheckResult {
  status: QuotaCheckStatus;
  installedSpec: string | null;
  installedVersion: string | null;
  detail: string;
}

/**
 * Strictly read-only Quota inventory for setup/sync reporting and the
 * future upgrade `--check` table: installed spec/version plus a status.
 * Never invokes the updater and never writes. Identified Quota 5 reports
 * `unmanaged-observed`: observed by this inventory while version action is
 * owned exclusively by the gated `upgradeQuota`/bootstrap lifecycle below,
 * and the legacy `deps sync` path performs no Quota installation or config
 * mutation. A moving tag such as `@latest` is never a positively
 * identified target: it reports `unknown-target` (fail-closed) and is
 * never upgraded, installed, or otherwise taken ownership of here.
 */
export async function checkQuotaUpgrade(executor: Executor, configDir?: string): Promise<QuotaCheckResult> {
  const listResult = await runPluginList(executor);
  const listEntries = listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
  const configState = await readQuotaConfigState(configDir);
  if (configState.kind === "ambiguous") {
    return {
      status: "unknown-target",
      installedSpec: null,
      installedVersion: null,
      detail: "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated",
    };
  }
  if (listEntries === null && configState.kind === "missing") {
    return {
      status: "unknown-target",
      installedSpec: null,
      installedVersion: null,
      detail: "plugin list unavailable and no global config observed; installed target not positively identified",
    };
  }
  const listSpecs = listEntries === null ? [] : listEntries.map((entry) => entry.target);
  const identified = identifyQuotaTarget(listSpecs, configState.kind === "single" ? configState.specs : []);
  if (identified.kind === "absent") {
    return { status: "skipped", installedSpec: null, installedVersion: null, detail: "no Quota installation observed; nothing to upgrade" };
  }
  if (identified.kind === "identified") {
    return {
      status: "unmanaged-observed",
      installedSpec: identified.spec,
      installedVersion: identified.version,
      detail: `Quota ${identified.version} observed (${identified.spec}); version action owned exclusively by the gated Quota adapter (setup bootstrap/upgrade path) — this inventory and deps sync perform no Quota installation or config mutation`,
    };
  }
  return { status: identified.kind, installedSpec: null, installedVersion: null, detail: identified.reason };
}

export type QuotaUpgradeStatus =
  | "upgraded"
  | "already-current"
  | "unmanaged-observed"
  | "unknown-target"
  | "unsupported-ownership"
  | "skipped"
  | "update-failed"
  | "validation-failed";

export interface QuotaUpgradeResult {
  status: QuotaUpgradeStatus;
  installedSpec: string | null;
  installedVersion: string | null;
  /** Quota spec after a successful upgrade; null unless `upgraded`. */
  resultingSpec: string | null;
  detail: string;
  /** True only when the native apply ran (config may have changed). */
  mutated: boolean;
  /** True when a config snapshot was restored after a failure. */
  rolledBack?: boolean;
}

export interface QuotaUpgradeOptions {
  /**
   * Explicit global config dir. The native updater honors only the
   * env-derived global root (the Executor carries no env seam), so a
   * divergent explicit dir fails closed as unmanaged-observed. Omit in
   * production to use the effective global dir.
   */
  configDir?: string;
  /**
   * Bounded runtime plugin-list window (defaults to the shared 3
   * polls/100ms). Retries repeat `opencode plugin list` observation only,
   * never another `update --yes`.
   */
  convergence?: ListConvergenceBound;
  /** Injectable clock (defaults to real setTimeout; fakes record, never sleep). */
  delay?: DelayFn;
}

function reportOnly(
  status: "unmanaged-observed" | "unknown-target" | "unsupported-ownership" | "skipped",
  installedSpec: string | null,
  installedVersion: string | null,
  detail: string,
): QuotaUpgradeResult {
  return { status, installedSpec, installedVersion, resultingSpec: null, detail, mutated: false };
}

async function restoreSnapshot(snapshot: { path: string; raw: Buffer } | null): Promise<boolean> {
  if (snapshot === null) return false;
  try {
    await writeFile(snapshot.path, snapshot.raw);
    return true;
  } catch {
    return false;
  }
}

function multisetEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of right) {
    const remaining = counts.get(item) ?? 0;
    if (remaining === 0) return false;
    counts.set(item, remaining - 1);
  }
  return true;
}

/**
 * Gated Quota 5 upgrade for `aria upgrade` (T010 wires this; setup and sync
 * never call it). Inventory first: the installed target must be positively
 * identified as Quota 5. Safety second: OpenCode must be major 2 (on major 1
 * the native updater would pin Quota to `@4`, a downgrade) and the native
 * `opencode-quota update --dry-run` preview must exit cleanly. Only then
 * `opencode-quota update --yes` applies, followed by validation that the
 * TUI and server surfaces survived (plugin list still carries the quota
 * plugin exactly once; the global config still carries a quota entry with
 * unrelated entries preserved). Validation failure rolls the snapshotted
 * global config back where feasible.
 */
export async function upgradeQuota(executor: Executor, options: QuotaUpgradeOptions = {}): Promise<QuotaUpgradeResult> {
  const configDir = options.configDir;

  // XDG guard: a divergent explicit dir is not honored by the native
  // updater, so a mutating update must not run against it.
  if (configDir !== undefined && resolve(configDir) !== resolve(openCodeGlobalDir())) {
    return reportOnly(
      "unmanaged-observed",
      null,
      null,
      "explicit config dir diverges from the effective OpenCode global dir; native updater targeting cannot be verified, leaving Quota untouched",
    );
  }

  const listResult = await runPluginList(executor);
  const listEntries = listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
  const configState = await readQuotaConfigState(configDir);
  if (configState.kind === "ambiguous") {
    return reportOnly(
      "unknown-target",
      null,
      null,
      "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated",
    );
  }
  if (listEntries === null && configState.kind === "missing") {
    return reportOnly(
      "unknown-target",
      null,
      null,
      "plugin list unavailable and no global config observed; installed target not positively identified",
    );
  }
  const listSpecs = listEntries === null ? [] : listEntries.map((entry) => entry.target);
  const identified = identifyQuotaTarget(listSpecs, configState.kind === "single" ? configState.specs : []);
  if (identified.kind === "absent") {
    return reportOnly("skipped", null, null, "no Quota installation observed; nothing to upgrade");
  }
  if (identified.kind === "unknown-target" || identified.kind === "unsupported-ownership") {
    return reportOnly(identified.kind, null, null, identified.reason);
  }

  // Safety gate 1: OpenCode major must be 2 for a Quota 5 upgrade.
  let openCodeMajor: number | null = null;
  try {
    const probed = await executor("opencode", ["--version"]);
    openCodeMajor = parseOpenCodeMajor(probed.stdout);
  } catch {
    openCodeMajor = null;
  }
  if (openCodeMajor !== 2) {
    return reportOnly(
      "unmanaged-observed",
      identified.spec,
      identified.version,
      openCodeMajor === null
        ? `Quota ${identified.version} identified (${identified.spec}) but the OpenCode version is not positively identified; native update safety cannot be demonstrated, leaving Quota untouched`
        : `Quota ${identified.version} identified (${identified.spec}) but OpenCode major is ${openCodeMajor} (Quota 5 needs OpenCode 2; the native updater would pin @4); leaving Quota untouched`,
    );
  }

  // Safety gate 2: the native read-only preview must exit cleanly.
  try {
    await executor(QUOTA_UPDATE_BIN, ["update", "--dry-run"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reportOnly(
      "unmanaged-observed",
      identified.spec,
      identified.version,
      `Quota ${identified.version} identified (${identified.spec}) but the native update preview failed (${reason}); leaving Quota untouched`,
    );
  }

  const snapshot = configState.kind === "single" ? { path: configState.path, raw: configState.raw } : null;
  const beforeNonQuota = configState.kind === "single" && !configState.unparseable
    ? allPluginSpecsFromConfig(configState.parsed).filter((spec) => !mentionsQuotaPackage(spec))
    : null;
  const beforeListText = listEntries === null ? null : JSON.stringify(listEntries);

  // Apply: safe setting/cache work only, after the demonstrated-safe preview.
  try {
    await executor(QUOTA_UPDATE_BIN, ["update", "--yes"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rolledBack = await restoreSnapshot(snapshot);
    return {
      status: "update-failed",
      installedSpec: identified.spec,
      installedVersion: identified.version,
      resultingSpec: null,
      detail: `native update failed (${reason}). ${
        snapshot === null
          ? "No global config snapshot existed; config state is exactly as the updater left it."
          : rolledBack
            ? `Global config restored to the pre-upgrade bytes (${snapshot.path}).`
            : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`
      }`,
      mutated: true,
      rolledBack,
    };
  }

  // Validate: persisted global config first (authoritative — the updater
  // may rewrite the exact pin, so any surviving quota entry plus
  // byte-preserved unrelated entries verifies it), then bounded runtime
  // plugin-list convergence. A stale first list sample retries
  // observation-only within the bound instead of rolling back a successful
  // update. Exactly one `update --yes` ran above; polls below repeat
  // `opencode plugin list` observation only, never mutation.
  // Malformed/unrecognized list output fails closed (never success).
  const verification = await verifyPersistedThenConverge(
    async (): Promise<PersistedRead<{ parsed: unknown; path: string; raw: Buffer; specs: string[] }>> => {
      const persisted = await readQuotaConfigState(configDir);
      if (persisted.kind === "ambiguous") {
        return {
          kind: "ambiguous",
          reason: "global opencode.json and opencode.jsonc both exist after the upgrade; dual-file ambiguity fails closed with neither file mutated",
        };
      }
      if (persisted.kind === "missing") {
        return { kind: "unreadable", reason: "global config is missing after the upgrade; config surface lost" };
      }
      if (persisted.unparseable) {
        return { kind: "unreadable", reason: `${persisted.path}: invalid JSON after the upgrade; config surface lost` };
      }
      return { kind: "ok", value: { parsed: persisted.parsed, path: persisted.path, raw: persisted.raw, specs: persisted.specs } };
    },
    (config) => {
      if (config.specs.length === 0) {
        return { ok: false, reason: "global config no longer carries a quota entry; config surface lost" };
      }
      if (beforeNonQuota !== null) {
        const afterNonQuota = allPluginSpecsFromConfig(config.parsed).filter((spec) => !mentionsQuotaPackage(spec));
        if (!multisetEqual(beforeNonQuota, afterNonQuota)) {
          return { ok: false, reason: "unrelated global plugin entries changed during the upgrade" };
        }
      }
      return { ok: true };
    },
    async () => {
      const listResult = await runPluginList(executor);
      return listResult.ok ? quotaEntriesFromPluginList(listResult.stdout) : null;
    },
    (entries) => {
      if (entries.length === 1) return { ok: true };
      return {
        ok: false,
        reason:
          entries.length === 0
            ? "quota plugin is no longer listed; registration surface lost"
            : "quota plugin is listed more than once; registration surface ambiguous",
      };
    },
    options.convergence ?? {},
    options.delay ?? defaultDelay,
  );

  if (verification.outcome !== "converged") {
    const rolledBack = await restoreSnapshot(snapshot);
    const problem = verification.reason ?? "runtime plugin list did not converge within the bound";
    return {
      status: "validation-failed",
      installedSpec: identified.spec,
      installedVersion: identified.version,
      resultingSpec: null,
      detail: `upgrade validation failed (${problem}). ${
        snapshot === null
          ? "No global config snapshot existed; state is exactly as the updater left it."
          : rolledBack
            ? `Global config restored to the pre-upgrade bytes (${snapshot.path}).`
            : `Global config restore failed; ${snapshot.path} is exactly as the updater left it.`
      }`,
      mutated: true,
      rolledBack,
    };
  }

  const afterEntries = verification.runtime;
  const afterQuotaSpec = quotaSpecsFromConfig(verification.persisted.parsed)[0] ?? null;

  // The updater is a no-op when already current: bytes prove it, so report
  // it instead of claiming an upgrade.
  // Convergence implies a single post-upgrade config read, so a missing
  // pre-upgrade snapshot means the config newly appeared (never identical).
  const configIdentical = snapshot === null ? false : verification.persisted.raw.equals(snapshot.raw);
  const listIdentical = beforeListText === null ? false : JSON.stringify(afterEntries) === beforeListText;
  if (configIdentical && listIdentical) {
    return {
      status: "already-current",
      installedSpec: identified.spec,
      installedVersion: identified.version,
      resultingSpec: null,
      detail: `Quota ${identified.version} is already current; native update changed no files`,
      mutated: false,
      rolledBack: false,
    };
  }
  const keptId = afterEntries[0]?.id ?? QUOTA_PLUGIN_ID;
  return {
    status: "upgraded",
    installedSpec: identified.spec,
    installedVersion: identified.version,
    resultingSpec: afterQuotaSpec ?? (afterEntries[0]?.target ?? null),
    detail: `Quota ${identified.version} upgraded via the native update; plugin list carries ${keptId} exactly once and unrelated global entries are preserved (restart OpenCode to load)`,
    mutated: true,
    rolledBack: false,
  };
}
