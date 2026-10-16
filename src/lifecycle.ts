import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { depsSync, defaultExecutor, type Executor } from "./deps.js";
import type { DependencyLifecycleResult, DependencyOutcome } from "./dependencies.js";
import {
  configureModels,
  type ModelConfigurationResult,
  type ModelConfigureInput,
  type ModelConfigureOptions,
  type ModelConfigureOutput,
} from "./model-config.js";
import { defaultAgentsDir, installAgentFiles, rollbackAgentInstall, type AgentInstallResult } from "./agents.js";
import { getPackageRoot } from "./defaults.js";
import {
  assertSetupConfigNotAmbiguous,
  defaultGlobalConfigPath,
  ensureAriaSetupConfigFile,
  isSameLocalPluginIdentity,
  resolveSetupAriaConfig,
  rollbackSetupConfigFile,
  type SetupConfigFileResult,
} from "./setup-config.js";
import { getPackageSkillsRoot } from "./skills.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LifecycleResult {
  ok: boolean;
  stage: string;
  setup?: SetupResult;
  update?: UpdateResult;
}

export interface SetupResult {
  registration: { action: "registered" | "already registered" | "failed"; detail?: string };
  sync: { ok: boolean; output?: string; error?: string };
  /**
   * Outcome of the global V2 config phase (T008). Always present unless
   * registration failed first.
   */
  config?: SetupConfigPhase;
  /**
   * Outcome of the managed agent-file phase (T008). Always present unless
   * registration or config failed first.
   */
  agents?: SetupAgentsPhase;
  /**
   * Outcome of the shared dependency lifecycle (T017). Present only when a
   * `dependenciesFn` seam was provided (the `aria setup` CLI always provides
   * the real `runSetupDependencies`; omitted preserves the pre-T017
   * registration/config/agents/sync behavior for existing callers/tests).
   * The lifecycle invokes the shared adapters directly with no ARIA
   * self-upgrade handoff.
   */
  dependencies?: SetupDependenciesPhase;
  /** Outcome of the optional model-configuration phase; absent unless requested. */
  model?: ModelConfigurationResult;
}

/**
 * T008 file-phase outcomes: global `opencode.json(c)` (exact plugin URI,
 * single skills root, depth default 3; unrelated user keys preserved,
 * backup before replace, idempotent) and the eleven managed agent files
 * (via T003 `installAgentFiles`, resolved project-neutral). T002 discovery
 * selects which of `opencode.json` / `opencode.jsonc` is the target and
 * `path` always reports the resolved file.
 */
export interface SetupConfigPhase {
  path: string;
  changed: boolean;
  created: boolean;
  backupPath?: string;
  detail?: string;
}

export interface SetupAgentsPhase {
  dir: string;
  version: string;
  written: number;
  unchanged: number;
  detail?: string;
}

/**
 * Model-configuration seam for `setup` (defaults to the real `configureModels`),
 * so tests can inject a mock without touching discovery or the interactive UI.
 */
export type ConfigureModelsFn = (
  worktree: string,
  options?: ModelConfigureOptions,
) => Promise<ModelConfigurationResult>;

/**
 * Shared dependency lifecycle seam for `setup` (T017). Receives the same
 * executor plus the effective global config dir (`dirname(globalConfigPath)`,
 * shared with `depsSync`) and returns the shared lifecycle result. The
 * `aria setup` CLI always provides the real `runSetupDependencies` (direct
 * adapter invocation, no handoff); omitted preserves the pre-T017 behavior
 * for existing callers/tests.
 */
export type SetupDependenciesFn = (
  executor: Executor,
  configDir: string,
) => Promise<DependencyLifecycleResult>;

/**
 * Setup-visible projection of the shared dependency lifecycle outcome.
 */
export interface SetupDependenciesPhase {
  ok: boolean;
  outcomes: DependencyOutcome[];
  report: string;
}

/**
 * Options for `setup`. All fields are optional: omitting them preserves the
 * fully non-interactive `setup(binaryUrl, executor)` behavior (R001: no
 * version-chasing sync unless a caller explicitly provides `depsSyncFn`).
 */
export interface SetupOptions {
  /** Request the optional model-configuration phase after registration and sync. */
  configure?: boolean;
  /** Worktree passed to model configuration (defaults to `process.cwd()`). */
  worktree?: string;
  /** Terminal input stream for interactive prompts (defaults to `process.stdin`). */
  input?: Readable;
  /** Terminal output stream for prompts (defaults to `process.stdout`). */
  output?: Writable;
  /** Explicit TTY override (defaults to `process.stdin.isTTY`). */
  tty?: boolean;
  /** Model-configuration seam (defaults to the real `configureModels`). */
  configureModelsFn?: ConfigureModelsFn;
  /**
   * T012 Git-package source (`aria setup --plugin-spec <spec>`): explicit
   * `opencode plugin add` package specifier (e.g.
   * `github:mscipio/ARIA#<EXACT_SHA>`). Used verbatim as the registration
   * argument and the config-file plugin identity — never rewritten to a
   * `file://` URI, never given `--global` (2.0.23 documents no such flag for
   * `plugin add`). Absent preserves the local-checkout behavior (absolute
   * checkout path, no `file://` scheme, no invented flags).
   */
  pluginSpec?: string;
  /**
   * T008 file-phase path overrides (all optional; omitted values resolve to
   * the production defaults: global `opencode.json`, global agents dir, and
   * the installed package skills root). Tests point these at temp dirs; no
   * workstation files are touched outside the resolved paths.
   */
  files?: SetupFilesOptions;
  /**
   * Shared dependency lifecycle seam (T017). When provided, `setup` invokes
   * it directly after the agent-file phase (install if missing with no ARIA
   * self-upgrade handoff). R001: no version-chasing sync runs on the setup
   * path — when omitted the sync phase is skipped and `setup.sync` reports
   * install-only ownership (pre-T017 behavior preserved).
   *
   * T002 ownership: the production seam (`runSetupDependencies`) is
   * install-if-missing ONLY — a present dependency is left untouched even
   * when newer exists; version upgrades belong exclusively to
   * `aria deps --upgrade` (T004). When omitted the phase is skipped and
   * `setup.dependencies` stays absent (pre-T017 behavior preserved).
   */
  dependenciesFn?: SetupDependenciesFn;
}

/**
 * Path overrides for the T008 setup file phases. Every field is optional;
 * omitted fields resolve to the production defaults.
 */
export interface SetupFilesOptions {
  /** Global V2 config path (defaults to `~/.config/opencode/opencode.json`). */
  globalConfigPath?: string;
  /** Managed agent directory (defaults to `~/.config/opencode/agents/`). */
  agentsDir?: string;
  /** Version-locked skills root (defaults to the installed package `skills/`). */
  skillsRoot?: string;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface UpdateResult {
  git: { ok: boolean; error?: string };
  npm: { ok: boolean; error?: string };
  handoff: CommandResult & { error?: string };
  /**
   * T002 identity-gate outcome for `update` (present only when the gate
   * ran). `ok:true` means the running checkout positively matched the
   * registered plugin (or registration was positively absent); `ok:false`
   * carries the fail-closed reason and no pull/npm/handoff mutation ran
   * beyond the read-only preconditions.
   */
  identity?: { ok: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// Checkout resolution (pure function, independent of process.cwd())
// ---------------------------------------------------------------------------

/**
 * Resolve the checkout directory from a binary URL.
 * The binary is assumed to be at `<checkout>/bin/<name>`.
 *
 * T005: for co-located `bin/` + `dist/` installs this is the installed
 * package root — the globally installed package for a bare `aria`
 * invocation, the dev checkout for `node ./bin/aria.mjs`. Production never
 * searches for the dev checkout; `bin/aria.mjs` passes its own
 * `import.meta.url`, so the derived directory is always the running
 * install's own root. Package assets (defaults/skills/agents) resolve via
 * {@link resolveInstalledPackageRoot} below (the loaded `dist/` location),
 * never via this path.
 */
function resolveCheckout(binaryUrl: string): Promise<string> {
  const binPath = fileURLToPath(binaryUrl);
  const binDir = dirname(binPath);
  const checkout = resolve(binDir, "..");
  return realpath(checkout);
}

/**
 * T005 production package root: the loaded ARIA install's own root
 * (`dist/` → parent), independent of any binary URL or dev checkout.
 * A bare `aria` invocation resolves here (globally installed
 * package/assets); development (`node ./bin/aria.mjs`) resolves to the
 * checkout only because the loaded `dist/` lives there. Never infers,
 * searches for, or requires the dev checkout.
 */
export function resolveInstalledPackageRoot(): string {
  return getPackageRoot();
}

// ---------------------------------------------------------------------------
// Local run helper — supports cwd via ExecutorOptions
// ---------------------------------------------------------------------------

async function run(
  executor: Executor,
  cwd: string,
  command: string,
  ...args: string[]
): Promise<CommandResult> {
  try {
    const result = await executor(command, args, { cwd });
    return { exitCode: 0, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: number | string }).code;
    let exitCode: number | null;
    if (typeof code === "number" && Number.isFinite(code) && Number.isInteger(code)) {
      exitCode = code;
    } else if (typeof code === "string" && /^\d+$/.test(code)) {
      const parsed = Number.parseInt(code, 10);
      exitCode = Number.isFinite(parsed) ? parsed : null;
    } else {
      exitCode = null;
    }
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout.trim()
      : "";
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : message;
    return { exitCode, ok: false, stdout, stderr };
  }
}

// ---------------------------------------------------------------------------
// Introspection via `opencode plugin list` (V2, pinned 2.0.23)
// ---------------------------------------------------------------------------
//
// Pinned 2.0.23 contract (isolated `opencode` 2.0.23 binary, exact `--help`
// evidence; workstation 1.18.34 untouched):
// - `opencode plugin --help` lists subcommands
//   list/add/check/update/remove (no bare `plugin <module>` V1 form; bare
//   `plugin file://...` fails with `Unknown subcommand`).
// - `opencode plugin add --help` shows
//   `USAGE opencode plugin add [flags] <package>` with
//   `package string npm registry or Git package specifier` and no `--global`
//   flag (`plugin add ... --global` fails with `Unrecognized flag: --global`).
// - `opencode debug --help` lists subcommands agents/config/paths only;
//   `debug info` fails with `Unknown subcommand "info"`.
// - `opencode plugin list --help` shows `USAGE opencode plugin list [flags]`
//   with an optional `--builtin` flag. Its table output (see
//   `packages/cli/src/commands/handlers/plugin/list.ts` `format()`) is a
//   `ID  VERSION  SOURCE` header followed by one row per plugin, or the
//   literal `No plugins found` when empty. Local entries report VERSION
//   `local` and SOURCE as the absolute filesystem path (via `fileURLToPath`,
//   never a `file://` URI); TUI-only entries use ID `-`.
// - `plugin add` installs npm/Git specs only (see
//   `packages/cli/src/commands/handlers/plugin/add.ts` plus
//   `packages/util/src/npm.ts` `parse()`: only npm-package-arg `version`,
//   `range`, `tag`, and `git` types are installable; `directory`/`file`/
//   `link` specs fail with
//   `Plugin target must be an npm registry package or Git package specifier`
//   before any install or config mutation). Local directories therefore
//   register through the global-config `plugins[]` file truth (see
//   `packages/core/src/config/plugin/source.ts` `scan()` + `localSource()`:
//   `file://`, absolute-path, and `./`/`../` entries all resolve to local),
//   which T008 `ensureAriaSetupConfigFile` already writes with backup.
// - `plugin add` already targets the global configuration (its description
//   is `Install a plugin and add it to the global configuration`), so no
//   `--global` flag exists or is passed (no invented flags).
//
// Registration therefore uses `opencode plugin add <package>` with the T012
// `--plugin-spec` verbatim when given (a Git spec installs directly, no
// conversion), otherwise the narrowest local argument (the absolute checkout
// directory path: no `file://` scheme, no `--global`, no invented flags).
// When the pinned runtime rejects that local path with its exact npm/Git-only
// message, setup proceeds to the supported config-file local registration
// below instead of failing closed on an expected CLI limitation; every other
// registration error still fails closed before any file mutation or sync.

/**
 * V2 `opencode plugin list` table entry (ID/VERSION/SOURCE columns).
 */
export interface PluginListEntry {
  id: string;
  version: string;
  /** SOURCE column: absolute local path for local plugins, package spec otherwise. */
  target: string;
}

/**
 * Parse V2 `opencode plugin list` output into table entries.
 * Recognized shapes: the `ID  VERSION  SOURCE` header followed by rows, or
 * the literal `No plugins found` (recognized empty). Anything else is
 * unrecognized (never guessed).
 */
function parsePluginList(output: string): { recognized: boolean; entries: PluginListEntry[] } {
  const lines = output.split("\n");
  if (lines.some((line) => line.trim().toLowerCase() === "no plugins found")) {
    return { recognized: true, entries: [] };
  }
  const headerIndex = lines.findIndex((line) => /^\s*ID\s+VERSION\s+SOURCE\s*$/i.test(line));
  if (headerIndex === -1) {
    return { recognized: false, entries: [] };
  }
  const entries: PluginListEntry[] = [];
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    // ID and VERSION contain no spaces; SOURCE is the remainder (paths may
    // contain spaces, e.g. "my project (v2)").
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    entries.push({ id: match[1], version: match[2], target: match[3].trim() });
  }
  return { recognized: true, entries };
}

/**
 * Local-identity match for `plugin list` SOURCE entries (one consistent
 * T008 rule, owned by `src/setup-config.ts`): an absolute path and its
 * corresponding `file://` URI are one identity. The SOURCE column reports
 * absolute paths for local plugins, so the checkout path compares directly
 * and `file://` equivalence is accepted for config-file forms. Bare npm
 * names, remote URLs, and unrelated specifiers match only on exact
 * equality (existing symlink/realpath behavior preserved: lexical only).
 */
function matchesCurrentPluginTarget(target: string, checkout: string, pluginUri: string): boolean {
  return isSameLocalPluginIdentity(target, checkout) || isSameLocalPluginIdentity(target, pluginUri);
}

// ---------------------------------------------------------------------------
// T002 identity evidence (single source shared with `src/doctor.ts`)
// ---------------------------------------------------------------------------
//
// T001 positively identified CLI/plugin identity reuses exactly
// `parsePluginList` (above) plus `isSameLocalPluginIdentity` (setup-config)
// and the two exact-version predicates below. This module owns the
// canonical definitions so `setup()`/`update()` gates and the read-only
// doctor comparison can never diverge: `doctor.ts` imports (never
// duplicates) these predicates.

/**
 * Exact core-version predicate for identity comparison. A leading `v`
 * (release-tag form) is accepted and stripped; anything that is not an
 * exact `X.Y.Z` core (with an optional prerelease/build suffix) is not
 * version evidence and is never compared. Short SHAs such as the plugin
 * list `842e4ec` and the `local` placeholder therefore stay unknown.
 */
export function normalizeIdentityVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

/**
 * Exact version evidence carried by a plugin-list SOURCE reference: the
 * `#tag` suffix of a Git package specifier such as
 * `github:mscipio/ARIA#v1.0.7`. References without an exact tag (local
 * paths, bare specs) carry no version evidence and return null.
 */
export function pluginSpecTagVersion(target: string): string | null {
  const hash = target.lastIndexOf("#");
  if (hash === -1) return null;
  return normalizeIdentityVersion(target.slice(hash + 1));
}

/**
 * T002 setup/update identity gate states (read-only classification, no
 * mutation). `matching` (exactly one registration for the intended target)
 * and `absent` (recognized list with no `aria` entry: deterministic
 * first-time bootstrap) allow the caller to proceed; every other state
 * fails closed before any `plugin add/remove`, file write, or sync:
 * - `mismatch`: at least one `aria` entry names a different source
 *   (definite mismatch, including exact-tag evidence when present);
 * - `ambiguous`: a duplicated `aria` registration (never guessed);
 * - `unknown`: the list probe failed or its output is unrecognized (never
 *   guessed; the compatibility fallback that once registered blindly is
 *   retired — callers must observe positive absence or an exact match).
 *
 * The only designed transition out of `mismatch` is the explicit
 * exact-target upgrade handoff (`aria upgrade --yes` via
 * `src/upgrade.ts`/`src/aria-upgrade.ts`); `setup()` never re-registers
 * over a conflicting entry.
 */
export type SetupIdentityGate =
  | { kind: "matching"; detail: string }
  | { kind: "absent"; detail: string }
  | { kind: "mismatch"; detail: string }
  | { kind: "ambiguous"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * T010 approved ARIA Git source for bootstrap classification. Canonical
 * value: `ARIA_GIT_SPEC_PREFIX` in `src/upgrade.ts` (duplicated here
 * because that module imports this one, so importing it would cycle; cf.
 * `APPROVED_ARIA_GIT_SPEC_PREFIX` in `src/doctor.ts`). Any plugin-list
 * SOURCE starting with this prefix is positively recognized as an ARIA
 * Git registration regardless of its ID column (including TUI-only `-`
 * rows such as `- 842e4ec github:mscipio/ARIA#v1.0.7`), so it is never
 * classified absent.
 */
const APPROVED_ARIA_GIT_SPEC_PREFIX = "github:mscipio/ARIA#";

/**
 * True for a positively recognized ARIA Git source (approved prefix).
 * Exact-tag shape is not required here: any approved-source row proves an
 * existing registration exists, so bootstrap must not overwrite it (the
 * exact tag is validated separately by the upgrade handoff).
 */
export function isRecognizedAriaGitSource(target: string): boolean {
  return target.startsWith(APPROVED_ARIA_GIT_SPEC_PREFIX);
}

/**
 * T012 shared ARIA registration rule (single source for lifecycle gating
 * and doctor reporting). A plugin-list row is positively ARIA-identifying
 * when its ID is `aria` (any SOURCE, including local paths and foreign
 * specs) or its SOURCE is a positively recognized ARIA Git package
 * (approved `github:mscipio/ARIA#` prefix, any ID including TUI-only `-`
 * rows such as `- 842e4ec github:mscipio/ARIA#v1.0.7`). Exact-tag shape is
 * not required: any such row proves a registration exists, so it is never
 * classified absent (the exact tag is validated separately by the upgrade
 * handoff and the guarded doctor comparison).
 */
export function isAriaRegistrationEntry(entry: PluginListEntry): boolean {
  return entry.id === "aria" || isRecognizedAriaGitSource(entry.target);
}

/** Shared ARIA registration count: absent/single/ambiguous. */
export type AriaRegistrationKind = "absent" | "single" | "ambiguous";

export interface AriaRegistrationClassification {
  kind: AriaRegistrationKind;
  identifying: PluginListEntry[];
}

/**
 * T012 shared ARIA registration classification (pure, no mutation).
 * `isLocalMatch` optionally recognizes TUI-only local rows that name the
 * running checkout (lifecycle: `matchesIntended`; doctor:
 * `isSameLocalPluginIdentity(target, packageRoot)`). Exactly one
 * positively identified registration is `single`; zero is `absent`;
 * multiple/conflicting rows are `ambiguous` (never guessed).
 */
export function classifyAriaRegistration(
  entries: PluginListEntry[],
  isLocalMatch?: (target: string) => boolean,
): AriaRegistrationClassification {
  const identifying = entries.filter(
    (entry) => isAriaRegistrationEntry(entry) || (isLocalMatch ? isLocalMatch(entry.target) : false),
  );
  if (identifying.length === 0) return { kind: "absent", identifying };
  if (identifying.length === 1) return { kind: "single", identifying };
  return { kind: "ambiguous", identifying };
}

/**
 * Classify the current plugin-list entries against the intended setup
 * registration target. `matchesIntended` is the exact setup matching rule
 * (verbatim `--plugin-spec` equality when given, otherwise the local
 * path/`file://` identity above, TUI `-` rows included via their SOURCE).
 * Pure: no executor, no mutation.
 *
 * T010: ARIA is identified by positively recognized source as well as ID.
 * A recognized Git-source row with any ID (including TUI-only `-`) is an
 * existing registration: when it does not match the intended target it is
 * a definite mismatch (never absent), so setup never bootstraps over it.
 *
 * T012: the ARIA-identifying set is shared with doctor via
 * `classifyAriaRegistration` (ID `aria` plus approved Git SOURCE, plus
 * TUI-local matches). Multiple/conflicting identifying rows are ambiguous
 * and fail closed: a matching local row plus a `- github:...` row,
 * duplicate matching Git/TUI rows, or any other multiple ARIA-identifying
 * rows are never accepted as a unique match.
 */
export function classifySetupIdentity(
  entries: PluginListEntry[],
  matchesIntended: (target: string) => boolean,
): SetupIdentityGate {
  const registration = classifyAriaRegistration(entries, matchesIntended);
  if (registration.kind === "absent") {
    return {
      kind: "absent",
      detail: "ARIA plugin is definitely absent from the recognized opencode plugin list (no ARIA-identifying entry)",
    };
  }
  if (registration.kind === "ambiguous") {
    const observed = registration.identifying.map((entry) => `${entry.id} ${entry.target}`).join(", ");
    return {
      kind: "ambiguous",
      detail:
        `ARIA plugin is listed more than once (${observed}; ` +
        `duplicate/conflicting registration; not compared). Refusing to guess. No changes were made.`,
    };
  }
  const sole = registration.identifying[0]!;
  if (!matchesIntended(sole.target)) {
    const tagged = pluginSpecTagVersion(sole.target);
    const evidence = tagged !== null ? ` (exact version evidence: ${tagged})` : "";
    return {
      kind: "mismatch",
      detail:
        `definite mismatch: registered ARIA source(s) [${sole.target}]${evidence} do not match the intended target. ` +
        `Refusing to re-register over a conflicting registration (run \`aria doctor\` to inspect; ` +
        `move to another release only via the explicit exact-target \`aria upgrade --yes\` handoff). No changes were made.`,
    };
  }
  return {
    kind: "matching",
    detail: "plugin already registered (detected via plugin list)",
  };
}

/**
 * T010 standalone-sync identity gate (read-only classification, no
 * mutation). The checkout running `aria deps sync` must positively match
 * the registered ARIA plugin (or registration must be positively absent)
 * before any dependency mutation runs. A definite mismatch, a duplicate,
 * or an unknown list (probe failure/unrecognized) fails closed with no
 * sync; the only designed transition between releases is the explicit
 * exact-target `aria upgrade --yes` handoff. Mirrors the `update()`
 * identity gate (matching/absent allow, all else blocks) so sync, setup,
 * and update can never diverge.
 */
export async function gateStandaloneSync(
  executor: Executor,
  binaryUrl: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  let checkout: string;
  try {
    checkout = await resolveCheckout(binaryUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: `running checkout is not positively identified (${reason}). Refusing to guess (run \`aria doctor\` to inspect). No changes were made.`,
    };
  }
  const pluginUri = pathToFileURL(checkout).href;
  const listResult = await run(executor, checkout, "opencode", "plugin", "list");
  if (!listResult.ok || !listResult.stdout) {
    const reason = !listResult.ok
      ? `opencode plugin list failed (${listResult.stderr || "unknown error"}); the current ARIA registration is not positively identified`
      : "opencode plugin list output is empty; the current ARIA registration is not positively identified";
    return { ok: false, detail: `${reason}. Refusing to guess (run \`aria doctor\` to inspect). No changes were made.` };
  }
  const { recognized, entries } = parsePluginList(listResult.stdout);
  if (!recognized) {
    return {
      ok: false,
      detail:
        "opencode plugin list output is unrecognized; the current ARIA registration is not positively identified. " +
        "Refusing to guess (run `aria doctor` to inspect). No changes were made.",
    };
  }
  const gate = classifySetupIdentity(
    entries,
    (target) => matchesCurrentPluginTarget(target, checkout, pluginUri),
  );
  if (gate.kind === "matching" || gate.kind === "absent") {
    return { ok: true, detail: gate.detail };
  }
  return { ok: false, detail: gate.detail };
}

/**
 * Interpret a `opencode plugin add <package>` result. Success reports
 * `registered` (or `already registered` when the runtime confirms the spec
 * is already configured). Failure reports `already registered` for duplicate
 * diagnostics, follows the documented local-directory path when the pinned
 * runtime rejects a local path with its exact npm/Git-only message (the
 * check happens before any install or config mutation, so falling through
 * to the supported config-file registration below is side-effect-free), and
 * otherwise fails closed.
 */
function interpretPluginAddResult(
  pluginResult: CommandResult,
  packageArg: string,
): { action: "registered" | "already registered" | "failed"; detail?: string } {
  if (pluginResult.ok) {
    if (`${pluginResult.stdout} ${pluginResult.stderr}`.toLowerCase().includes("already configured")) {
      return { action: "already registered", detail: "plugin already configured (reported by plugin add)" };
    }
    return { action: "registered" };
  }
  const combined = `${pluginResult.stderr} ${pluginResult.stdout}`.toLowerCase();
  const isDuplicate =
    combined.includes("already registered") ||
    combined.includes("duplicate") ||
    combined.includes("already exists") ||
    combined.includes("already configured");
  if (isDuplicate) {
    return { action: "already registered", detail: "treated as already registered (compatibility fallback)" };
  }
  if (combined.includes("must be an npm registry package or git package specifier")) {
    return {
      action: "registered",
      detail:
        "plugin add does not install local directories (2.0.23 registry/Git only); proceeding to config-file registration",
    };
  }
  return { action: "failed", detail: `opencode plugin add ${packageArg} failed: ${pluginResult.stderr}` };
}

/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 *
 * @deprecated V1-only. `debug info` does not exist on pinned OpenCode 2.0.23
 * (`debug --help` lists agents/config/paths only; `debug info` fails with
 * `Unknown subcommand "info"`). Kept exported for existing unit coverage;
 * setup now uses {@link parsePluginList} (`opencode plugin list`) plus
 * direct config-file truth and never invokes `debug info`.
 */
function parsePluginSpecifiers(output: string): { recognized: boolean; specifiers: string[] } {
  const lines = output.split("\n");
  const specifiers: string[] = [];
  let recognized = false;

  let inPlugins = false;
  let headerIndent = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Detect plugins section header (case-insensitive)
    if (/^plugins\s*:/i.test(trimmed)) {
      inPlugins = true;
      recognized = true;
      headerIndent = indent;
      continue;
    }

    // Exit plugins section when we reach a non-blank line at same or lesser indent
    if (inPlugins && trimmed !== "" && !trimmed.startsWith("- ") && indent <= headerIndent) {
      inPlugins = false;
      continue;
    }

    if (inPlugins && trimmed !== "") {
      // Strip "- " list marker used by real OpenCode debug info output
      const specifier = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }

  return { recognized, specifiers };
}

// ---------------------------------------------------------------------------
// Terminal seam helpers for the optional model-configuration phase
// ---------------------------------------------------------------------------

/** Build a `ModelConfigureInput` seam reading one trimmed line from a stream. */
function terminalInput(inputStream: Readable, outputStream: Writable): ModelConfigureInput {
  return (prompt) =>
    new Promise((resolveInput, rejectInput) => {
      const terminal = createInterface({ input: inputStream, output: outputStream });
      terminal.question(prompt, (answer) => {
        terminal.close();
        resolveInput(answer.trim());
      });
      terminal.on("error", rejectInput);
    });
}

/** Build a `ModelConfigureOutput` seam emitting one line to a stream. */
function terminalOutput(stream: Writable): ModelConfigureOutput {
  return (text) => {
    stream.write(`${text}\n`);
  };
}

// ---------------------------------------------------------------------------
// setup — registration + dependency sync (+ optional model configuration)
// ---------------------------------------------------------------------------

export async function setup(
  binaryUrl: string,
  executor: Executor = defaultExecutor,
  depsSyncFn?: typeof depsSync,
  options: SetupOptions = {},
): Promise<LifecycleResult> {
  const checkout = await resolveCheckout(binaryUrl);
  const pluginUri = pathToFileURL(checkout).href;
  // T005: `opencode` subprocesses run in the invocation worktree
  // (`options.worktree ?? process.cwd()`), never in the package/checkout
  // directory. Registration identity stays the running install's own root
  // (bare `aria` → globally installed package; `node ./bin/aria.mjs` → dev
  // checkout); package assets below resolve via the loaded install
  // (`resolveInstalledPackageRoot`), never by searching for the checkout.
  const invocationWorktree = options.worktree ?? process.cwd();
  const installedRoot = resolveInstalledPackageRoot();

  // T012: an explicit but empty `--plugin-spec` fails closed before any
  // introspection, registration, or file mutation (registering "nothing" must
  // never silently fall back to the local checkout).
  if (options.pluginSpec !== undefined && options.pluginSpec.length === 0) {
    return {
      ok: false,
      stage: "registration",
      setup: {
        registration: { action: "failed", detail: "--plugin-spec is empty (expected a Git package specifier such as github:mscipio/ARIA#<EXACT_SHA>)" },
        sync: { ok: false, error: "sync skipped due to registration failure" },
      },
    };
  }
  // T012: with `--plugin-spec` the spec is the registration argument AND the
  // config-file plugin identity, verbatim (no `file://` conversion: a Git
  // spec is not a local path, and the config must name the same package the
  // runtime installed so detection stays exactly-once). Without it, the
  // narrowest supported local argument is the absolute checkout directory
  // path (no `file://` scheme, no `--global`, no invented flags).
  const pluginSpec = options.pluginSpec;
  const packageArg = pluginSpec ?? checkout;
  const configPluginIdentity = pluginSpec ?? pluginUri;

  // T001 hotfix preflight: read-only canonical-config discovery at the
  // effective config root BEFORE any `opencode plugin list/add` executor
  // call. A dual-file (`opencode.json` + `opencode.jsonc`) state fails
  // closed here — before any plugin mutation — via the exact discovery rule
  // shared with `ensureAriaSetupConfigFile` below (same effective
  // `globalConfigPath`, same ambiguity definition). Single-config and
  // clean-install states proceed unchanged.
  const filesOptions = options.files ?? {};
  const globalConfigPath = filesOptions.globalConfigPath ?? defaultGlobalConfigPath();
  try {
    await assertSetupConfigNotAmbiguous(globalConfigPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stage: "config",
      setup: {
        registration: { action: "failed", detail: "registration skipped due to config failure" },
        sync: { ok: false, error: "sync skipped due to config failure" },
        config: { path: globalConfigPath, changed: false, created: false, detail: message },
      },
    };
  }

  let registrationAction: SetupResult["registration"]["action"] = "failed";
  let registrationDetail: string | undefined;

  // -----------------------------------------------------------------------
  // Phase 1 — Register plugin (idempotent via `plugin list` + config truth)
  // -----------------------------------------------------------------------
  //
  // The registration argument is the explicit T012 `--plugin-spec` verbatim
  // when given (a Git package specifier needs no conversion), otherwise the
  // narrowest supported local package argument (the absolute checkout
  // directory path: no `file://` scheme, no `--global`, no invented flags).
  // `plugin list` SOURCE entries compare directly against that same argument
  // (Git specs by exact equality; local checkouts also accept the
  // corresponding `file://` URI under the one consistent local-identity rule
  // shared with the config file truth).

  // Try introspection first (read-only, never mutates config). T002 gates
  // every mutation on the positively identified states shared with the
  // read-only doctor (`parsePluginList` + `isSameLocalPluginIdentity` plus
  // the exact-version predicates above): only a positively absent
  // registration bootstraps and only an exact match re-runs idempotently.
  // A definite mismatch, a duplicate, or an unknown list (probe failure or
  // unrecognized output) fails closed here — before any `plugin add`, file
  // write, or sync. The retired compatibility fallback never registered
  // blindly, and the conflicting-stale auto-add never re-registers over a
  // different source: the only designed transition is the explicit
  // exact-target `aria upgrade --yes` handoff.
  const listResult = await run(executor, invocationWorktree, "opencode", "plugin", "list");
  const introspectionOk = listResult.ok && listResult.stdout;
  let usedIntrospection = false;

  if (introspectionOk) {
    const { recognized, entries } = parsePluginList(listResult.stdout);
    if (recognized) {
      usedIntrospection = true;

      const matchesCurrent = (target: string): boolean =>
        (pluginSpec !== undefined && target === pluginSpec) ||
        matchesCurrentPluginTarget(target, checkout, pluginUri);
      const gate = classifySetupIdentity(entries, matchesCurrent);
      if (gate.kind === "matching") {
        registrationAction = "already registered";
        registrationDetail = gate.detail;
      } else if (gate.kind === "absent") {
        // Positively absent — deterministic first-time bootstrap only.
        const pluginResult = await run(executor, invocationWorktree, "opencode", "plugin", "add", packageArg);
        const interpreted = interpretPluginAddResult(pluginResult, packageArg);
        registrationAction = interpreted.action;
        registrationDetail = interpreted.detail;
      } else {
        // T002 fail-closed: mismatch, duplicate, or (unreachable here —
        // recognized lists always classify above) unknown. No plugin
        // mutation, no file writes, no sync.
        return {
          ok: false,
          stage: "registration",
          setup: {
            registration: { action: "failed", detail: gate.detail },
            sync: { ok: false, error: "sync skipped due to registration failure" },
          },
        };
      }
    }
    // Unrecognized format → fail closed below (never guessed).
  }

  // Fail-closed when introspection is unavailable or unrecognized: the
  // registration is unknown, so no mutation, file write, or sync runs.
  // (The pre-T002 compatibility fallback that registered blindly is
  // retired; observe positive absence or an exact match first.)
  if (!usedIntrospection) {
    const reason = !listResult.ok
      ? `opencode plugin list failed (${listResult.stderr || "unknown error"}); the current ARIA registration is not positively identified`
      : "opencode plugin list output is unrecognized; the current ARIA registration is not positively identified";
    return {
      ok: false,
      stage: "registration",
      setup: {
        registration: {
          action: "failed",
          detail: `${reason}. Refusing to guess (run \`aria doctor\` to inspect). No changes were made.`,
        },
        sync: { ok: false, error: "sync skipped due to registration failure" },
      },
    };
  }

  // Fail closed — if registration failed, do not proceed to file phases or sync
  if (registrationAction === "failed") {
    return {
      ok: false,
      stage: "registration",
      setup: {
        registration: { action: "failed", detail: registrationDetail },
        sync: { ok: false, error: "sync skipped due to registration failure" },
      },
    };
  }

  const registration = { action: registrationAction, detail: registrationDetail } as const;

  // -----------------------------------------------------------------------
  // Phase 1b — Global V2 config (T008): exact plugin URI, single skills
  // root, depth default 3. T002 discovery selects the canonical existing
  // `opencode.json` / `opencode.jsonc` target (fail closed when both
  // exist); the resolved `configState.path` below is authoritative for
  // reporting and rollback. Preserves unrelated user keys, backs up before
  // replacing, and writes nothing when nothing changed. Fail closed: sync
  // is skipped when the config cannot be ensured.
  // -----------------------------------------------------------------------

  // T001: filesOptions/globalConfigPath were resolved in the preflight
  // above (same effective root); only skillsRoot is still needed here.
  // T005: the default is the loaded install's own `skills/` (globally
  // installed package for bare `aria`, dev checkout for
  // `node ./bin/aria.mjs`) — never a searched-for dev checkout.
  const skillsRoot = filesOptions.skillsRoot ?? getPackageSkillsRoot(installedRoot);

  let configState: SetupConfigFileResult;
  try {
    configState = await ensureAriaSetupConfigFile({ configPath: globalConfigPath, pluginUri: configPluginIdentity, skillsRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stage: "config",
      setup: {
        registration: { ...registration },
        sync: { ok: false, error: "sync skipped due to config failure" },
        config: { path: globalConfigPath, changed: false, created: false, detail: message },
      },
    };
  }
  const configPhase: SetupConfigPhase = {
    path: configState.path,
    changed: configState.changed,
    created: configState.created,
    backupPath: configState.backupPath,
  };

  // -----------------------------------------------------------------------
  // Phase 1c — Managed agent files (T008): the eleven deterministic files
  // via T003 `installAgentFiles` (ownership markers, user-agent backups,
  // atomic writes). Resolution is project-neutral (defaults plus global
  // overrides only) so CWD project models never bake into global files
  // (T005: project overlays stay runtime-only). Failure rolls back the
  // config write above; sync is skipped.
  // -----------------------------------------------------------------------

  const agentsDir = filesOptions.agentsDir ?? defaultAgentsDir();
  let installed: AgentInstallResult;
  try {
    const resolved = resolveSetupAriaConfig(options.worktree ?? process.cwd());
    installed = await installAgentFiles(resolved, { dir: agentsDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Partial-install rollback (T008): installAgentFiles throws before
    // returning rollback state, so accumulated agent changes (replaced
    // files + backups, including a backup-moved-before-failed-replacement
    // exposed as `partialResult`) must be rolled back here too. Config
    // rollback below stays mandatory; both passes are best-effort.
    const partial = (error as { partialResult?: AgentInstallResult } | null | undefined)?.partialResult;
    if (partial && (partial.written.length > 0 || Object.keys(partial.backups ?? {}).length > 0)) {
      await rollbackAgentInstall(agentsDir, partial).catch(() => undefined);
    }
    await rollbackSetupConfigFile(configState.path, configState).catch(() => undefined);
    return {
      ok: false,
      stage: "agents",
      setup: {
        registration: { ...registration },
        sync: { ok: false, error: "sync skipped due to agent install failure" },
        config: { ...configPhase, detail: "rolled back due to agent install failure" },
        agents: { dir: agentsDir, version: "", written: 0, unchanged: 0, detail: message },
      },
    };
  }
  const agentsPhase: SetupAgentsPhase = {
    dir: installed.dir,
    version: installed.version,
    written: installed.written.length,
    unchanged: installed.unchanged.length,
  };

  // T003 effective-root forwarding: setup, sync, dependencies, and doctor
  // share one root. The effective global config dir is
  // dirname(globalConfigPath): explicit SetupFilesOptions stays authoritative,
  // otherwise env defaults via defaultGlobalConfigPath() (XDG_CONFIG_HOME or
  // ~/.config). No CLI flags.
  const effectiveConfigDir = dirname(globalConfigPath);

  // -----------------------------------------------------------------------
  // Phase 1d — Shared dependency lifecycle (T017, optional seam). When a
  // `dependenciesFn` is provided (the `aria setup` CLI always provides the
  // real `runSetupDependencies`), invoke the shared adapters directly on the
  // clean/existing OC2+ install: detect → install if positively missing →
  // normalize → validate (T002 install-only: present installs stay
  // untouched; version upgrades belong to `aria deps --upgrade`). No
  // ARIA self-upgrade handoff runs here on any path. Failure skips sync
  // (fail closed); omission skips the phase with pre-T017 behavior.
  // -----------------------------------------------------------------------

  let dependenciesPhase: SetupDependenciesPhase | undefined;
  if (options.dependenciesFn) {
    let dependenciesResult: DependencyLifecycleResult;
    try {
      dependenciesResult = await options.dependenciesFn(executor, effectiveConfigDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: "dependencies",
        setup: {
          registration: { ...registration },
          sync: { ok: false, error: "sync skipped due to dependencies failure" },
          config: configPhase,
          agents: agentsPhase,
          dependencies: { ok: false, outcomes: [], report: `dependencies threw: ${message}` },
        },
      };
    }
    dependenciesPhase = {
      ok: dependenciesResult.ok,
      outcomes: dependenciesResult.outcomes,
      report: dependenciesResult.report,
    };
    if (!dependenciesResult.ok) {
      return {
        ok: false,
        stage: "dependencies",
        setup: {
          registration: { ...registration },
          sync: { ok: false, error: "sync skipped due to dependencies failure" },
          config: configPhase,
          agents: agentsPhase,
          dependencies: dependenciesPhase,
        },
      };
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2 — Sync dependencies (R001: NO version-chasing sync on the setup
  // path). The install-only shared lifecycle above (Phase 1d) owns setup
  // dependency state: a present install stays untouched, a missing one is
  // installed, and version upgrades belong exclusively to
  // `aria deps --upgrade`. The `depsSyncFn` seam runs ONLY when a caller
  // explicitly provides it (existing tests); production (`bin/aria.mjs`
  // passes nothing) skips it, so `brew update/upgrade`, GitHub
  // latest-release syncs, and every other version-chasing path never run
  // here. Skipped sync reports ok with install-only ownership noted.
  // -----------------------------------------------------------------------
  let syncResult: Awaited<ReturnType<typeof depsSync>> | undefined;
  if (depsSyncFn !== undefined) {
    try {
      syncResult = await depsSyncFn(executor, effectiveConfigDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: "sync",
        setup: {
          registration: { ...registration },
          sync: { ok: false, error: `depsSync threw: ${message}` },
          config: configPhase,
          agents: agentsPhase,
          dependencies: dependenciesPhase,
        },
      };
    }
  }

  const syncOk = syncResult?.ok ?? true;
  const syncSkipped = syncResult === undefined;

  // -----------------------------------------------------------------------
  // Phase 3 — optional interactive model configuration. Runs only when
  // `--configure` was requested and both registration and sync succeeded;
  // registration/sync failure short-circuiting and ordering are unchanged.
  // -----------------------------------------------------------------------

  if (syncOk && options.configure) {
    const configureModelsFn = options.configureModelsFn ?? configureModels;
    const worktree = options.worktree ?? process.cwd();
    const modelOptions: ModelConfigureOptions = {};
    if (options.input) modelOptions.input = terminalInput(options.input, options.output ?? process.stdout);
    if (options.output) modelOptions.output = terminalOutput(options.output);
    if (options.tty !== undefined) modelOptions.tty = options.tty;

    let modelResult: ModelConfigurationResult;
    try {
      modelResult = await configureModelsFn(worktree, modelOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: "model_configuration",
        setup: {
          registration: { ...registration },
          sync: { ok: true, output: "all dependencies synchronized" },
          config: configPhase,
          agents: agentsPhase,
          dependencies: dependenciesPhase,
          model: {
            status: "failed",
            message: "Model configuration failed; no changes were persisted.",
            error: `configureModels threw: ${message}`,
          },
        },
      };
    }

    // "configured", "unchanged", and non-TTY "skipped" all leave setup
    // healthy; only an explicit discovery/write failure fails the phase.
    if (modelResult.status === "failed") {
      return {
        ok: false,
        stage: "model_configuration",
        setup: {
          registration: { ...registration },
          sync: { ok: true, output: "all dependencies synchronized" },
          config: configPhase,
          agents: agentsPhase,
          dependencies: dependenciesPhase,
          model: modelResult,
        },
      };
    }

    // T003 ordering: after a successful route write, managed agents are
    // regenerated from freshly resolved routes in this same invocation, so
    // agent model/variant values match the newly committed routes without a
    // second setup. Only "configured" regenerates; "unchanged" and "skipped"
    // leave agent files untouched, and "failed" above never reaches here.
    // Resolution is project-neutral (defaults plus global overrides only).
    // Unmanaged/user files survive via installAgentFiles backups.
    if (modelResult.status === "configured") {
      try {
        const fresh = resolveSetupAriaConfig(worktree);
        const refreshed = await installAgentFiles(fresh, { dir: agentsDir });
        const refreshedPhase: SetupAgentsPhase = {
          dir: refreshed.dir,
          version: refreshed.version,
          written: refreshed.written.length,
          unchanged: refreshed.unchanged.length,
        };
        return {
          ok: true,
          stage: "complete",
          setup: {
            registration: { ...registration },
            sync: { ok: true, output: "all dependencies synchronized" },
            config: configPhase,
            agents: refreshedPhase,
            dependencies: dependenciesPhase,
            model: modelResult,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          stage: "model_configuration",
          setup: {
            registration: { ...registration },
            sync: { ok: true, output: "all dependencies synchronized" },
            config: configPhase,
            agents: {
              ...agentsPhase,
              detail: `managed agents could not be regenerated after model configuration: ${message}`,
            },
            dependencies: dependenciesPhase,
            model: modelResult,
          },
        };
      }
    }

    return {
      ok: true,
      stage: "complete",
      setup: {
        registration: { ...registration },
        sync: { ok: true, output: "all dependencies synchronized" },
        config: configPhase,
        agents: agentsPhase,
        dependencies: dependenciesPhase,
        model: modelResult,
      },
    };
  }

  return {
    ok: syncOk,
    stage: syncOk ? "complete" : "sync",
    setup: {
      registration: { ...registration },
      sync: {
        ok: syncOk,
        output: syncOk
          ? syncSkipped
            ? "dependency sync skipped: the install-if-missing lifecycle owns setup (version upgrades belong to `aria deps --upgrade`)"
            : "all dependencies synchronized"
          : undefined,
        error: syncOk ? undefined : "one or more dependencies failed to synchronize",
      },
      config: configPhase,
      agents: agentsPhase,
      dependencies: dependenciesPhase,
    },
  };
}

// ---------------------------------------------------------------------------
// update — git pull, npm ci, subprocess handoff
// ---------------------------------------------------------------------------

export async function update(
  binaryUrl: string,
  executor: Executor = defaultExecutor,
): Promise<LifecycleResult> {
  const checkout = await resolveCheckout(binaryUrl);

  // -----------------------------------------------------------------------
  // Git precondition — working tree must be clean (including untracked files)
  // -----------------------------------------------------------------------
  const statusResult = await run(executor, checkout, "git", "status", "--porcelain");
  if (!statusResult.ok) {
    return {
      ok: false,
      stage: "git_precondition",
      update: {
        git: { ok: false, error: `git status failed: ${statusResult.stderr}` },
        npm: { ok: false, error: "skipped" },
        handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
      },
    };
  }
  if (statusResult.stdout.trim() !== "") {
    return {
      ok: false,
      stage: "git_precondition",
      update: {
        git: { ok: false, error: "working tree is dirty (uncommitted changes or untracked files)" },
        npm: { ok: false, error: "skipped" },
        handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
      },
    };
  }

  // -----------------------------------------------------------------------
  // Git precondition — upstream must exist
  // -----------------------------------------------------------------------
  const upstreamResult = await run(executor, checkout, "git", "rev-parse", "--abbrev-ref", "@{upstream}");
  if (!upstreamResult.ok) {
    return {
      ok: false,
      stage: "git_precondition",
      update: {
        git: { ok: false, error: `no upstream configured: ${upstreamResult.stderr}` },
        npm: { ok: false, error: "skipped" },
        handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
      },
    };
  }

  // -----------------------------------------------------------------------
  // T002 identity gate — the checkout being updated must positively match
  // the registered ARIA plugin (or registration must be positively absent).
  // Runs after the read-only git preconditions but before any mutation
  // (`git pull`, `npm ci`, handoff). A definite mismatch, a duplicate, or
  // an unknown list (probe failure/unrecognized) fails closed with no pull,
  // no install, and no handoff; the only designed transition between
  // releases is the explicit exact-target `aria upgrade --yes` handoff.
  // -----------------------------------------------------------------------
  {
    const pluginUri = pathToFileURL(checkout).href;
    const listResult = await run(executor, checkout, "opencode", "plugin", "list");
    const gateOk = listResult.ok && listResult.stdout;
    if (!gateOk) {
      const reason = !listResult.ok
        ? `opencode plugin list failed (${listResult.stderr || "unknown error"}); the current ARIA registration is not positively identified`
        : "opencode plugin list output is empty; the current ARIA registration is not positively identified";
      const detail = `${reason}. Refusing to guess (run \`aria doctor\` to inspect). No changes were made.`;
      return {
        ok: false,
        stage: "identity",
        update: {
          git: { ok: true },
          npm: { ok: false, error: "skipped" },
          handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
          identity: { ok: false, error: detail },
        },
      };
    }
    const { recognized, entries } = parsePluginList(listResult.stdout);
    if (!recognized) {
      const detail =
        "opencode plugin list output is unrecognized; the current ARIA registration is not positively identified. " +
        "Refusing to guess (run `aria doctor` to inspect). No changes were made.";
      return {
        ok: false,
        stage: "identity",
        update: {
          git: { ok: true },
          npm: { ok: false, error: "skipped" },
          handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
          identity: { ok: false, error: detail },
        },
      };
    }
    const gate = classifySetupIdentity(
      entries,
      (target) => matchesCurrentPluginTarget(target, checkout, pluginUri),
    );
    if (gate.kind !== "matching" && gate.kind !== "absent") {
      return {
        ok: false,
        stage: "identity",
        update: {
          git: { ok: true },
          npm: { ok: false, error: "skipped" },
          handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
          identity: { ok: false, error: gate.detail },
        },
      };
    }
  }

  // -----------------------------------------------------------------------
  // git pull --ff-only
  // -----------------------------------------------------------------------
  const pullResult = await run(executor, checkout, "git", "pull", "--ff-only");
  if (!pullResult.ok) {
    return {
      ok: false,
      stage: "git_pull",
      update: {
        git: { ok: false, error: `git pull --ff-only failed: ${pullResult.stderr}` },
        npm: { ok: false, error: "skipped" },
        handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
      },
    };
  }

  // -----------------------------------------------------------------------
  // npm ci --omit=dev
  // -----------------------------------------------------------------------
  const npmResult = await run(executor, checkout, "npm", "ci", "--omit=dev");
  if (!npmResult.ok) {
    return {
      ok: false,
      stage: "npm",
      update: {
        git: { ok: true },
        npm: { ok: false, error: `npm ci --omit=dev failed: ${npmResult.stderr}` },
        handoff: { exitCode: null, stdout: "", stderr: "", ok: false, error: "skipped" },
      },
    };
  }

  // -----------------------------------------------------------------------
  // Handoff — spawn the updated checkout in a new process
  // -----------------------------------------------------------------------
  const binPath = resolve(checkout, "bin", "aria.mjs");
  const handoffRunResult = await run(executor, checkout, process.execPath, binPath, "deps", "sync");
  const handoffResult: UpdateResult["handoff"] = {
    ...handoffRunResult,
    error: handoffRunResult.ok ? undefined : handoffRunResult.stderr || `exit code ${handoffRunResult.exitCode}`,
  };

  if (!handoffResult.ok) {
    return {
      ok: false,
      stage: "handoff",
      update: {
        git: { ok: true },
        npm: { ok: true },
        handoff: handoffResult,
      },
    };
  }

  return {
    ok: true,
    stage: "complete",
    update: {
      git: { ok: true },
      npm: { ok: true },
      handoff: handoffResult,
    },
  };
}

// Expose for testing
export { resolveCheckout, parsePluginSpecifiers, parsePluginList, run as runInCheckout };
