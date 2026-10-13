import { existsSync } from "node:fs";
import { join } from "node:path";

import { readPackageVersion } from "./agents.js";
import { codegraphUpgradeComponent } from "./codegraph.js";
import {
  context7UpgradeComponent,
  quotaLifecycleUpgradeComponent,
  type DependencyLifecycleResult,
} from "./dependencies.js";
import {
  defaultExecutor,
  depsSync,
  detectCodeGraph,
  detectContext7,
  detectEngram,
  detectMcpConnectivity,
  type Executor,
} from "./deps.js";
import { doctorExitCode, runDoctor } from "./doctor.js";
import { engramUpgradeComponent } from "./engram.js";
import { classifyAriaRegistration, parsePluginList } from "./lifecycle.js";
import { openCodeGlobalDir } from "./paths.js";
import { checkQuotaUpgrade } from "./quota.js";
import { zotpilotUpgradeComponent } from "./zotpilot.js";

// ---------------------------------------------------------------------------
// T010 — `aria upgrade` shared orchestration (single owner for upgrade
// inventory, approval gating, ARIA-target validation, bounded handoff, and
// before/after reporting).
//
// deps sync vs upgrade (the one definition; see `describeSyncVsUpgrade`):
// - `aria deps sync` normalizes the CURRENT installs (idempotent, no version
//   upgrades, no approval, Quota excluded). It is the same sync invoked by
//   `aria setup` and the post-update handoff.
// - `aria upgrade` is inventory → explicit approval → validate the ARIA
//   target BEFORE removal → T011 self-upgrade + bounded handoff → ONLY in
//   the new release: component upgrades → target-version-specific
//   normalization/registration → agent regen if required → deps sync →
//   doctor → before/after report.
//
// Handoff binds the exact validated target plus the approved component
// inventory. The new release continues without re-asking ONLY on an exact
// match; any target/scope drift stops for fresh approval. Pre-handoff
// failure leaves/restores the old registration where feasible or reports
// the exact unresolved state; post-handoff component failure stops with
// per-component completed/rolled-back/unresolved states and no global
// transactionality. After handoff the old code performs no further
// normalization, regen, sync, doctor, or reporting (recovery is limited to
// registration restoration plus failure reporting, owned by T011).
//
// Invariants: approval precedes ALL mutations; unknown ownership/version
// means no install; unrelated entries are preserved (adapters only touch
// their owned entries); everything is XDG-contained (explicit `configDir`
// seam, never hardcoded homes, no prod V1/session migration, no V1/0.6
// removal, no `.npmrc`); any git env (`PROCESS_LOCAL_GIT_ENV`) is spread
// per-call only, never assigned to `process.env`.
//
// Scope: T010 provides inventory/status/reporting plus handoff plumbing.
// The T011 self-upgrade adapter stays an injectable seam (fail-closed
// default); the T012/T013/T014 component upgrades plus the T017 Quota
// bootstrap and Context7 normalize run as REAL defaults post-handoff via the
// shared dependency lifecycle (`src/dependencies.js`) — this module never
// implements adapter internals, only wires them.
// ---------------------------------------------------------------------------

/** Git remote ARIA releases are discovered from (read-only `ls-remote`). */
export const ARIA_GIT_REMOTE = "https://github.com/mscipio/ARIA.git";

/** Exact Git package spec prefix for ARIA releases (T011 validates identity). */
export const ARIA_GIT_SPEC_PREFIX = "github:mscipio/ARIA#";

/**
 * Git environment for any upgrade-owned subprocess. Spread per-call only
 * (e.g. `{ ...process.env, ...PROCESS_LOCAL_GIT_ENV }` at the spawn site);
 * never assign to `process.env` and never persist to any file.
 */
export const PROCESS_LOCAL_GIT_ENV = { NPM_CONFIG_ALLOW_GIT: "all" } as const;

// ---------------------------------------------------------------------------
// T003 exact-package upgrade invocation (never bare `aria`).
//
// `bin/aria.mjs` dispatches `upgrade` by importing `../dist/upgrade.js` and
// `../dist/aria-upgrade.js` relative to its own location, so a bare
// `aria upgrade --yes` runs whatever `aria` resolves on PATH (for example
// the development checkout at 1.0.8) instead of the positively identified
// installed registration (for example `github:mscipio/ARIA#v1.0.7`). The
// executable form pins the package:
//
//   NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package <spec> -- aria upgrade --yes
//
// (`NPM_CONFIG_ALLOW_GIT=all npx --yes --package <spec> -- aria upgrade --yes` is equivalent.)
// The `NPM_CONFIG_ALLOW_GIT=all` prefix is the approved per-invocation process-local Git
// allowance (mirrors `PROCESS_LOCAL_GIT_ENV` spread per-call via the Executor `env` seam):
// it allows the one npm fetch of the exact Git spec without any global `npm config`,
// environment export, or `.npmrc` change (a bare `npm exec ...` without it fails with
// EALLOWGIT on Git specs). The
// `--` boundary keeps the `aria ...` argv from being parsed as npm
// options; `--package <spec>` selects the exact Git spec (never a local
// path, never a bare name). These builders are pure: they format argv and
// display strings only and never touch an executor, config, or the
// network. No launcher is needed: npm resolves the `aria` binary from the
// named package, and the dispatched release is that package's own code.
//
// T009 installed identity: the `<spec>` above is the positively identified
// OpenCode plugin registration (approved Git source plus exact release
// tag, resolved read-only by `checkUpgradeInventory` via `opencode plugin
// list`), never the running CLI package version. The CLI version only
// selects the code that executes inventory; it is reported separately
// (`cliVersion`) and never used for guidance or version comparison, so a
// dev CLI (for example 1.0.8) cannot steer guidance at an installed
// registration (for example v1.0.7) nor falsely report it already current.
// ---------------------------------------------------------------------------

/**
 * Derive the installed Git spec for guidance from a positively identified
 * bare `X.Y.Z` version (e.g. `1.0.6` → `github:mscipio/ARIA#v1.0.6`).
 * Anything else (null, dev/inexact versions) yields null and guidance
 * fails closed without guessing.
 */
export function installedSpecForGuidance(currentVersion: string | null): string | null {
  if (currentVersion === null) return null;
  if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) return null;
  return `${ARIA_GIT_SPEC_PREFIX}v${currentVersion}`;
}

/**
 * Pure npm argv for an approval run against the installed release:
 * `exec --yes --package <spec> -- aria upgrade --yes`. The caller
 * prefixes `npm` (or `npx`) and the approved per-invocation
 * `NPM_CONFIG_ALLOW_GIT=all` env (see `PROCESS_LOCAL_GIT_ENV`, spread
 * per-call via the Executor `env` seam, never global/`.npmrc`); the `--`
 * boundary and `--package` position
 * are part of the contract verified by regression tests.
 */
export function buildExactUpgradeApprovalArgv(installedSpec: string): string[] {
  return ["exec", "--yes", "--package", installedSpec, "--", "aria", "upgrade", "--yes"];
}

/** Display form of the exact-package approval invocation (pure). Includes the approved
 * per-invocation `NPM_CONFIG_ALLOW_GIT=all` prefix so the displayed command fetches the
 * exact Git spec without any global npm config or `.npmrc` change. */
export function formatExactUpgradeApprovalCommand(installedSpec: string): string {
  return `NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${installedSpec} -- aria upgrade --yes`;
}

/**
 * Approval guidance line for `formatUpgradeCheck` / `runUpgrade`
 * blocked-approval (pure, no mutation). Names the exact installed package
 * when it is positively identified; otherwise fails closed with no bare
 * invocation offered.
 */
export function formatApprovalGuidance(currentVersion: string | null, targetSpec: string): string {
  const installedSpec = installedSpecForGuidance(currentVersion);
  if (installedSpec === null) {
    return `Self-upgrade approval is withheld: the installed release is not positively identified as an exact version, so no exact-package invocation can be offered for ${targetSpec}. Establish identity, then re-run with fresh approval. No changes were made.`;
  }
  return `Self-upgrade: available — run \`${formatExactUpgradeApprovalCommand(installedSpec)}\` to approve the inventoried target (${targetSpec}) and component scope`;
}

/**
 * Blocked-approval detail for `runUpgrade` when `--yes` was not given
 * (pure, no mutation). Same exact-package rule as `formatApprovalGuidance`.
 */
export function formatBlockedApprovalDetail(currentVersion: string | null, targetSpec: string | null): string {
  const installedSpec = installedSpecForGuidance(currentVersion);
  if (installedSpec === null || targetSpec === null) {
    return "Explicit approval is required before any mutation. The installed release or available target is not positively identified, so no exact-package invocation can be offered. Establish identity, then re-run with fresh approval. No changes were made.";
  }
  return `Explicit approval is required before any mutation. Re-run with \`${formatExactUpgradeApprovalCommand(installedSpec)}\` to approve the inventoried target (${targetSpec}) and component scope. No changes were made.`;
}

/** Component inventory scope bound by `--check`, approval, and handoff. */
export const UPGRADE_COMPONENTS = ["aria", "engram", "context7", "codegraph", "zotpilot", "quota"] as const;

export type UpgradeComponentName = (typeof UPGRADE_COMPONENTS)[number];

/**
 * Upgrade-action states for the `--check` Component|Installed|Available|
 * Status table (existing vocabulary; T007 semantic categories, no new
 * statuses):
 * - blockers (`unknown-target` on ARIA): the release target is not
 *   positively identified, so self-upgrade cannot run — zero mutation.
 * - action-needed (`upgrade-available`, plus non-ARIA `unknown-target`
 *   where fresh evidence would resolve the row): a newer ARIA target is
 *   positively identified and waits on explicit approval, or a component
 *   row needs fresh evidence before any action.
 * - informational (`current`, `remote-healthy`, `skipped`): nothing to
 *   upgrade — installed already equals the available target, a remote-only
 *   endpoint is configured and connected (no version concept), or nothing
 *   is installed.
 * - intentionally unmanaged/unobservable (`unmanaged-observed`,
 *   `unsupported-ownership`): observed but not version-managed by this
 *   check (user-managed per policy, version currency established
 *   post-handoff by the owning adapter), or positively identified on a
 *   channel this pipeline will not upgrade and leaves untouched.
 * - `current`: installed equals the positively identified available target.
 * - `upgrade-available`: a newer available target is positively identified.
 * - `remote-healthy`: remote-only endpoint configured and connected (no
 *   version concept; nothing to upgrade).
 * - `unmanaged-observed`: observed but not version-managed by this check
 *   (user-managed per policy, or currency established post-handoff).
 * - `unsupported-ownership`: positively identified on a channel this
 *   pipeline will not upgrade (left untouched).
 * - `skipped`: absent (nothing to upgrade).
 * - `unknown-target`: installed or available not positively identified;
 *   for ARIA this blocks self-upgrade with zero mutation.
 */
export type UpgradeComponentStatus =
  | "current"
  | "upgrade-available"
  | "remote-healthy"
  | "unmanaged-observed"
  | "unsupported-ownership"
  | "skipped"
  | "unknown-target";

export interface UpgradeComponentRow {
  component: UpgradeComponentName;
  installed: string | null;
  available: string | null;
  status: UpgradeComponentStatus;
  detail: string;
}

/** Positively identified ARIA release target (exact Git identity). */
export interface AriaAvailableTarget {
  /** Release tag, e.g. `v1.0.7`. */
  tag: string;
  /** Bare version, e.g. `1.0.7`. */
  version: string;
  /** Exact install spec, e.g. `github:mscipio/ARIA#v1.0.7`. */
  spec: string;
}

export type AriaTargetDiscovery =
  | { kind: "known"; target: AriaAvailableTarget }
  | { kind: "unknown"; reason: string };

export interface UpgradeCheckOptions {
  /** Explicit global config dir (XDG-contained; defaults via env). */
  configDir?: string;
  /**
   * Pin the installed ARIA version (test/operator override for the
   * read-only plugin-registration probe; `undefined` probes `opencode
   * plugin list` for the positively identified registration, `null`
   * forces unknown). This is the installed registration, never the
   * running CLI package version.
   */
  currentVersion?: string | null;
  /**
   * Pin the running CLI version (reporting only; `undefined` reads the
   * package). Never used for guidance, comparison, or mutation.
   */
  cliVersion?: string | null;
  /**
   * Pin the available target (`undefined` discovers via read-only
   * `git ls-remote`; `null` forces unknown for tests/operator override).
   */
  availableOverride?: AriaAvailableTarget | null;
}

export interface UpgradeCheckResult {
  /** Installed ARIA version from the positively identified plugin registration (null when unknown). */
  currentVersion: string | null;
  /** Running CLI package version (reporting only; never used for guidance or comparison). */
  cliVersion: string | null;
  /**
   * Positively identified installed spec for exact-package guidance
   * (e.g. `github:mscipio/ARIA#v1.0.7`; null when the registration is
   * not positively identified, so no invocation can be offered).
   */
  installedSpec: string | null;
  available: AriaTargetDiscovery;
  /** True when self-upgrade must not run (unknown target or version). */
  selfUpgradeBlocked: boolean;
  blockReason: string | null;
  components: UpgradeComponentRow[];
}

// ---------------------------------------------------------------------------
// Current + available ARIA release discovery (read-only)
// ---------------------------------------------------------------------------

/** Installed ARIA version, or null when it cannot be positively read. */
export function readCurrentAriaVersion(): string | null {
  try {
    return readPackageVersion();
  } catch {
    return null;
  }
}

/**
 * T009 installed ARIA identity: the positively identified OpenCode plugin
 * registration (approved Git source plus exact release tag), never the
 * running CLI package version. Guidance, version comparison, and
 * self-upgrade blocking all derive from this identity; the running CLI
 * version is reported separately and never compared.
 */
export interface InstalledAriaIdentity {
  /** Bare installed version (e.g. `1.0.7`), or null when not positively identified. */
  version: string | null;
  /** Exact installed spec (e.g. `github:mscipio/ARIA#v1.0.7`), or null when not positively identified. */
  spec: string | null;
  /** Provenance for read-only details (never guessed). */
  note: string;
}

/** Installed identity from an explicit pin (test/operator override; trusted as stated). */
function installedIdentityFromPin(pin: string | null): InstalledAriaIdentity {
  if (pin === null) {
    return { version: null, spec: null, note: "installed ARIA version is not positively identified (pinned unknown)" };
  }
  const spec = installedSpecForGuidance(pin);
  if (spec === null) {
    return {
      version: pin,
      spec: null,
      note: `installed version ${pin} is not an exact release identity, so no exact-package invocation can be offered`,
    };
  }
  return { version: pin, spec, note: `installed ${pin} (${spec})` };
}

/**
 * Read-only installed-identity probe (`opencode plugin list`; never
 * mutates). Exactly one ARIA-identifying row (shared T012 rule in
 * `src/lifecycle.ts`, never deduplicated before the uniqueness decision)
 * with an exact `vX.Y.Z` tag identifies; zero registrations, multiple
 * rows (including duplicate identical specs), a foreign
 * (non-approved-source) `aria` id, or an inexact ref fails closed with
 * zero version evidence. Mirrors the source rule in
 * `src/aria-upgrade.ts` (`isAriaGitTarget`) without importing it (that
 * module imports this one).
 */
async function detectInstalledAriaIdentity(executor: Executor): Promise<InstalledAriaIdentity> {
  let stdout: string;
  try {
    stdout = (await executor("opencode", ["plugin", "list"])).stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      version: null,
      spec: null,
      note: `installed ARIA registration unknown (opencode plugin list failed: ${reason}); not guessed`,
    };
  }
  const { recognized, entries } = parsePluginList(stdout);
  if (!recognized) {
    return {
      version: null,
      spec: null,
      note: "installed ARIA registration unknown (unrecognized plugin list output); not guessed",
    };
  }
  // T013: row-level uniqueness via the shared T012 rule — identical specs
  // still count as multiple registrations (never deduplicated before the
  // uniqueness decision). Exactly one identifying row may proceed.
  const registration = classifyAriaRegistration(entries);
  if (registration.kind === "ambiguous") {
    const observed = registration.identifying.map((entry) => `${entry.id} ${entry.target}`).join(", ");
    return {
      version: null,
      spec: null,
      note: `installed ARIA registration ambiguous (multiple registrations: ${observed}); refusing to guess`,
    };
  }
  const approved = [...new Set(entries.filter((entry) => entry.target.startsWith(ARIA_GIT_SPEC_PREFIX)).map((entry) => entry.target))];
  const foreign = entries.filter((entry) => entry.id === "aria" && !entry.target.startsWith(ARIA_GIT_SPEC_PREFIX));
  if (approved.length > 1) {
    return {
      version: null,
      spec: null,
      note: `installed ARIA registration ambiguous (multiple distinct registrations: ${approved.join(", ")}); refusing to guess`,
    };
  }
  if (foreign.length > 0 && approved.length === 0) {
    return {
      version: null,
      spec: null,
      note: `installed ARIA registration is from an unapproved source (${foreign.map((entry) => entry.target).join(", ")}); ownership unsupported, leaving untouched`,
    };
  }
  if (foreign.length > 0) {
    return {
      version: null,
      spec: null,
      note: `installed ARIA registration conflicting (approved ${approved[0]} plus unapproved ${foreign.map((entry) => entry.target).join(", ")}); refusing to guess`,
    };
  }
  if (approved.length === 0) {
    return {
      version: null,
      spec: null,
      note: "installed ARIA registration is definitely absent (no approved ARIA Git registration in the recognized plugin list)",
    };
  }
  const spec = approved[0] as string;
  const tag = spec.slice(spec.lastIndexOf("#") + 1);
  if (!isExactReleaseTag(tag)) {
    return {
      version: null,
      spec: null,
      note: `installed ARIA ref is not an exact release identity (${spec}); refusing to guess`,
    };
  }
  return { version: tag.slice(1), spec, note: `installed ${tag.slice(1)} (${spec}) via opencode plugin list` };
}

const EXACT_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Exact `vX.Y.Z` release-tag predicate. Single source of truth shared by
 * release discovery/validation (T010) and the self-upgrade adapter (T011);
 * never duplicated.
 */
export function isExactReleaseTag(tag: string): boolean {
  return EXACT_TAG_RE.test(tag);
}

function compareSemver(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version
      .split("+")[0]!
      .split("-")[0]!
      .split(".")
      .map((chunk) => Number.parseInt(chunk, 10));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Parse read-only `git ls-remote` output into the newest exact `vX.Y.Z`
 * release tag. Dereferenced `^{[1]}` lines, non-tag refs, and non-exact
 * tags (prereleases, moving tags) never identify a target. Returns null
 * when no exact release tag is observed (never guessed).
 *
 * [1]: `^{}` suffix lines repeat the tag's object; the suffix is stripped
 * before matching, so annotated and lightweight tags behave identically.
 */
export function parseAriaRemoteRefs(lsRemoteOutput: string): AriaAvailableTarget | null {
  let best: string | null = null;
  for (const line of lsRemoteOutput.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref || !ref.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (!isExactReleaseTag(tag)) continue;
    const version = tag.slice(1);
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  if (best === null) return null;
  return { tag: `v${best}`, version: best, spec: `${ARIA_GIT_SPEC_PREFIX}v${best}` };
}

/** Read-only available-release probe (`git ls-remote`; never mutates). */
export async function discoverAvailableAriaTarget(executor: Executor = defaultExecutor): Promise<AriaTargetDiscovery> {
  let stdout: string;
  try {
    const result = await executor("git", ["ls-remote", ARIA_GIT_REMOTE]);
    stdout = result.stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "unknown", reason: `available ARIA release is unknown (git ls-remote failed: ${reason})` };
  }
  const target = parseAriaRemoteRefs(stdout);
  if (!target) {
    return { kind: "unknown", reason: "available ARIA release is unknown (no exact vX.Y.Z release tag observed)" };
  }
  return { kind: "known", target };
}

/**
 * Pre-removal gate: the requested target must be positively identified and
 * exactly shaped BEFORE the current registration is touched. Unknown or
 * misshapen targets fail closed with zero mutation.
 */
export function validateAriaTargetForRemoval(
  target: AriaAvailableTarget | null,
): { ok: true } | { ok: false; reason: string } {
  if (!target) {
    return { ok: false, reason: "ARIA available target is unknown; self-upgrade blocked with zero mutation" };
  }
  if (!isExactReleaseTag(target.tag) || target.version !== target.tag.slice(1) || target.spec !== `${ARIA_GIT_SPEC_PREFIX}${target.tag}`) {
    return { ok: false, reason: `ARIA target is not an exact release identity (${target.spec}); refusing to remove the current registration` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Read-only component inventory (`--check` never mutates)
// ---------------------------------------------------------------------------

function ariaRow(installed: InstalledAriaIdentity, available: AriaTargetDiscovery): UpgradeComponentRow {
  // T009: comparison requires approved-source version evidence on BOTH
  // sides. A registration without a positively identified spec (foreign
  // source, ambiguous, absent, unknown) never compares — even an
  // equal tag from a foreign source stays unknown-target, never current.
  const current = installed.version !== null && installed.spec !== null ? installed.version : null;
  if (current === null || available.kind === "unknown") {
    const reason = current === null
      ? installed.note
      : available.kind === "unknown"
        ? available.reason
        : installed.note;
    return {
      component: "aria",
      installed: current,
      available: null,
      status: "unknown-target",
      detail: `${reason}; self-upgrade blocked with zero mutation`,
    };
  }
  if (current === available.target.version) {
    return {
      component: "aria",
      installed: current,
      available: available.target.tag,
      status: "current",
      detail: `installed ${current} equals available ${available.target.tag}; nothing to upgrade`,
    };
  }
  if (compareSemver(available.target.version, current) > 0) {
    return {
      component: "aria",
      installed: current,
      available: available.target.tag,
      status: "upgrade-available",
      detail: `available ${available.target.tag} (${available.target.spec}) supersedes installed ${current}`,
    };
  }
  return {
    component: "aria",
    installed: current,
    available: available.target.tag,
    status: "current",
    detail: `installed ${current} is ahead of latest known tag ${available.target.tag}; nothing to upgrade`,
  };
}

function dualConfigAmbiguous(configDir?: string): { ambiguous: boolean; jsonPath: string; jsoncPath: string } {
  const base = openCodeGlobalDir(configDir);
  const jsonPath = join(base, "opencode.json");
  const jsoncPath = join(base, "opencode.jsonc");
  return { ambiguous: existsSync(jsonPath) && existsSync(jsoncPath), jsonPath, jsoncPath };
}

/**
 * Strictly read-only inventory: current AND available ARIA releases plus
 * one row per component. Probes are `git ls-remote`, `opencode plugin
 * list`, `opencode mcp list`, `engram version`, `codegraph --version`,
 * and XDG-contained config file reads — no installer, updater, writer,
 * or mutating CLI is ever invoked here.
 */
export async function checkUpgradeInventory(
  executor: Executor = defaultExecutor,
  options: UpgradeCheckOptions = {},
): Promise<UpgradeCheckResult> {
  // T009: the installed version/spec derive from the positively identified
  // plugin registration (or an explicit pin), never from the running CLI
  // package. The CLI version is reporting-only and never compared.
  const cliVersion = options.cliVersion !== undefined ? options.cliVersion : readCurrentAriaVersion();
  const installed = options.currentVersion !== undefined
    ? installedIdentityFromPin(options.currentVersion)
    : await detectInstalledAriaIdentity(executor);
  const currentVersion = installed.version;
  const installedSpec = installed.spec;
  const available: AriaTargetDiscovery = options.availableOverride !== undefined
    ? options.availableOverride === null
      ? { kind: "unknown", reason: "available ARIA release pinned unknown" }
      : { kind: "known", target: options.availableOverride }
    : await discoverAvailableAriaTarget(executor);

  const components: UpgradeComponentRow[] = [ariaRow(installed, available)];

  // Engram: installed version observed read-only; version currency is
  // established post-handoff by the T012 adapter, not by this check
  // (deps sync only normalizes the current install).
  const engram = await detectEngram(executor);
  if (!engram.found) {
    components.push({ component: "engram", installed: null, available: null, status: "skipped", detail: "no Engram installation observed; nothing to upgrade" });
  } else if (!engram.version) {
    components.push({ component: "engram", installed: null, available: null, status: "unknown-target", detail: "Engram is installed but its version is not positively identified; no version action without fresh evidence" });
  } else {
    const mcp = await detectMcpConnectivity(executor);
    const link = mcp.listFailed ? "MCP connectivity unknown" : mcp.engram ? "MCP connected" : "MCP not connected";
    components.push({
      component: "engram",
      installed: engram.version,
      available: null,
      status: "unmanaged-observed",
      detail: `Engram ${engram.version} observed (${link}); version action owned by the post-handoff T012 adapter`,
    });
  }

  // Context7: remote-only endpoint (no local package, no version upgrade).
  const dual = dualConfigAmbiguous(options.configDir);
  if (dual.ambiguous) {
    components.push({
      component: "context7",
      installed: null,
      available: null,
      status: "unknown-target",
      detail: `global ${dual.jsonPath} and ${dual.jsoncPath} both exist; dual-file ambiguity fails closed with neither file mutated`,
    });
  } else {
    const context7 = await detectContext7(executor, options.configDir);
    if (!context7.configured) {
      components.push({ component: "context7", installed: null, available: null, status: "skipped", detail: "Context7 remote endpoint not configured; nothing to upgrade" });
    } else {
      const mcp = await detectMcpConnectivity(executor);
      if (mcp.listFailed) {
        components.push({ component: "context7", installed: "remote", available: null, status: "unknown-target", detail: "Context7 is configured but live MCP health is not established; no action without fresh evidence" });
      } else if (mcp.context7) {
        components.push({ component: "context7", installed: "remote", available: null, status: "remote-healthy", detail: "Context7 remote endpoint configured and connected; no version upgrade exists" });
      } else {
        components.push({ component: "context7", installed: "remote", available: null, status: "unknown-target", detail: "Context7 is configured but not connected; normalization runs post-handoff, never on guess" });
      }
    }
  }

  // CodeGraph: T006 evidence gate — non-managed, observed only.
  const codegraph = await detectCodeGraph(executor);
  if (!codegraph.found) {
    components.push({ component: "codegraph", installed: null, available: null, status: "skipped", detail: "no CodeGraph installation observed; nothing to upgrade" });
  } else if (!codegraph.version) {
    components.push({ component: "codegraph", installed: null, available: null, status: "unknown-target", detail: "CodeGraph is installed but its version is not positively identified; report-only with zero mutation" });
  } else {
    components.push({
      component: "codegraph",
      installed: codegraph.version,
      available: null,
      status: "unmanaged-observed",
      detail: `CodeGraph ${codegraph.version} observed and non-managed (T006: no safe V2/XDG-aware path demonstrated); report-only`,
    });
  }

  // ZotPilot: T006 evidence gate — detection only via `opencode mcp list`.
  const zotMcp = await detectMcpConnectivity(executor);
  if (zotMcp.listFailed && !zotMcp.zotpilot) {
    components.push({ component: "zotpilot", installed: null, available: null, status: "unknown-target", detail: "MCP inventory unavailable; ZotPilot presence not positively identified, report-only" });
  } else if (!zotMcp.zotpilot) {
    components.push({ component: "zotpilot", installed: null, available: null, status: "skipped", detail: "no ZotPilot MCP server listed; nothing to upgrade" });
  } else {
    components.push({
      component: "zotpilot",
      installed: "mcp-listed",
      available: null,
      status: "unmanaged-observed",
      detail: `ZotPilot MCP server listed (${zotMcp.zotpilot.connected ? "connected" : "not connected"}); non-managed (T006 shared-env ownership), report-only`,
    });
  }

  // Quota: delegate to the T007 read-only inventory (status vocabulary shared).
  const quota = await checkQuotaUpgrade(executor, options.configDir);
  components.push({
    component: "quota",
    installed: quota.installedVersion,
    available: null,
    status: quota.status,
    detail: quota.detail,
  });

  // T009: unknown installed spec blocks self-upgrade with zero mutation —
  // guidance cannot name an exact package without a positively identified
  // registration, even when a bare installed version string is present.
  const selfUpgradeBlocked = available.kind === "unknown" || currentVersion === null || installedSpec === null;
  const blockReason = currentVersion === null || installedSpec === null
    ? installed.note
    : available.kind === "unknown"
      ? available.reason
      : null;
  return { currentVersion, cliVersion, installedSpec, available, selfUpgradeBlocked, blockReason, components };
}

// ---------------------------------------------------------------------------
// Reporting (plain text, no ANSI — same convention as doctor)
// ---------------------------------------------------------------------------

function padCells(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
}

export function formatUpgradeCheck(result: UpgradeCheckResult): string {
  const lines: string[] = ["ARIA upgrade check", ""];
  lines.push(`Current release: ${result.currentVersion ?? "unknown"}${result.installedSpec ? ` (${result.installedSpec})` : ""}`);
  // T009: the running CLI is reported separately and never used for
  // guidance or comparison (legacy results without `cliVersion` report it
  // as unknown rather than guessing).
  lines.push(`Running CLI: ${result.cliVersion ?? "unknown"} (reporting only; guidance names the registered installation)`);
  lines.push(
    result.available.kind === "known"
      ? `Available release: ${result.available.target.tag} (${result.available.target.spec})`
      : "Available release: unknown",
  );
  if (result.selfUpgradeBlocked) {
    lines.push(`Self-upgrade: BLOCKED — ${result.blockReason ?? "target not positively identified"}`);
  } else if (result.available.kind === "known" && result.currentVersion === result.available.target.version) {
    lines.push("Self-upgrade: already current");
  } else if (result.available.kind === "known") {
    lines.push(formatApprovalGuidance(result.currentVersion, result.available.target.spec));
  } else {
    lines.push(formatApprovalGuidance(result.currentVersion, "unknown target"));
  }
  lines.push("");

  const header = ["Component", "Installed", "Available", "Status"];
  const rows = result.components.map((row) => [row.component, row.installed ?? "-", row.available ?? "-", row.status]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  lines.push(padCells(header, widths));
  for (const row of rows) lines.push(padCells(row, widths));
  lines.push("");
  lines.push("Details:");
  for (const row of result.components) lines.push(`  ${row.component}: ${row.detail}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Approval gate + old-release pipeline (stops at the bounded handoff)
// ---------------------------------------------------------------------------

export interface UpgradeApproval {
  /** Explicit operator approval (`upgrade --yes` via the exact-package invocation). No other signal counts. */
  yes: boolean;
}

export type UpgradeRunStage =
  | "already-current"
  | "blocked-approval"
  | "blocked-unknown-target"
  | "self-upgrade-failed"
  | "handoff-taken";

export interface SelfUpgradeOutcome {
  ok: boolean;
  detail: string;
  /** New-release entry note for reporting (set on success). */
  handoffNote?: string;
  /** Registration restoration state on failure (reported, T011-owned). */
  registration?: string;
}

export type SelfUpgradeFn = (target: AriaAvailableTarget, handoff: UpgradeHandoff) => Promise<SelfUpgradeOutcome>;

/**
 * Default self-upgrade seam: fail closed. T011 owns exact-ref
 * remove/replace/re-register plus the one-shot handoff spawn; until it
 * lands, approval never causes a mutation here.
 */
export async function defaultSelfUpgrade(): Promise<SelfUpgradeOutcome> {
  return {
    ok: false,
    detail: "ARIA self-upgrade adapter unavailable (T011 owns exact-ref replacement plus the bounded handoff); no changes made",
  };
}

export interface UpgradeRunOptions extends UpgradeCheckOptions {
  approval: UpgradeApproval;
  selfUpgradeFn?: SelfUpgradeFn;
  /**
   * Shared dependency lifecycle for the already-current path (T017). When
   * ARIA is already current and approval is present, the approved dependency
   * updates run directly under the current release with NO
   * self-replacement/handoff. The `aria upgrade` CLI always provides the
   * real `runUpgradeDependencies`; omitted preserves the pre-T017
   * zero-mutation already-current report for existing callers/tests.
   */
  dependenciesFn?: UpgradeAlreadyCurrentDependenciesFn;
}

/**
 * Already-current dependencies seam signature (shared lifecycle result).
 */
export type UpgradeAlreadyCurrentDependenciesFn = (
  executor: Executor,
  configDir?: string,
) => Promise<DependencyLifecycleResult>;

/**
 * T010 already-current CLI/plugin identity gate (pure, no mutation).
 *
 * The already-current dependency path mutates (shared lifecycle) directly
 * under the running release with NO self-replacement/handoff, so the
 * running CLI must positively be the registered installation before the
 * seam runs. The CLI version is positively identified (`cliVersion`) and
 * must exactly equal the positively identified installed registration
 * (`currentVersion` + `installedSpec`); any unknown or differing identity
 * fails closed with zero mutation. The approved exact-target handoff path
 * (upgrade-available, below) is preserved: it remains allowed to replace
 * the positively identified registration with the exact validated target.
 */
export function checkAlreadyCurrentCliIdentity(
  check: UpgradeCheckResult,
): { ok: true } | { ok: false; reason: string } {
  if (check.currentVersion === null || check.installedSpec === null) {
    return {
      ok: false,
      reason: `installed ARIA registration is not positively identified (${check.installedSpec ?? "no exact spec"}); refusing to run dependency updates under an unverified release`,
    };
  }
  if (check.cliVersion === null) {
    return {
      ok: false,
      reason: `running CLI version is unknown; refusing to run dependency updates against registered ${check.installedSpec} without positive CLI identity`,
    };
  }
  if (check.cliVersion !== check.currentVersion) {
    return {
      ok: false,
      reason: `definite mismatch: running CLI ${check.cliVersion} vs registered installation ${check.currentVersion} (${check.installedSpec}); refusing to run dependency updates under a conflicting release (move only via the explicit exact-target \`aria upgrade --yes\` handoff)`,
    };
  }
  return { ok: true };
}

export interface UpgradeRunResult {
  stage: UpgradeRunStage;
  ok: boolean;
  check: UpgradeCheckResult;
  handoff?: UpgradeHandoff;
  selfUpgrade?: SelfUpgradeOutcome;
  /**
   * Approved dependency outcomes for the already-current path (T017).
   * Present only when a `dependenciesFn` ran; absent otherwise (including
   * every handoff/blocked path, which never runs dependencies in the old
   * release).
   */
  dependencies?: { outcomes: ComponentUpgradeOutcome[]; report: string };
  detail: string;
}

/**
 * Old-release upgrade pipeline: inventory → explicit approval → validate
 * the ARIA target BEFORE removal → T011 self-upgrade + bounded handoff.
 * On handoff success this function returns WITHOUT running any further
 * normalization, regen, sync, doctor, or reporting — the new release owns
 * the remainder via `continueUpgradeInNewRelease`.
 */
export async function runUpgrade(
  executor: Executor = defaultExecutor,
  options: UpgradeRunOptions,
): Promise<UpgradeRunResult> {
  const check = await checkUpgradeInventory(executor, options);

  // Approval precedes ALL mutations (inventory above is strictly read-only).
  // T009: `check.currentVersion` is the installed registration version
  // (never the running CLI package version), so the blocked-approval
  // guidance names the registered installation.
  if (!options.approval.yes) {
    const targetSpec = check.available.kind === "known" ? check.available.target.spec : null;
    return {
      stage: "blocked-approval",
      ok: false,
      check,
      detail: formatBlockedApprovalDetail(check.currentVersion, targetSpec),
    };
  }

  // Unknown available target blocks self-upgrade with zero mutation.
  if (check.selfUpgradeBlocked) {
    return {
      stage: "blocked-unknown-target",
      ok: false,
      check,
      detail: `${check.blockReason ?? "target not positively identified"}. Self-upgrade blocked with zero mutation; establish the available release, then re-run with fresh approval.`,
    };
  }
  if (check.available.kind === "unknown" || check.currentVersion === null) {
    return {
      stage: "blocked-unknown-target",
      ok: false,
      check,
      detail: "ARIA target or installed version is not positively identified; self-upgrade blocked with zero mutation.",
    };
  }

  // Already current: without a dependencies seam, report with zero mutation
  // (pre-T017 behavior preserved for existing callers/tests). With a seam
  // (the `aria upgrade` CLI always provides the real shared lifecycle), run
  // the approved dependency updates directly under the current release with
  // NO self-replacement/handoff — the binding T017 case.
  //
  // T010: the seam path is gated on CLI/plugin identity before mutation. A
  // running CLI that is not positively the registered installation (unknown
  // or definite mismatch, e.g. dev CLI 1.0.8 vs registered v1.0.7) fails
  // closed with zero mutation; only the approved exact-target handoff below
  // moves between releases.
  if (check.currentVersion === check.available.target.version) {
    if (!options.dependenciesFn) {
      return { stage: "already-current", ok: true, check, detail: `ARIA ${check.currentVersion} is already current; no changes made.` };
    }
    const identity = checkAlreadyCurrentCliIdentity(check);
    if (!identity.ok) {
      return {
        stage: "already-current",
        ok: false,
        check,
        detail: `ARIA ${check.currentVersion} is already current; ${identity.reason}. No changes were made.`,
      };
    }
    let dependencies: DependencyLifecycleResult;
    try {
      dependencies = await options.dependenciesFn(executor, options.configDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        stage: "already-current",
        ok: false,
        check,
        dependencies: { outcomes: [], report: `dependencies threw: ${message}` },
        detail: `ARIA ${check.currentVersion} is already current; approved dependency updates failed (dependencies threw: ${message}). No self-replacement or handoff ran.`,
      };
    }
    const outcomes: ComponentUpgradeOutcome[] = dependencies.outcomes.map((outcome) => ({
      component: outcome.component,
      status: outcome.status,
      detail: outcome.detail,
      mutated: outcome.mutated,
    }));
    return {
      stage: "already-current",
      ok: dependencies.ok,
      check,
      dependencies: { outcomes, report: dependencies.report },
      detail: dependencies.ok
        ? `ARIA ${check.currentVersion} is already current; approved dependency updates completed directly under this release with no self-replacement/handoff.\n${dependencies.report}`
        : `ARIA ${check.currentVersion} is already current; approved dependency updates stopped with per-component states and no self-replacement/handoff.\n${dependencies.report}`,
    };
  }

  // Validate the exact target BEFORE the current registration is touched.
  const validated = validateAriaTargetForRemoval(check.available.target);
  if (!validated.ok) {
    return { stage: "blocked-unknown-target", ok: false, check, detail: `${validated.reason}; no changes made.` };
  }

  const handoff = buildUpgradeHandoff(check.available.target, check);
  const selfUpgradeFn = options.selfUpgradeFn ?? defaultSelfUpgrade;
  const selfUpgrade = await selfUpgradeFn(check.available.target, handoff);

  // Pre-handoff failure: the old registration is left/restored by T011 and
  // reported exactly; this pipeline performs no further phases.
  if (!selfUpgrade.ok) {
    return {
      stage: "self-upgrade-failed",
      ok: false,
      check,
      handoff,
      selfUpgrade,
      detail: `ARIA self-upgrade failed before handoff: ${selfUpgrade.detail}${selfUpgrade.registration ? ` Registration: ${selfUpgrade.registration}` : ""} No component upgrades, normalization, regen, sync, doctor, or reporting ran.`,
    };
  }

  // Handoff taken: the old code stops here. Everything after this point
  // (component upgrades → normalization/registration → regen → sync →
  // doctor → before/after report) runs ONLY in the new release.
  return {
    stage: "handoff-taken",
    ok: true,
    check,
    handoff,
    selfUpgrade,
    detail: `Handoff taken to ${check.available.target.spec}. ${selfUpgrade.handoffNote ?? "The new release owns the remainder."} This release performs no further work.`,
  };
}

export function formatUpgradeResult(result: UpgradeRunResult): string {
  const stageLine = result.stage === "already-current"
    ? "Upgrade: already current"
    : result.stage === "blocked-approval"
      ? "Upgrade: blocked (explicit approval required)"
      : result.stage === "blocked-unknown-target"
        ? "Upgrade: blocked (unknown target)"
        : result.stage === "self-upgrade-failed"
          ? "Upgrade: [FAIL] self-upgrade failed before handoff"
          : "Upgrade: handoff taken";
  return `${formatUpgradeCheck(result.check)}\n\n${stageLine}\n${result.detail}`;
}

/** CLI exit code: 0 only for already-current or a taken handoff. */
export function upgradeExitCode(result: UpgradeRunResult): number {
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Bounded handoff (exact-match gate for the new release)
// ---------------------------------------------------------------------------

export interface UpgradeHandoff {
  kind: "aria-upgrade-handoff";
  handoffVersion: 1;
  /** Exact validated ARIA target the new release must install. */
  target: AriaAvailableTarget;
  /** Exact approved component scope (names from `UPGRADE_COMPONENTS`). */
  approvedComponents: string[];
  /** Before-inventory for the before/after report. */
  before: UpgradeCheckResult;
}

/** Bind the exact validated target plus the approved inventory scope. */
export function buildUpgradeHandoff(target: AriaAvailableTarget, check: UpgradeCheckResult): UpgradeHandoff {
  return {
    kind: "aria-upgrade-handoff",
    handoffVersion: 1,
    target: { ...target },
    approvedComponents: check.components.map((row) => row.component),
    before: check,
  };
}

function sameScope(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(left);
  for (const name of right) {
    if (!remaining.delete(name)) return false;
  }
  return remaining.size === 0;
}

/**
 * New-release gate: continue without re-asking ONLY on an exact match of
 * the validated target spec plus the approved component scope. Any
 * target/scope drift stops for fresh approval with zero mutation.
 */
export function isHandoffMatch(
  handoff: UpgradeHandoff,
  actualTarget: AriaAvailableTarget,
  actualComponents: readonly string[],
): { match: true } | { match: false; reason: string } {
  if (handoff.kind !== "aria-upgrade-handoff" || handoff.handoffVersion !== 1) {
    return { match: false, reason: "handoff payload is not a recognized v1 upgrade handoff; stopping for fresh approval" };
  }
  if (actualTarget.spec !== handoff.target.spec) {
    return {
      match: false,
      reason: `handoff target drift: approved ${handoff.target.spec} but new release resolves ${actualTarget.spec}; stopping for fresh approval`,
    };
  }
  if (!sameScope(handoff.approvedComponents, [...actualComponents])) {
    return {
      match: false,
      reason: `handoff scope drift: approved [${handoff.approvedComponents.join(", ")}] but new release inventories [${[...actualComponents].join(", ")}]; stopping for fresh approval`,
    };
  }
  return { match: true };
}

// ---------------------------------------------------------------------------
// New-release continuation (T011+ owns transport; T010 owns the sequence)
// ---------------------------------------------------------------------------

export type ComponentUpgradeStatus = "completed" | "rolled-back" | "unresolved" | "skipped";

export interface ComponentUpgradeOutcome {
  component: string;
  status: ComponentUpgradeStatus;
  detail: string;
  mutated: boolean;
}

export interface ComponentContext {
  target: AriaAvailableTarget;
  executor: Executor;
  configDir?: string;
}

export type ComponentUpgradeFn = (ctx: ComponentContext) => Promise<ComponentUpgradeOutcome>;

function reportOnlyComponent(component: string, detail: string): ComponentUpgradeFn {
  return async () => ({ component, status: "skipped", detail, mutated: false });
}

export interface PostUpgradePhaseOutcome {
  ok: boolean;
  detail: string;
  mutated: boolean;
}

export type PostUpgradePhaseFn = (ctx: ComponentContext) => Promise<PostUpgradePhaseOutcome>;

export interface UpgradeContinuationOptions {
  configDir?: string;
  executor?: Executor;
  /** Per-component upgrades (defaults: real shared lifecycle T012–T014 + T017 Quota/Context7). */
  components?: Partial<Record<UpgradeComponentName, ComponentUpgradeFn>>;
  /** Target-version normalization/registration (default: report-only). */
  normalizeFn?: PostUpgradePhaseFn;
  /** Agent regen when required (default: report-only). */
  regenFn?: PostUpgradePhaseFn;
  /** Deps sync (default: real `depsSync`). */
  depsSyncFn?: PostUpgradePhaseFn;
  /** Doctor (default: real `runDoctor`). */
  doctorFn?: PostUpgradePhaseFn;
}

export type ContinuationStage = "complete" | "drift-blocked" | "component-stopped" | "phase-stopped";

export interface UpgradeContinuationResult {
  stage: ContinuationStage;
  ok: boolean;
  outcomes: ComponentUpgradeOutcome[];
  /** Before/after report (empty when drift-blocked before any work). */
  report: string;
  detail: string;
}

/**
 * Continue an approved upgrade ONLY in the new release. The handoff match
 * is checked before any mutation; component failures stop the pipeline
 * with per-component states and no global transactionality (completed work
 * stays, unattempted work reports `skipped`).
 */
export async function continueUpgradeInNewRelease(
  handoff: UpgradeHandoff,
  actualTarget: AriaAvailableTarget,
  actualComponents: readonly string[],
  options: UpgradeContinuationOptions = {},
): Promise<UpgradeContinuationResult> {
  const matched = isHandoffMatch(handoff, actualTarget, actualComponents);
  if (!matched.match) {
    return { stage: "drift-blocked", ok: false, outcomes: [], report: "", detail: `${matched.reason} No changes were made.` };
  }

  const executor = options.executor ?? defaultExecutor;
  const ctx: ComponentContext = { target: handoff.target, executor, configDir: options.configDir };
  const overrides = options.components ?? {};

  const componentFns: Array<{ name: UpgradeComponentName; fn: ComponentUpgradeFn }> = [
    { name: "aria", fn: overrides.aria ?? reportOnlyComponent("aria", "ARIA self-upgrade completed pre-handoff; nothing remains post-handoff") },
    { name: "engram", fn: overrides.engram ?? engramUpgradeComponent },
    { name: "context7", fn: overrides.context7 ?? context7UpgradeComponent },
    { name: "codegraph", fn: overrides.codegraph ?? codegraphUpgradeComponent },
    { name: "zotpilot", fn: overrides.zotpilot ?? zotpilotUpgradeComponent },
    { name: "quota", fn: overrides.quota ?? quotaLifecycleUpgradeComponent },
  ];

  const outcomes: ComponentUpgradeOutcome[] = [];
  for (const { fn } of componentFns) {
    const outcome = await fn(ctx);
    outcomes.push(outcome);
    if (outcome.status === "rolled-back" || outcome.status === "unresolved") {
      for (const { name } of componentFns.slice(outcomes.length)) {
        outcomes.push({ component: name, status: "skipped", detail: `not attempted (stopped after ${outcome.component})`, mutated: false });
      }
      return {
        stage: "component-stopped",
        ok: false,
        outcomes,
        report: formatUpgradeReport(handoff.before, outcomes),
        detail: `Component ${outcome.component} stopped the upgrade (${outcome.status}); completed work stays, nothing was rolled back globally.`,
      };
    }
  }

  const phases: Array<{ name: string; fn: PostUpgradePhaseFn }> = [
    {
      name: "normalize",
      fn: options.normalizeFn ??
        (async () => ({
          ok: true,
          detail: "target-version normalization/registration owned by the new release (T011+); T010 performs no normalization",
          mutated: false,
        })),
    },
    {
      name: "regen",
      fn: options.regenFn ??
        (async () => ({
          ok: true,
          detail: "agent regeneration owned by the new release when its routes require it; T010 regenerates nothing",
          mutated: false,
        })),
    },
    {
      name: "deps-sync",
      fn: options.depsSyncFn ??
        (async (phaseCtx) => {
          const result = await depsSync(phaseCtx.executor, phaseCtx.configDir);
          return {
            ok: result.ok,
            detail: result.ok ? "deps sync normalized the current installs" : "deps sync reported failures",
            mutated: true,
          };
        }),
    },
    {
      name: "doctor",
      fn: options.doctorFn ??
        (async (phaseCtx) => {
          const report = await runDoctor({ executor: phaseCtx.executor });
          const failures = report.findings.filter((finding) => finding.severity === "FAIL").length;
          return {
            ok: doctorExitCode(report.findings) === 0,
            detail: failures === 0 ? "doctor reports no FAIL findings" : `doctor reports ${failures} FAIL finding(s)`,
            mutated: false,
          };
        }),
    },
  ];

  for (const { name, fn } of phases) {
    const phase = await fn(ctx);
    if (!phase.ok) {
      return {
        stage: "phase-stopped",
        ok: false,
        outcomes,
        report: formatUpgradeReport(handoff.before, outcomes, { phase: `${name}: ${phase.detail}` }),
        detail: `Post-handoff phase ${name} stopped the upgrade: ${phase.detail}`,
      };
    }
  }

  return {
    stage: "complete",
    ok: true,
    outcomes,
    report: formatUpgradeReport(handoff.before, outcomes),
    detail: `Upgrade to ${handoff.target.spec} completed through doctor; see the before/after report.`,
  };
}

/** Before/after report: the bound before-inventory plus per-component after states. */
export function formatUpgradeReport(
  before: UpgradeCheckResult,
  outcomes: ComponentUpgradeOutcome[],
  extra?: { phase?: string },
): string {
  const lines: string[] = ["ARIA upgrade report", ""];
  lines.push(`Before: ARIA ${before.currentVersion ?? "unknown"} (available was ${before.available.kind === "known" ? before.available.target.tag : "unknown"})`);
  for (const row of before.components) {
    lines.push(`  before ${row.component}: installed=${row.installed ?? "-"} available=${row.available ?? "-"} status=${row.status}`);
  }
  lines.push("");
  lines.push("After:");
  if (outcomes.length === 0) {
    lines.push("  (no component outcomes)");
  }
  for (const outcome of outcomes) {
    lines.push(`  after ${outcome.component}: ${outcome.status}${outcome.mutated ? " (mutated)" : ""} — ${outcome.detail}`);
  }
  if (extra?.phase) {
    lines.push("");
    lines.push(`Phase: ${extra.phase}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sync vs upgrade definition (the pipeline contract in code)
// ---------------------------------------------------------------------------

/**
 * The one sync-vs-upgrade definition: `deps sync` normalizes CURRENT
 * installs (idempotent, unapproved, Quota excluded); `aria upgrade` moves
 * to a NEW release through inventory, explicit approval, pre-removal
 * validation, self-upgrade plus a bounded handoff, and new-release-only
 * completion with a before/after report.
 */
export function describeSyncVsUpgrade(): {
  sync: { normalizeCurrent: true; idempotent: true; approvalRequired: false; quotaExcluded: true; phases: string[] };
  upgrade: { approvalRequired: true; phases: string[] };
} {
  return {
    sync: {
      normalizeCurrent: true,
      idempotent: true,
      approvalRequired: false,
      quotaExcluded: true,
      phases: ["normalize current installs (Engram, Context7, CodeGraph)", "validate health", "report"],
    },
    upgrade: {
      approvalRequired: true,
      phases: [
        "inventory (read-only --check)",
        "explicit approval (--yes)",
        "validate ARIA target before removal",
        "T011 self-upgrade plus bounded handoff",
        "ONLY in new release: component upgrades",
        "ONLY in new release: target-version normalization/registration",
        "ONLY in new release: agent regen if required",
        "ONLY in new release: deps sync",
        "ONLY in new release: doctor",
        "before/after report",
      ],
    },
  };
}
