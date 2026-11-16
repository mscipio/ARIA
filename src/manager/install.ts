import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeOwnedDirectory } from "../safe-fs.ts";
import { validVersion } from "./archive.ts";
import {
  applyEdit,
  configFile,
  discoveredPluginDirs,
  fingerprint,
  getPath,
  isAriaPackage,
  planEdits,
  pluginEntries,
  readConfig,
  samePath,
  staticLayers,
  type Edit,
  type EditPlan,
  type Scope,
} from "./config.ts";
import { ensureIntegration } from "./deps.ts";
import { ariaHome, isWindows, packageRoot, releasesDir, run, statePath, toolsDir } from "./env.ts";
import { createJournal, fault, readJournal, readText, removeJournal, revertFile, saveJournal, type Journal, type JournalFile } from "./journal.ts";
import { MANIFEST, dependency } from "./manifest.ts";
import {
  ReleaseError,
  existingRelease,
  finalize,
  inspect,
  installPackages,
  ownedReleaseDir,
  packageDigest,
  readCurrent,
  removeStaging,
  smokeTest,
  stage,
  stagingOwned,
  writeCurrent,
  writeLaunchers,
  verifyInstalled,
  type Source,
} from "./release.ts";
import { IDENTITY_ALGORITHM } from "./inventory.ts";
import { BlockedError, clearPending, markPending, openJournals, readState, recordTools, withLock, writeAtomic, writeState, type ManagedTool, type Owned, type State, interruptedResult } from "./state.ts";
import type { Change, OperationResult, Progress, Step } from "./types.ts";

/**
 * Installation lifecycle on top of release.ts (staging, integrity, confinement, launchers).
 *
 *   development  the plugin entry points at a checkout; nothing is copied
 *   release      staged in ARIA_HOME/releases/.staging-*, verified (archive members, sha256,
 *                completeness, lockfile install, smoke test, compatibility reconciliation),
 *                renamed to releases/<version>, then activated by repointing ARIA's own plugin
 *                entry and ARIA_HOME/current (which the `aria` launcher follows)
 *
 * Results say exactly what happened: `success`, `partial` (the main change applied, a requested
 * part did not), `failed` (nothing durable applied), `blocked` (needs a decision).
 */

const KEEP_RELEASES = 3;

const fail = (dryRun: boolean, error: string, messages: string[] = [], steps: Step[] = []): OperationResult => ({ ok: false, dryRun, outcome: "failed", steps, changes: [], messages, errors: [error] });

const blockedResult = (dryRun: boolean, blocked: string, messages: string[] = []): OperationResult => ({ ok: false, dryRun, outcome: "blocked", changes: [], messages, errors: [], blocked });

// ------------------------------------------------------------------ registrations

export interface Registration {
  readonly file: string;
  readonly index: number;
  readonly spec: string;
  readonly target: string;
  readonly version: string;
  readonly owned: boolean;
  readonly raw: unknown;
}

/** Every place OpenCode would load an ARIA package from (static view of config files + plugin folders). */
export function registrations(project: string): { entries: Registration[]; discovered: string[]; other: string[] } {
  const { state } = readState();
  const entries: Registration[] = [];
  const other: string[] = [];
  for (const layer of staticLayers(project)) {
    for (const e of pluginEntries(readConfig(layer.path))) {
      if (!e.local) {
        if (/(^|\/)aria(@|$)/.test(e.spec)) other.push(`${layer.path}: "${e.spec}" is a package name, not a path (OpenCode would look it up on npm)`);
        continue;
      }
      const pkg = existsSync(e.local) ? isAriaPackage(e.local) : undefined;
      if (!pkg) {
        if (/aria/i.test(basename(e.local)) && !existsSync(e.local)) other.push(`${layer.path}: "${e.spec}" points to a missing directory`);
        continue;
      }
      const owned = state.owned.some((o) => o.kind === "plugin" && o.file === layer.path && o.fingerprint === fingerprint(e.raw));
      entries.push({ file: layer.path, index: e.index, spec: e.spec, target: e.local, version: pkg.version, owned, raw: e.raw });
    }
  }
  const discovered = discoveredPluginDirs(project).filter((d) => isAriaPackage(d));
  return { entries, discovered, other };
}

function entryValue(target: string, previous: unknown): unknown {
  const options = previous && typeof previous === "object" ? (previous as { options?: unknown }).options : undefined;
  return options ? { package: target, options } : target;
}

/** Plan to make `file` register exactly `target` once. */
function planRegistration(file: string, target: string, project: string, adopt: boolean): { plan?: ReturnType<typeof planEdits>; value?: unknown; blocked?: string; messages: string[] } {
  const { entries, discovered } = registrations(project);
  const messages: string[] = [];
  const here = entries.filter((e) => e.file === file);
  const elsewhere = entries.filter((e) => e.file !== file);
  if (discovered.length) return { messages, blocked: `ARIA is also auto-loaded from ${discovered.join(", ")}; remove that plugins/ folder entry first to avoid a duplicate registration` };
  if (elsewhere.length) {
    return { messages, blocked: `ARIA is already registered in ${elsewhere.map((e) => `${e.file} (${e.target})`).join(", ")}. A second registration would load it twice. Remove one, or run setup for that scope.` };
  }
  if (here.length > 1) return { messages, blocked: `${file} registers ARIA ${here.length} times; remove the extra entries first` };
  const current = here[0];
  if (current && samePath(current.target, target)) return { messages: [`${file} already registers ${target}`] };
  if (current && !current.owned && !adopt) {
    return { messages, blocked: `${file} has a user-written ARIA entry (${current.spec}); ARIA does not change it without --adopt` };
  }
  const list = readConfig(file).value.plugins;
  const index = current ? current.index : Array.isArray(list) ? list.length : 0;
  const value = entryValue(target, current?.raw);
  const plan = planEdits(file, Array.isArray(list) || current ? [{ path: ["plugins", index], value }] : [{ path: ["plugins"], value: [value] }]);
  return { plan, value, messages };
}

/** Apply the registration edit, record ownership, and point the launcher at the active package. */
function activate(file: string, plan: ReturnType<typeof planEdits> | undefined, value: unknown, packageDir: string) {
  if (plan?.changed) {
    applyEdit(plan);
    fault("activate:after-config");
    const { state } = readState();
    state.owned = state.owned.filter((o) => !(o.kind === "plugin" && o.file === file));
    state.owned.push({ file, path: ["plugins"], kind: "plugin", fingerprint: fingerprint(value) });
    writeState(state);
  }
  writeCurrent(packageDir);
  writeLaunchers();
}


// ------------------------------------------------------------------ release pipeline

export interface Reconciliation {
  readonly blocking: readonly string[];
  readonly advisory: readonly string[];
}

/** Ask the STAGED release (its own manifest) whether this environment fits it. */
async function reconcileStaged(dir: string): Promise<Reconciliation> {
  const r = await run(process.execPath, [join(dir, "bin", "aria.mjs"), "reconcile", "--json"], { timeoutMs: 60_000, env: { ...process.env, ARIA_NO_UI: "1" } });
  try {
    return JSON.parse(r.stdout) as Reconciliation;
  } catch {
    return { blocking: [`the staged release could not check compatibility: ${(r.stderr || r.stdout).trim().slice(-200)}`], advisory: [] };
  }
}

interface Obtained {
  readonly dir: string;
  readonly digest: string;
  readonly reused: boolean;
  readonly advisory: readonly string[];
}

/** Stage, verify and install a release (or reuse an identical installed one). */
async function obtainRelease(source: Source, opts: { progress: Progress; signal?: AbortSignal; force?: boolean }): Promise<Obtained> {
  const installed = existingRelease(source); // throws on a same-version conflict
  if (installed) {
    opts.progress(`release ${source.version} already installed with identical content; reusing it`);
    return { dir: installed, digest: source.digest, reused: true, advisory: [] };
  }
  const staged = stage(source, opts.progress);
  try {
    await installPackages(staged.staging.path, opts.progress, opts.signal);
    await smokeTest(staged.staging.path, staged.version);
    const rec = await reconcileStaged(staged.staging.path);
    if (rec.blocking.length && !opts.force) throw new ReleaseError(`release ${staged.version} does not fit this environment: ${rec.blocking.join("; ")} (--force to install anyway)`);
    fault("after-stage");
    const existed = existsSync(join(releasesDir(), staged.version));
    const dir = finalize(staged, opts.progress);
    return { dir, digest: staged.digest, reused: existed, advisory: rec.advisory };
  } catch (error) {
    if (existsSync(staged.staging.path)) {
      try {
        removeStaging(staged.staging.path);
      } catch {
        /* repair re-checks ownership */
      }
    }
    throw error;
  }
}

function recordRelease(state: State, source: Source, dir: string, digest: string) {
  const version = basename(dir);
  const existing = state.releases.find((r) => r.version === version);
  if (!existing) state.releases.push({ version, path: dir, installedAt: new Date().toISOString(), source: source.path, digest, identityAlgorithm: IDENTITY_ALGORITHM, ...(source.sha256 ? { sha256: source.sha256 } : {}) });
}

function setActive(state: State, version: string) {
  if (state.active !== version) {
    recordTools(state, state.active); // the release being left keeps the tools it ran with
    if (state.active) state.previous = state.active;
    state.active = version;
  }
  recordTools(state, version);
}

/** A tool record as stored with a release; pre-alpha.5 records hold only the executable. */
function toolRecord(raw: ManagedTool | string): ManagedTool {
  if (typeof raw !== "string") return raw;
  const parts = raw.split(/[/\\](?:bin|Scripts|node_modules)[/\\]/);
  return { path: parts[0] as string, executable: raw, installedAt: "unknown (legacy record)" };
}

/** Is this tool record an ARIA-managed install that still exists (real directory under tools/)? */
function toolProblem(rec: ManagedTool): string | undefined {
  try {
    const base = realpathSync.native(toolsDir());
    const st = lstatSync(rec.path);
    if (st.isSymbolicLink() || !st.isDirectory()) return `${rec.path} is not a real directory`;
    if (dirname(realpathSync.native(rec.path)) !== base) return `${rec.path} is not directly under ${toolsDir()}`;
    if (!rec.executable.startsWith(rec.path)) return `executable ${rec.executable} is outside ${rec.path}`;
    if (!existsSync(rec.executable)) return `executable ${rec.executable} is missing`;
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? `${rec.path} no longer exists` : (error as Error).message;
  }
}

/** Optional `~/.local/bin/aria` symlink to the launcher; never replaces an existing different file. */
function linkBin(): Step {
  if (isWindows) return { name: "link launcher", status: "skipped", detail: `add ${join(ariaHome(), "bin")} to PATH` };
  const link = join(homedir(), ".local", "bin", "aria");
  const target = join(ariaHome(), "bin", "aria");
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === target) return { name: "link launcher", status: "skipped", detail: `${link} already points to the launcher` };
    return { name: "link launcher", status: "failed", detail: `${link} exists and is not ARIA's launcher; left unchanged` };
  } catch {
    mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
    symlinkSync(target, link);
    return { name: "link launcher", status: "done", detail: `${link} -> ${target}` };
  }
}

// ------------------------------------------------------------------ setup

export interface SetupInput {
  readonly scope: Scope;
  readonly project: string;
  readonly mode: "dev" | "release";
  /** Release source (directory or .tgz with sha256). Default: the package this CLI runs from. */
  readonly from?: string;
  readonly sha256?: string;
  readonly dryRun: boolean;
  readonly adopt?: boolean;
  /** Optional integrations to install if missing, configure and check (manifest ids). */
  readonly with?: readonly string[];
  readonly linkBin?: boolean;
  readonly force?: boolean;
  readonly progress?: Progress;
  readonly signal?: AbortSignal;
}

export async function setup(input: SetupInput): Promise<OperationResult> {
  const interruptedGate = interruptedResult(input.dryRun);
  if (interruptedGate) return interruptedGate;
  const progress = input.progress ?? (() => undefined);
  const file = configFile(input.scope, input.project);
  const messages: string[] = [];
  const changes: Change[] = [];
  const steps: Step[] = [];
  for (const id of input.with ?? []) if (!dependency(id)?.mcp?.config) return fail(input.dryRun, `--with ${id}: not an integration ARIA manages (zotero-mcp, context7, playwright-mcp)`);
  let target: string;
  let source: Source | undefined;
  if (input.mode === "dev") {
    target = input.from ?? packageRoot;
    if (!isAriaPackage(target)) return fail(input.dryRun, `${target} is not an ARIA checkout`);
    messages.push(`development install: OpenCode will load ${target} directly`);
  } else {
    try {
      source = inspect(input.from ?? packageRoot, input.sha256);
    } catch (error) {
      return fail(input.dryRun, (error as Error).message);
    }
    target = join(releasesDir(), source.version);
    messages.push(`source: ${source.path} (${source.version}, ${source.integrity})`);
    try {
      if (existingRelease(source)) messages.push(`release ${source.version} already installed with identical content; reusing it`);
      else changes.push({ kind: "release", target, summary: `stage, verify and install release ${source.version}`, network: true });
    } catch (error) {
      return fail(input.dryRun, (error as Error).message, messages);
    }
  }
  let reg;
  try {
    reg = planRegistration(file, target, input.project, input.adopt ?? false);
  } catch (error) {
    return fail(input.dryRun, (error as Error).message);
  }
  messages.push(...reg.messages);
  if (reg.blocked) return { ok: false, dryRun: input.dryRun, outcome: "blocked", changes, messages, errors: [], blocked: reg.blocked };
  if (reg.plan?.changed) changes.push({ kind: "config", target: file, summary: reg.plan.summary.join("; ") });
  if (readCurrent() !== target) changes.push({ kind: "activate", target: join(ariaHome(), "current"), summary: `launcher ${join(ariaHome(), "bin", "aria")} -> ${target}` });
  if (input.dryRun) {
    for (const id of input.with ?? []) {
      const r = await ensureIntegration(id, { scope: input.scope, project: input.project, dryRun: true });
      changes.push(...r.changes);
      messages.push(...r.messages.map((m) => `${id}: ${m}`), ...r.errors.map((e) => `${id}: ${e}`), ...(r.blocked ? [`${id}: BLOCKED ${r.blocked}`] : []));
    }
    if (input.linkBin) changes.push({ kind: "install", target: join(homedir(), ".local", "bin", "aria"), summary: "symlink to the ARIA launcher (only if nothing is there)" });
    return { ok: true, dryRun: true, outcome: changes.length ? "preview" : "unchanged", changes, messages, errors: [] };
  }
  // 1. Package and registration: all or nothing. A handled failure clears only this invocation's
  // pending marker; a crash leaves it for `aria repair`.
  let nonce: string | undefined;
  let activating = false;
  try {
    await withLock(async () => {
      let digest: string | undefined;
      if (input.mode === "release" && source) {
        nonce = markPending({ op: "setup", version: source.version, step: "stage" });
        const got = await obtainRelease(source, { progress, ...(input.signal ? { signal: input.signal } : {}), ...(input.force ? { force: true } : {}) });
        target = got.dir;
        digest = got.digest;
        messages.push(...got.advisory);
        steps.push({ name: "release", status: "done", detail: `${got.reused ? "reused" : "installed"} ${target}` });
      }
      nonce = markPending({ op: "setup", step: "activate", ...(source ? { version: source.version } : {}) }, nonce);
      fault("before-activate");
      const plan = planRegistration(file, target, input.project, input.adopt ?? false);
      if (plan.blocked) throw new ReleaseError(plan.blocked);
      if (plan.plan?.changed) nonce = markPending({ op: "setup", step: "activate", ...(source ? { version: source.version } : {}), adopt: { file, fingerprint: fingerprint(plan.value) } }, nonce);
      activating = true; // from here a failure may leave config and launcher ahead of state.json
      activate(file, plan.plan, plan.value, target);
      const done = readState().state;
      if (input.mode === "release" && source && digest) {
        recordRelease(done, source, target, digest);
        setActive(done, source.version);
      }
      delete done.pending;
      writeState(done);
      steps.push({ name: "register plugin", status: "done", detail: reg.plan?.changed ? file : "already registered" });
    });
  } catch (error) {
    if (error instanceof BlockedError) return blockedResult(false, error.message, messages);
    if (activating) return interruptedAfterActivation(error, steps, changes, messages);
    clearPending(nonce);
    return { ok: false, dryRun: false, outcome: "failed", steps: [...steps, { name: "install ARIA", status: "failed", detail: (error as Error).message }], changes, messages, errors: [(error as Error).message] };
  }
  const verify = registrations(input.project).entries.filter((e) => samePath(e.target, target));
  if (verify.length !== 1) return { ok: false, dryRun: false, outcome: "failed", steps, changes, messages, errors: [`after setup, ARIA is registered ${verify.length} times for ${target}`] };
  // 2. Optional parts: each reported; any failure makes the result partial, never success.
  const errors: string[] = [];
  for (const id of input.with ?? []) {
    const r = await ensureIntegration(id, { scope: input.scope, project: input.project, dryRun: false, progress, ...(input.signal ? { signal: input.signal } : {}) });
    steps.push(...(r.steps ?? []).map((s) => ({ ...s, name: `${id}: ${s.name}` })));
    changes.push(...r.changes);
    messages.push(...r.messages.map((m) => `${id}: ${m}`));
    if (r.blocked) errors.push(`${id}: blocked: ${r.blocked}`);
    else if (!r.ok) errors.push(...r.errors.map((e) => (e.startsWith(id) ? e : `${id}: ${e}`)));
  }
  if (input.linkBin) {
    const l = linkBin();
    steps.push(l);
    if (l.status === "done") changes.push({ kind: "install", target: join(homedir(), ".local", "bin", "aria"), summary: l.detail ?? "launcher link" });
    if (l.status === "failed") errors.push(l.detail ?? "launcher link failed");
  }
  if (errors.length) return { ok: false, dryRun: false, outcome: "partial", steps, changes, messages: [...messages, "ARIA itself is installed and registered; the parts listed as failed are not."], errors };
  messages.push(changes.length ? "Setup complete. Start a new OpenCode session to load it." : "Nothing to change: ARIA is already set up this way.");
  return { ok: true, dryRun: false, outcome: changes.length ? "success" : "unchanged", steps, changes, messages, errors: [] };
}

// ------------------------------------------------------------------ update / rollback

export interface UpdateInput {
  readonly from?: string;
  readonly sha256?: string;
  readonly project: string;
  readonly dryRun: boolean;
  readonly force?: boolean;
  readonly progress?: Progress;
  readonly signal?: AbortSignal;
}

/** The single ARIA-owned registration that updates and rollbacks repoint. */
function ownedRegistration(project: string): Registration | { error: string } {
  const { entries } = registrations(project);
  if (entries.length === 0) return { error: "ARIA is not registered in any config file; run `aria setup` first" };
  if (entries.length > 1) return { error: `ARIA is registered ${entries.length} times (${entries.map((e) => e.file).join(", ")}); repair that first` };
  const entry = entries[0] as Registration;
  if (!entry.owned) return { error: `${entry.file} registers ARIA with a user-written entry; run \`aria setup --adopt\` to let ARIA manage it` };
  return entry;
}

export async function checkUpdate(input: { from?: string; sha256?: string }): Promise<{ current?: string; channel: string; candidate?: Source; error?: string }> {
  const { state } = readState();
  const current = state.active ?? isAriaPackage(packageRoot)?.version;
  const base = { ...(current ? { current } : {}) };
  if (!input.from) return { ...base, channel: "none", error: "No release channel is configured (ARIA is not published). Point at a package: --from <dir|.tgz>." };
  try {
    return { ...base, channel: "local", candidate: inspect(input.from, input.sha256) };
  } catch (error) {
    return { ...base, channel: "local", error: (error as Error).message };
  }
}

export async function update(input: UpdateInput): Promise<OperationResult> {
  const interruptedGate = interruptedResult(input.dryRun);
  if (interruptedGate) return interruptedGate;
  const progress = input.progress ?? (() => undefined);
  if (!input.from) return fail(input.dryRun, "No release channel is configured (ARIA is not published). Use --from <dir|.tgz>.");
  let source: Source;
  try {
    source = inspect(input.from, input.sha256);
  } catch (error) {
    return fail(input.dryRun, (error as Error).message);
  }
  const reg = ownedRegistration(input.project);
  if ("error" in reg) return fail(input.dryRun, reg.error);
  const { state } = readState();
  const target = join(releasesDir(), source.version);
  const messages = [`current: ${reg.version} at ${reg.target}`, `candidate: ${source.version} from ${source.path} (${source.integrity})`];
  if (samePath(reg.target, target)) {
    try {
      existingRelease(source);
    } catch (error) {
      return fail(input.dryRun, (error as Error).message, messages);
    }
    return { ok: true, dryRun: input.dryRun, outcome: "unchanged", changes: [], messages: [...messages, "Already active, identical content."], errors: [] };
  }
  try {
    if (existingRelease(source)) messages.push(`${source.version} is already installed with identical content; it will be reused`);
  } catch (error) {
    return fail(input.dryRun, (error as Error).message, messages);
  }
  const changes: Change[] = [];
  if (!existsSync(target)) changes.push({ kind: "release", target, summary: `stage, verify and install ${source.version}`, network: true });
  changes.push({ kind: "activate", target: reg.file, summary: `plugins.${reg.index}: ${reg.target} -> ${target}` });
  changes.push({ kind: "state", target: "state.json", summary: `active ${state.active ?? reg.version} -> ${source.version}; previous kept for rollback; launcher follows` });
  messages.push("The previous release stays on disk; `aria rollback` returns to it. Running OpenCode sessions keep the files they loaded.");
  if (input.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages, errors: [] };
  const steps: Step[] = [];
  let nonce: string | undefined;
  let activating = false;
  try {
    await withLock(async () => {
      nonce = markPending({ op: "update", version: source.version, step: "stage" });
      const got = await obtainRelease(source, { progress, ...(input.signal ? { signal: input.signal } : {}), ...(input.force ? { force: true } : {}) });
      messages.push(...got.advisory);
      steps.push({ name: "release", status: "done", detail: `${got.reused ? "reused" : "installed"} ${got.dir}` });
      nonce = markPending({ op: "update", version: source.version, step: "activate" }, nonce);
      const s2 = readState().state;
      if (!s2.active && ownedReleaseDir(reg.target)) {
        s2.active = reg.version;
        writeState(s2);
      }
      fault("before-activate");
      // The config may have changed while the release was staged (npm ci can take minutes):
      // find the registration again and require it to still be the single ARIA-owned entry.
      const now = ownedRegistration(input.project);
      if ("error" in now) throw new ReleaseError(`the registration changed while the release was being installed: ${now.error}; nothing activated`);
      if (now.file !== reg.file || !samePath(now.target, reg.target)) throw new ReleaseError(`the registration changed while the release was being installed (${now.file}: ${now.target}); nothing activated`);
      if (discoveredPluginDirs(input.project).some((d) => isAriaPackage(d))) throw new ReleaseError("ARIA is now also auto-loaded from a plugins/ folder; nothing activated");
      const value = entryValue(got.dir, now.raw);
      const plan = planEdits(now.file, [{ path: ["plugins", now.index], value }]);
      nonce = markPending({ op: "update", version: source.version, step: "activate", adopt: { file: now.file, fingerprint: fingerprint(value) } }, nonce);
      activating = true;
      activate(now.file, plan, value, got.dir);
      fault("after-activate");
      const done = readState().state;
      recordRelease(done, source, got.dir, got.digest);
      setActive(done, source.version);
      delete done.pending;
      writeState(done);
      activating = false;
      steps.push({ name: "activate", status: "done" });
      try {
        const pruned = prune();
        if (pruned.length) messages.push(`removed old ARIA releases: ${pruned.join(", ")}`);
      } catch (e) {
        messages.push(`old releases were not pruned: ${(e as Error).message}`);
      }
    });
  } catch (error) {
    if (error instanceof BlockedError) return blockedResult(false, error.message, messages);
    if (activating) return interruptedAfterActivation(error, steps, changes, messages);
    clearPending(nonce);
    return { ok: false, dryRun: false, outcome: "failed", steps: [...steps, { name: "update", status: "failed", detail: (error as Error).message }], changes, messages: [...messages, "Run `aria doctor` to see the state; `aria repair` clears an interrupted step."], errors: [(error as Error).message] };
  }
  return { ok: true, dryRun: false, outcome: "success", steps, changes, messages: [...messages, "Updated. New OpenCode sessions load the new release."], errors: [] };
}

/**
 * A handled error after activation began: config and launcher may already name the new release
 * while state.json does not. That is reported like a crash: the marker stays, other changes are
 * refused (exit 4) and `aria repair` re-records the state from what the config loads.
 */
function interruptedAfterActivation(error: unknown, steps: Step[], changes: Change[], messages: string[]): OperationResult {
  const message = (error as Error).message;
  return {
    ok: false, dryRun: false, outcome: "failed", changes,
    steps: [...steps, { name: "activate", status: "failed", detail: message }],
    messages: [...messages, "INTERRUPTED during activation: the plugin entry or launcher may already point at the new release while state.json does not. The interrupted-operation marker is kept; run `aria repair`, which records the release the config actually loads. Other ARIA changes are refused until then."],
    errors: [message],
  };
}

// ------------------------------------------------------------------ journaled rollback

export interface RollbackInput {
  readonly to?: string;
  readonly project: string;
  readonly dryRun: boolean;
  /** Roll back only the ARIA package; ARIA-managed tool paths stay as they are. */
  readonly keepTools?: boolean;
}

interface ToolRestore {
  readonly id: string;
  readonly record: ManagedTool;
  readonly owned?: Owned;
  readonly edit?: Edit;
  /** The full MCP entry value after the edit (for the ownership fingerprint). */
  readonly next?: unknown;
}

const isOurMarker = (j: Pick<Journal, "id">) => (text: string) => {
  try {
    return (JSON.parse(text) as State).pending?.journal === j.id;
  } catch {
    return false;
  }
};

/**
 * Revert the files of a journal in reverse write order (state.json last, so the interrupted
 * marker stays until everything else is back). A file is reverted only if it holds exactly what
 * ARIA wrote; anything else is reported as modified and left alone.
 */
function revertJournal(j: Journal, label: string): { reverted: string[]; modified: string[]; complete: boolean } {
  const reverted: string[] = [];
  const modified: string[] = [];
  const stateFile = j.files.find((f) => f.role === "state");
  for (const f of [...j.files].reverse()) {
    if (f.role === "state") continue;
    // A file ARIA never started writing is not ARIA's to revert, whatever it holds now.
    if (!j.progress.written.includes(f.path) && j.progress.inflight !== f.path) continue;
    fault(`${label}:revert:${f.role}`);
    const r = revertFile(f);
    if (r === "reverted") reverted.push(f.path);
    if (r === "modified") modified.push(f.path);
  }
  if (modified.length === 0 && stateFile) {
    fault(`${label}:revert:state`);
    const r = revertFile(stateFile, isOurMarker(j));
    if (r === "reverted") reverted.push(stateFile.path);
    if (r === "modified") modified.push(stateFile.path);
  }
  const complete = modified.length === 0;
  if (complete) removeJournal(j.id);
  return { reverted, modified, complete };
}

export async function rollback(input: RollbackInput): Promise<OperationResult> {
  const interruptedGate = interruptedResult(input.dryRun);
  if (interruptedGate) return interruptedGate;
  const reg = ownedRegistration(input.project);
  if ("error" in reg) return fail(input.dryRun, reg.error);
  const stateText = readText(statePath());
  const { state } = readState();
  const version = input.to ?? state.previous;
  if (!version) return fail(input.dryRun, "no previous release recorded; nothing to roll back to");
  if (!validVersion(version)) return fail(input.dryRun, `invalid version ${JSON.stringify(version)}`);
  const release = state.releases.find((r) => r.version === version);
  const dir = release ? ownedReleaseDir(release.path) : undefined;
  if (!release || !dir || basename(dir) !== version || !isAriaPackage(dir)) return fail(input.dryRun, `release ${version} is not installed under ${releasesDir()}`);
  const integrity = verifyInstalled(dir, release);
  if (!integrity.ok) return fail(input.dryRun, `release ${version} failed its integrity check (${integrity.detail}); reinstall it instead of rolling back`);
  if (samePath(reg.target, dir)) return { ok: true, dryRun: input.dryRun, outcome: "unchanged", changes: [], messages: [`${version} is already active`], errors: [] };
  const leaving = state.active ?? reg.version;
  const messages: string[] = [];

  // 1. Tools: validate every record and every entry to be changed before anything is written.
  const blockers: string[] = [];
  const restores: ToolRestore[] = [];
  if (input.keepTools) messages.push("--keep-tools: ARIA-managed tool paths stay as they are; only the ARIA package is rolled back.");
  else if (!release.tools || Object.keys(release.tools).length === 0) messages.push(`no ARIA-managed tools were recorded with ${version}; tool paths stay as they are`);
  else {
    for (const [id, raw] of Object.entries(release.tools)) {
      const record = toolRecord(raw);
      const dep = dependency(id);
      if (!dep?.mcp) continue;
      const problem = toolProblem(record);
      if (problem) {
        blockers.push(`${id}: the copy ${version} used is not usable (${problem}); reinstall it with \`aria deps install ${id}\` or roll back with --keep-tools`);
        continue;
      }
      const entries = state.owned.filter((o) => o.kind === "mcp" && o.path.join("/") === `mcp/servers/${dep.mcp?.server}`);
      if (entries.length === 0) restores.push({ id, record });
      for (const owned of entries) {
        const read = readConfig(owned.file);
        if (read.errors.length) {
          blockers.push(`${owned.file} has syntax errors; fix it first`);
          continue;
        }
        const value = getPath(read.value, owned.path as (string | number)[]) as { command?: unknown } | undefined;
        if (value === undefined) {
          messages.push(`${owned.file}: mcp.servers.${dep.mcp.server} no longer exists; nothing to repoint`);
          restores.push({ id, record });
          continue;
        }
        if (fingerprint(value) !== owned.fingerprint) {
          blockers.push(`${owned.file}: mcp.servers.${dep.mcp.server} was changed since ARIA wrote it; ARIA does not overwrite your edit (roll back with --keep-tools, or restore the entry)`);
          continue;
        }
        if (!Array.isArray(value.command) || typeof value.command[0] !== "string") {
          blockers.push(`${owned.file}: mcp.servers.${dep.mcp.server} has no command to repoint`);
          continue;
        }
        if (value.command[0] === record.executable) {
          restores.push({ id, record, owned });
          continue;
        }
        const next = { ...value, command: [record.executable, ...value.command.slice(1)] };
        restores.push({ id, record, owned, edit: { path: [...owned.path, "command", 0], value: record.executable }, next });
      }
    }
    const notRecorded = Object.keys(state.tools).filter((id) => !release.tools?.[id]);
    if (notRecorded.length) messages.push(`${notRecorded.join(", ")}: not recorded with ${version}; left as they are`);
  }
  if (blockers.length) return { ...blockedResult(input.dryRun, blockers.join("; "), messages), errors: blockers };

  // 2. The complete change set: final content of every file, in write order.
  const pluginValue = entryValue(dir, reg.raw);
  const editsByFile = new Map<string, Edit[]>();
  for (const r of restores) if (r.edit && r.owned) editsByFile.set(r.owned.file, [...(editsByFile.get(r.owned.file) ?? []), r.edit]);
  editsByFile.set(reg.file, [...(editsByFile.get(reg.file) ?? []), { path: ["plugins", reg.index], value: pluginValue }]);
  const plans: EditPlan[] = [];
  try {
    for (const [file, edits] of editsByFile) if (file !== reg.file) plans.push(planEdits(file, edits));
    plans.push(planEdits(reg.file, editsByFile.get(reg.file) as Edit[]));
  } catch (error) {
    return fail(input.dryRun, (error as Error).message, messages);
  }
  const currentFile = join(ariaHome(), "current");
  const next = JSON.parse(JSON.stringify(state)) as State;
  recordTools(next, leaving);
  for (const r of restores) next.tools[r.id] = { ...r.record };
  next.owned = next.owned.map((o) => {
    if (o.kind === "plugin" && o.file === reg.file) return { ...o, fingerprint: fingerprint(pluginValue) };
    // `next` is a deep copy: match records by file and JSON path, not by object identity.
    const r = restores.find((x) => x.owned && x.next !== undefined && x.owned.file === o.file && x.owned.path.join("/") === o.path.join("/"));
    return r ? { ...o, fingerprint: fingerprint(r.next) } : o;
  });
  next.previous = leaving;
  next.active = version;
  delete next.pending;
  const files: JournalFile[] = [
    ...plans.map((p) => ({ path: p.file, role: (p.file === reg.file ? "plugin-config" : "mcp-config") as JournalFile["role"], before: p.existed ? p.before : null, after: p.after })),
    { path: currentFile, role: "launcher", before: readText(currentFile), after: `${dir}\n` },
    { path: statePath(), role: "state", before: stateText, after: JSON.stringify(next, null, 2) + "\n" },
  ];
  const changes: Change[] = [
    ...plans.filter((p) => p.file !== reg.file).map((p) => ({ kind: "config" as const, target: p.file, summary: p.summary.join("; ") })),
    { kind: "activate", target: reg.file, summary: plans.at(-1)?.summary.join("; ") ?? "" },
    { kind: "activate", target: currentFile, summary: `launcher -> ${dir}` },
    ...restores.filter((r) => !r.edit).map((r) => ({ kind: "state" as const, target: "state.json", summary: `${r.id}: record the copy ${version} used (${r.record.executable})` })),
    { kind: "state", target: "state.json", summary: `active ${leaving} -> ${version}; ${leaving} keeps a record of its tools` },
  ];
  messages.unshift("Rolls back the ARIA package and the ARIA-managed tool paths it used, with a journal: an interruption is either reverted or reported for `aria repair`. Your model assignments and your own config entries stay as they are.");
  if (input.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages, errors: [] };

  // 3. Apply: journal, marker, MCP config files, plugin config file, launcher, state.json.
  let journal: Journal | undefined;
  let nonce: string | undefined;
  let committed = false;
  try {
    return await withLock(async () => {
      if (readText(statePath()) !== stateText) throw new Error("state.json changed since the rollback was planned; nothing written. Try again.");
      fault("rollback:before-journal");
      journal = createJournal({ op: "rollback", from: leaving, target: version, files });
      fault("rollback:after-journal");
      nonce = markPending({ op: "rollback", version, step: "apply", journal: journal.id });
      fault("rollback:after-marker");
      for (const f of files) {
        if (f.role !== "state" && readText(f.path) !== f.before) throw new Error(`${f.path} changed while the rollback was running; stopping`);
        journal.progress.inflight = f.path;
        saveJournal(journal);
        fault(`rollback:before:${f.role}`);
        if (f.after === null) unlinkSync(f.path);
        else writeAtomic(f.path, f.after);
        if (f.role === "state") committed = true; // active release recorded: the rollback has happened
        journal.progress.written.push(f.path);
        journal.progress.inflight = null;
        if (!committed) saveJournal(journal);
        fault(`rollback:after:${f.role}`);
      }
      removeJournal(journal.id);
      writeLaunchers();
      return { ok: true, dryRun: false, outcome: "success" as const, steps: files.map((f) => ({ name: `write ${f.role}`, status: "done" as const, detail: f.path })), changes, messages: [...messages, `Rolled back to ${version}.`], errors: [] };
    });
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof BlockedError) return { ...blockedResult(false, message, messages) };
    if (!journal) return { ok: false, dryRun: false, outcome: "failed", changes, messages, errors: [message] };
    if (committed) {
      // Everything was written; only the journal clean-up failed. Repair removes a journal whose target is active.
      return { ok: false, dryRun: false, outcome: "partial", changes, messages: [...messages, `Rolled back to ${version}, but the journal ${journal.id} could not be removed; \`aria repair\` removes it.`], errors: [message] };
    }
    // A handled error: revert straight away, but only the journal this invocation created.
    let undo: ReturnType<typeof revertJournal> | undefined;
    let undoError: string | undefined;
    try {
      undo = revertJournal(journal, "rollback");
    } catch (e) {
      undoError = (e as Error).message;
    }
    if (undo?.complete) {
      clearPending(nonce); // normally already gone: state.json was put back as it was
      return { ok: false, dryRun: false, outcome: "failed", changes, messages: [...messages, `Nothing changed: every file written so far was put back (${undo.reverted.length} file(s)). ${leaving} is still active.`], errors: [message] };
    }
    return {
      ok: false, dryRun: false, outcome: "failed", changes,
      messages: [...messages, `INTERRUPTED: the rollback stopped and could not be fully undone${undo?.modified.length ? ` (changed by someone else since ARIA wrote them: ${undo.modified.join(", ")})` : ""}${undoError ? ` (${undoError})` : ""}. Journal ${journal.id} is kept; other ARIA changes are refused until \`aria repair\` resolves it.`],
      errors: [message],
    };
  }
}

// ------------------------------------------------------------------ repair / retention

/** Staging directories ARIA knows about or finds, each with whether ownership can be established. */
export function leftovers(): { path: string; owned: boolean; reason: string }[] {
  const seen = new Set<string>();
  const out: { path: string; owned: boolean; reason: string }[] = [];
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const c = stagingOwned(path);
    out.push({ path, owned: c.owned, reason: c.reason });
  };
  for (const s of readState().state.stagings ?? []) add(s.path);
  for (const dir of [releasesDir(), toolsDir()]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.startsWith(".staging-")) add(join(dir, name));
  }
  return out;
}

export interface JournalView {
  readonly id: string;
  readonly op?: string;
  readonly from?: string;
  readonly target?: string;
  readonly createdAt?: string;
  /** complete: the target is active and no marker refers to it; interrupted: needs reverting. */
  readonly status: "complete" | "interrupted" | "unreadable";
  readonly files: readonly { path: string; role: string; now: "before" | "after" | "changed" | "marker" }[];
  readonly written: readonly string[];
  readonly inflight: string | null;
  readonly error?: string;
}

/** Journals of unfinished operations, with what each file holds now. */
export function journals(): JournalView[] {
  const { state } = readState();
  return openJournals().map((name) => {
    const { id, journal, error } = readJournal(name);
    if (!journal) return { id, status: "unreadable", files: [], written: [], inflight: null, ...(error ? { error } : {}) };
    const marked = state.pending?.journal === journal.id;
    const files = journal.files.map((f) => {
      const now = readText(f.path);
      const where = now === f.after ? "after" : now === f.before ? "before" : now !== null && f.role === "state" && isOurMarker(journal)(now) ? "marker" : "changed";
      return { path: f.path, role: f.role, now: where as "before" | "after" | "changed" | "marker" };
    });
    return {
      id, op: journal.op, from: journal.from ?? "", target: journal.target, createdAt: journal.createdAt,
      status: !marked && state.active === journal.target ? "complete" : "interrupted",
      files, written: journal.progress.written, inflight: journal.progress.inflight,
    };
  });
}

/**
 * `--keep-changed`: after reverting what can be reverted, keep the files the user changed and
 * rebuild state from what is actually on disk: the active release is the one the registration
 * loads, ownership is re-adopted only for values that are still exactly ARIA's, and the tool
 * records follow the executables the config uses. If the package and a tool path now come from
 * different releases, that is reported as partial, not success.
 */
function keepChanged(j: Journal, project: string): { outcome: "success" | "partial"; messages: string[] } {
  const messages: string[] = [];
  let mixed = false;
  const stateFile = j.files.find((f) => f.role === "state");
  const base = JSON.parse(stateFile?.before ?? "null") as State | null;
  const after = JSON.parse(stateFile?.after ?? "null") as State | null;
  const s = base ?? readState().state;
  // Ownership: re-adopt values that are still what ARIA wrote (before or after the rollback).
  const known = new Map<string, Owned[]>();
  for (const o of [...(base?.owned ?? []), ...(after?.owned ?? [])]) known.set(`${o.file}\0${o.path.join("/")}`, [...(known.get(`${o.file}\0${o.path.join("/")}`) ?? []), o]);
  const owned: Owned[] = [];
  for (const records of known.values()) {
    const first = records[0] as Owned;
    if (first.kind === "plugin") {
      // Plugin records name the `plugins` list; the fingerprint is of ARIA's entry in it.
      const entry = pluginEntries(readConfig(first.file)).find((e) => records.some((o) => o.fingerprint === fingerprint(e.raw)));
      if (entry) owned.push({ ...first, fingerprint: fingerprint(entry.raw) });
      else messages.push(`${first.file}: the ARIA plugin entry is no longer what ARIA wrote (changed by you); ARIA will not modify it (\`aria setup --adopt\` hands it back)`);
      continue;
    }
    const value = getPath(readConfig(first.file).value, first.path as (string | number)[]);
    if (value !== undefined && records.some((o) => o.fingerprint === fingerprint(value))) owned.push({ ...first, fingerprint: fingerprint(value) });
    else messages.push(`${first.file}: ${first.path.join(".")} is no longer ARIA's (changed by you); ARIA will not modify it`);
  }
  s.owned = owned;
  // Active release: the one the registration actually loads.
  delete s.pending;
  const regs = registrations(project).entries;
  const loaded = regs.length === 1 ? regs[0] : undefined;
  const loadedDir = loaded ? ownedReleaseDir(loaded.target) : undefined;
  if (!loaded || !loadedDir) {
    mixed = true;
    messages.push(regs.length === 1 ? `the registration loads ${loaded?.target}, which is not an ARIA release directory` : `ARIA is registered ${regs.length} times; fix the registrations, then run repair again`);
  } else {
    if (s.active !== loaded.version) {
      s.previous = s.active === loaded.version ? s.previous : s.active;
      s.active = loaded.version;
    }
    if (readText(join(ariaHome(), "current")) !== `${loadedDir}\n`) writeCurrent(loadedDir);
    messages.push(`active release: ${loaded.version} (the one the registration loads; launcher follows)`);
  }
  // Tools: follow the executables the config uses, and say which release they came from.
  const records = (s.releases ?? []).map((r) => ({ version: r.version, tools: Object.fromEntries(Object.entries(r.tools ?? {}).map(([id, t]) => [id, toolRecord(t)])) }));
  for (const o of owned.filter((x) => x.kind === "mcp")) {
    const server = String(o.path[2]);
    const dep = MANIFEST.find((d) => d.mcp?.server === server);
    if (!dep) continue;
    const value = getPath(readConfig(o.file).value, o.path as (string | number)[]) as { command?: string[] } | undefined;
    const exe = value?.command?.[0];
    if (!exe) continue;
    const from = records.filter((r) => r.tools[dep.id]?.executable === exe);
    const rec = from[0]?.tools[dep.id] ?? (s.tools[dep.id]?.executable === exe ? s.tools[dep.id] : undefined);
    if (rec) s.tools[dep.id] = rec;
    const versions = from.map((r) => r.version);
    if (s.active && versions.length && !versions.includes(s.active)) {
      mixed = true;
      messages.push(`${dep.id} runs the copy recorded with ${versions.join("/")}, while the package is ${s.active}: they now come from different releases`);
    }
  }
  writeState(s);
  removeJournal(j.id);
  return { outcome: mixed ? "partial" : "success", messages };
}

export async function repair(input: { project: string; dryRun: boolean; keepChanged?: boolean }): Promise<OperationResult> {
  const { state, error } = readState();
  const changes: Change[] = [];
  const messages: string[] = [];
  if (error) messages.push(`state.json: ${error}; it will be rebuilt from what is on disk`);
  const open = journals();
  for (const j of open) {
    if (j.status === "unreadable") messages.push(`journal ${j.id} cannot be read (${j.error}); left in place. Inspect ${join(ariaHome(), "journal")} yourself.`);
    else if (j.status === "complete") changes.push({ kind: "state", target: `journal ${j.id}`, summary: `${j.op} to ${j.target} completed; remove its journal` });
    else {
      for (const f of j.files) {
        if (f.now === "after" || f.now === "marker") changes.push({ kind: f.role === "state" ? "state" : "config", target: f.path, summary: `put back as it was before the interrupted ${j.op} to ${j.target}` });
        else if (f.now === "changed") messages.push(`${f.path} was changed after ARIA wrote it; repair will not overwrite it${input.keepChanged ? " (--keep-changed: kept as it is)" : ". Use --keep-changed to keep it and rebuild state around it"}`);
      }
      if (!j.files.some((f) => f.now === "after" || f.now === "marker")) changes.push({ kind: "state", target: `journal ${j.id}`, summary: `nothing was written by the interrupted ${j.op}; remove its journal` });
    }
  }
  const markerJournal = state.pending?.journal;
  if (state.pending && !markerJournal) changes.push({ kind: "state", target: "state.json", summary: `clear interrupted ${state.pending.op} (${state.pending.step})` });
  if (markerJournal && !open.some((j) => j.id === markerJournal)) changes.push({ kind: "state", target: "state.json", summary: `clear the marker of ${state.pending?.op} (its journal ${markerJournal} is gone)` });
  const left = leftovers();
  for (const l of left) {
    if (l.owned) changes.push({ kind: "cleanup", target: l.path, summary: `remove ARIA staging directory ${basename(l.path)} (${l.reason})` });
    else if (existsSync(l.path)) messages.push(`NOT removing ${l.path}: ARIA cannot establish it owns it (${l.reason}). Inspect and remove it yourself if it is junk.`);
    else changes.push({ kind: "state", target: "state.json", summary: `forget staging record ${basename(l.path)} (directory gone)` });
  }
  const unresolved = open.some((j) => j.status === "interrupted");
  const { entries } = registrations(input.project);
  const active = entries.length === 1 ? entries[0] : undefined;
  const activeDir = active ? ownedReleaseDir(active.target) : undefined;
  if (!unresolved) {
    if (active && activeDir && state.active !== active.version) changes.push({ kind: "state", target: "state.json", summary: `active release recorded as ${state.active ?? "none"}, config loads ${active.version}; record ${active.version}` });
    if (active && readCurrent() !== active.target) changes.push({ kind: "activate", target: join(ariaHome(), "current"), summary: `launcher -> ${active.target}` });
    for (const r of state.releases.filter((r) => !ownedReleaseDir(r.path))) changes.push({ kind: "state", target: "state.json", summary: `forget release ${r.version} (not a valid release directory any more)` });
  } else messages.push("Interrupted operations are resolved first; the active release is re-checked afterwards (run repair again if needed).");
  if (entries.length > 1) messages.push(`ARIA is registered ${entries.length} times; repair does not remove config entries. Keep one: ${entries.map((e) => e.file).join(", ")}`);
  if (!changes.length && !open.length) return { ok: true, dryRun: input.dryRun, outcome: "unchanged", changes, messages: [...messages, "Nothing to repair."], errors: [] };
  if (input.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages, errors: [] };
  const errors: string[] = [];
  let outcome: OperationResult["outcome"] = "success";
  const steps: Step[] = [];
  await withLock(
    async () => {
      // 1. Journaled operations.
      for (const view of open) {
        if (view.status === "unreadable") {
          errors.push(`journal ${view.id} unreadable`);
          continue;
        }
        const { journal } = readJournal(`${view.id}.json`);
        if (!journal) continue;
        if (view.status === "complete") {
          removeJournal(journal.id);
          steps.push({ name: `journal ${journal.id}`, status: "done", detail: `${journal.op} to ${journal.target} had completed; journal removed` });
          continue;
        }
        let undo: ReturnType<typeof revertJournal>;
        try {
          undo = revertJournal(journal, "repair");
        } catch (e) {
          errors.push(`reverting ${journal.id}: ${(e as Error).message}`);
          steps.push({ name: `revert ${journal.op} to ${journal.target}`, status: "failed", detail: (e as Error).message });
          continue;
        }
        if (undo.complete) {
          steps.push({ name: `revert ${journal.op} to ${journal.target}`, status: "done", detail: `${undo.reverted.length} file(s) put back; ${journal.from ?? "the previous release"} is active again` });
          continue;
        }
        if (input.keepChanged) {
          const k = keepChanged(journal, input.project);
          steps.push({ name: `keep changed files of ${journal.id}`, status: k.outcome === "success" ? "done" : "failed", detail: k.messages.join("; ") });
          messages.push(...k.messages);
          if (k.outcome === "partial") outcome = "partial";
          continue;
        }
        steps.push({ name: `revert ${journal.op} to ${journal.target}`, status: "failed", detail: `${undo.reverted.length} file(s) put back; not touched because they were changed after ARIA wrote them: ${undo.modified.join(", ")}` });
        errors.push(`journal ${journal.id}: ${undo.modified.length} file(s) changed by someone else; resolve them by hand, or run \`aria repair --keep-changed\` to keep them and rebuild state around them`);
      }
      // 2. Markers without a journal, staging leftovers, state vs config.
      const s = readState().state;
      const stillOpen = openJournals().length > 0;
      if (s.pending && (!s.pending.journal || !openJournals().includes(`${s.pending.journal}.json`))) {
        // An activation interrupted between its config write and its ownership record: the entry
        // is ARIA's if it is exactly what the activation was about to write.
        const adopt = s.pending.adopt;
        if (adopt && pluginEntries(readConfig(adopt.file)).some((e) => fingerprint(e.raw) === adopt.fingerprint)) {
          s.owned = s.owned.filter((o) => !(o.kind === "plugin" && o.file === adopt.file));
          s.owned.push({ file: adopt.file, path: ["plugins"], kind: "plugin", fingerprint: adopt.fingerprint });
          steps.push({ name: "re-adopt plugin entry", status: "done", detail: `${adopt.file}: the entry the interrupted activation wrote` });
        }
        delete s.pending;
        writeState(s);
      }
      for (const l of left) {
        if (!l.owned) {
          if (!existsSync(l.path)) {
            const x = readState().state;
            x.stagings = (x.stagings ?? []).filter((y) => y.path !== l.path);
            writeState(x);
          }
          continue;
        }
        try {
          removeStaging(l.path);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (stillOpen) return;
      const regs = registrations(input.project).entries;
      const act = regs.length === 1 ? regs[0] : undefined;
      const actDir = act ? ownedReleaseDir(act.target) : undefined;
      const x = readState().state;
      x.releases = x.releases.filter((r) => ownedReleaseDir(r.path));
      if (act && actDir) {
        if (!x.releases.some((r) => r.version === act.version)) {
          let digest: string | undefined;
          try {
            digest = packageDigest(actDir);
          } catch {
            /* an unverifiable release is still recorded, without identity */
          }
          x.releases.push({ version: act.version, path: actDir, installedAt: new Date().toISOString(), source: "recovered", ...(digest ? { digest, identityAlgorithm: IDENTITY_ALGORITHM } : {}) });
        }
        if (x.active !== act.version) {
          x.previous = x.active;
          x.active = act.version;
        }
      }
      writeState(x);
      if (act) {
        writeCurrent(act.target);
        writeLaunchers();
      }
    },
    { allowInterrupted: true },
  );
  if (errors.length && outcome === "success") outcome = steps.some((st) => st.status === "done") ? "partial" : "failed";
  return { ok: errors.length === 0 && outcome === "success", dryRun: false, outcome, steps, changes, messages: [...messages, outcome === "success" ? "Repaired." : "Repaired partly; see the failed steps."], errors };
}

/**
 * Remove releases ARIA installed that are neither active, previous, the running package, nor among
 * the newest kept. Only real release directories recorded in state are candidates; unknown
 * directories and links are never touched.
 */
export function prune(): string[] {
  const { state } = readState();
  const protect = new Set([state.active, state.previous].filter(Boolean));
  const sorted = [...state.releases].sort((a, b) => b.installedAt.localeCompare(a.installedAt));
  const removed: string[] = [];
  sorted.forEach((r, i) => {
    if (i < KEEP_RELEASES || protect.has(r.version) || !validVersion(r.version)) return;
    const dir = ownedReleaseDir(r.path);
    if (!dir || basename(dir) !== r.version || samePath(dir, packageRoot)) return;
    const st = lstatSync(dir);
    removeOwnedDirectory(releasesDir(), r.version, { dev: st.dev, ino: st.ino });
    removed.push(r.version);
  });
  if (removed.length) {
    const s = readState().state;
    s.releases = s.releases.filter((r) => !removed.includes(r.version));
    writeState(s);
  }
  return removed;
}
