import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ZOTERO_MUTATE, ZOTERO_READ } from "../permissions.ts";
import { applyEdit, configFile, fingerprint, getPath, planEdits, readConfig, staticLayers, type Scope } from "./config.ts";
import { isWindows, packageRoot, parseVersion, run, satisfies, toolsDir, which } from "./env.ts";
import { MANIFEST, dependency, type Dependency } from "./manifest.ts";
import { createStaging, forgetStaging, removeMarker, removeStaging } from "./release.ts";
import { browserInstalled, checkBrowser } from "./browser.ts";
import { probeRemote, probeTools, type RemoteClass } from "./mcp-probe.ts";
import { opencodeBin } from "./opencode.ts";
import { readState, recordTools, withLock, writeState, type ManagedTool, interruptedResult } from "./state.ts";
import type { Change, Check, Health, OperationResult, Progress, Step } from "./types.ts";

/** Status of one manifest entry, built only from what can be observed now. */
export interface DepStatus {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly kind: Dependency["kind"];
  readonly requirement: Dependency["requirement"];
  readonly enabled: boolean;
  /** Where the enabling MCP entry lives and whether ARIA wrote it. */
  readonly config?: { file: string; owned: boolean; value: unknown };
  readonly executable?: string;
  /**
   * Who owns the lifecycle, from the manifest policy and the copy actually in use:
   * aria-managed (ARIA installs, updates and rolls it back), reused (an existing copy of an
   * either-owned tool; ARIA does not change it), external (the user owns it), hosted (a remote
   * service; nothing installed).
   */
  readonly ownership: "aria-managed" | "reused" | "external" | "hosted";
  /** For ARIA-managed tools: is ARIA's own copy installed? */
  readonly installed?: boolean;
  readonly version?: string;
  readonly wanted?: string;
  readonly health: Health;
  readonly basis: Check["basis"];
  readonly evidence: readonly string[];
  readonly actions: readonly string[];
}

function mcpEntry(dep: Dependency, project: string): DepStatus["config"] | undefined {
  if (!dep.mcp) return undefined;
  const { state } = readState();
  let found: DepStatus["config"];
  for (const layer of staticLayers(project)) {
    const value = getPath(readConfig(layer.path).value, ["mcp", "servers", dep.mcp.server]);
    if (value === undefined) continue;
    const owned = state.owned.some((o) => o.file === layer.path && o.kind === "mcp" && o.path.join("/") === `mcp/servers/${dep.mcp?.server}` && o.fingerprint === fingerprint(value));
    found = { file: layer.path, owned, value };
  }
  return found;
}

function findExecutable(dep: Dependency): { path?: string; managed: boolean } {
  const managed = readState().state.tools[dep.id];
  if (managed && existsSync(managed.executable)) return { path: managed.executable, managed: true };
  // An ARIA-owned tool is only ever ARIA's own copy; another copy on PATH is not used.
  if (!dep.executable || dep.ownership === "aria") return { managed: false };
  if (dep.id === "node") return { path: process.execPath, managed: false };
  if (dep.id === "opencode") {
    const bin = opencodeBin(); // honours OPENCODE_BIN, like every runtime query
    return bin ? { path: bin, managed: false } : { managed: false };
  }
  const path = which(dep.executable, dep.searchDirs?.() ?? []);
  return path ? { path, managed: false } : { managed: false };
}

function cliDeps(): { ok: boolean; missing: string[] } {
  const req = createRequire(join(packageRoot, "package.json"));
  const missing = ["terminal-kit", "jsonc-parser"].filter((name) => {
    try {
      req.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  return { ok: missing.length === 0, missing };
}

export async function depStatus(dep: Dependency, project: string): Promise<DepStatus> {
  const base = { id: dep.id, name: dep.name, purpose: dep.purpose, kind: dep.kind, requirement: dep.requirement, ...(dep.range ? { wanted: dep.range } : {}) };
  if (dep.id === "aria-cli-deps") {
    const r = cliDeps();
    return {
      ...base, enabled: true, ownership: "aria-managed", health: r.ok ? "healthy" : "missing", basis: "runtime",
      evidence: [r.ok ? `resolved terminal-kit, jsonc-parser from ${packageRoot}` : `cannot resolve: ${r.missing.join(", ")} from ${packageRoot}`],
      actions: r.ok ? [] : ["install"],
    };
  }
  const config = mcpEntry(dep, project);
  const enabled = dep.mcp ? Boolean(config && (config.value as { disabled?: boolean })?.disabled !== true) : true;
  const exe = findExecutable(dep);
  const evidence: string[] = [];
  const actions: string[] = [];
  let version: string | undefined;
  let health: Health = "unverified";
  let basis: Check["basis"] = "none";
  if (dep.executable) {
    if (!exe.path) {
      health = dep.requirement === "required" || enabled ? "missing" : "disabled";
      evidence.push(`${dep.executable} not found on PATH${dep.searchDirs ? " or in known environment directories" : ""}`);
      if (dep.install) actions.push("install");
    } else {
      evidence.push(`executable: ${exe.path}${exe.managed ? " (installed by ARIA)" : ""}`);
      const r = await run(exe.path, dep.versionArgs ?? ["--version"], { timeoutMs: 20_000 });
      basis = "runtime";
      const parsed = parseVersion(r.stdout + " " + r.stderr);
      version = parsed?.join(".");
      if (!r.ok) {
        health = "runtime-error";
        evidence.push(`\`${dep.executable} ${(dep.versionArgs ?? []).join(" ")}\` failed: ${(r.error ?? r.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`);
      } else if (dep.range && parsed && !satisfies(parsed, dep.range)) {
        health = "incompatible";
        evidence.push(`version ${version} outside ${dep.range}`);
      } else if (dep.range && !parsed) {
        health = "unverified";
        evidence.push("version not recognised in output");
      } else {
        health = dep.mcp ? "unverified" : "healthy";
        evidence.push(`version ${version ?? "reported"}${dep.range ? ` (needs ${dep.range})` : ""}`);
        if (dep.mcp) evidence.push("executable runs; the MCP server itself is checked by `aria deps probe`");
      }
      if (exe.managed) actions.push("update");
    }
  } else if (dep.mcp) {
    health = enabled ? (dep.healthNeedsNetwork ? "unverified" : "healthy") : "disabled";
    evidence.push(dep.healthNeedsNetwork ? "remote service; reachability needs the network and is not checked offline" : "no local executable");
  }
  if (dep.mcp && !dep.mcp.config) {
    evidence.push(enabled ? `user-managed entry in ${config?.file}; ARIA does not change it` : "user-managed integration: not configured (ARIA does not install or configure it)");
    if (!enabled) health = "disabled";
  } else if (dep.mcp) {
    if (dep.provision && exe.path && !provisioned(dep.id)) {
      evidence.push(`${dep.provision.what} not downloaded yet`);
      if (enabled) health = "missing";
      actions.push("install");
    }
    if (!enabled) {
      if (health === "unverified" || health === "healthy") health = "disabled";
      actions.push("enable");
      evidence.push(`not configured as mcp.servers.${dep.mcp.server}`);
    } else {
      evidence.push(`configured in ${config?.file}${config?.owned ? " (written by ARIA)" : " (user entry; ARIA will not change it)"}`);
      if (config?.owned) actions.push("disable");
      if (dep.mcp.probe && exe.path) actions.push("probe");
    }
  }
  if (dep.ownership === "external" && dep.installHint && health === "missing") evidence.push(dep.installHint);
  if (dep.ownership === "aria" && dep.executable && !exe.managed) {
    const stray = which(dep.executable);
    evidence.push(`ARIA-managed: ARIA's own copy is not installed (aria deps install ${dep.id})${stray ? `; ${stray} on PATH is not used or changed` : ""}`);
  }
  const ownership: DepStatus["ownership"] = dep.ownership === "aria" || exe.managed ? "aria-managed" : dep.ownership === "either" ? (exe.path ? "reused" : "aria-managed") : dep.executable ? "external" : "hosted";
  return {
    ...base, enabled, ...(config ? { config } : {}), ...(exe.path ? { executable: exe.path } : {}),
    ownership, ...(dep.install && dep.install.method !== "release-deps" ? { installed: exe.managed } : {}), ...(version ? { version } : {}),
    health, basis, evidence, actions,
  };
}

export const allDeps = (project: string) => Promise.all(MANIFEST.map((d) => depStatus(d, project)));

const fail = (dryRun: boolean, error: string): OperationResult => ({ ok: false, dryRun, changes: [], messages: [], errors: [error] });

/**
 * Install (or reinstall to update) an ARIA-managed tool at its pinned version, into a new
 * directory under ARIA_HOME/tools that is marked and recorded as staging until the install has
 * been verified. Never touches an external copy. The previous ARIA-managed copy is kept (releases
 * may still reference it for rollback); `aria repair` and release pruning decide when it goes.
 */
export async function installDep(id: string, opts: { dryRun: boolean; progress?: Progress; signal?: AbortSignal }): Promise<OperationResult> {
  const interruptedGate = interruptedResult(opts.dryRun);
  if (interruptedGate) return interruptedGate;
  const dep = dependency(id);
  if (!dep) return fail(opts.dryRun, `unknown dependency ${id}`);
  if (!dep.install || dep.install.method === "release-deps") {
    return fail(opts.dryRun, dep.install?.method === "release-deps" ? "installed per release from its lockfile by `aria setup`/`aria update`; in a development checkout run `npm ci`" : `${dep.name} is user-managed: ${dep.installHint ?? "install and configure it yourself"}`);
  }
  const spec = dep.install.method === "python-venv" ? `${dep.install.package}==${dep.install.pin}` : `${dep.install.package}@${dep.install.pin}`;
  const changes: Change[] = [{ kind: "install", target: `${toolsDir()}/${id}-<new>`, summary: `install ${spec} (pinned) under ARIA_HOME/tools`, network: true }];
  if (dep.provision) changes.push({ kind: "install", target: join(toolsDir(), dep.provision.dir), summary: `download ${dep.provision.what} into ARIA_HOME/tools/${dep.provision.dir}`, network: true });
  if (opts.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages: ["Needs network access."], errors: [] };
  const progress = opts.progress ?? (() => undefined);
  const steps: Step[] = [];
  return withLock(async () => {
    let staging: { path: string } | undefined;
    try {
      staging = createStaging("tools", id, true);
      const target = staging.path;
      if (dep.install?.method === "python-venv") {
        const python = which(isWindows ? "python" : "python3") ?? which("python");
        if (!python) throw new Error("python3 not found; it is needed to create the environment");
        progress(`creating environment ${target}`);
        let r = await run(python, ["-m", "venv", target], { timeoutMs: 180_000, onLine: progress, ...(opts.signal ? { signal: opts.signal } : {}) });
        if (!r.ok) throw new Error(`venv failed: ${(r.error ?? r.stderr.trim()).slice(-300)}`);
        const py = join(target, isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");
        progress(`pip install ${spec}`);
        r = await run(py, ["-m", "pip", "install", "--disable-pip-version-check", spec], { timeoutMs: 900_000, onLine: progress, ...(opts.signal ? { signal: opts.signal } : {}) });
        if (!r.ok) throw new Error(`pip install failed: ${(r.error ?? r.stderr.trim()).slice(-300)}`);
      } else {
        const npm = which(isWindows ? "npm.cmd" : "npm") ?? "npm";
        progress(`npm install ${spec}`);
        const r = await run(npm, ["install", "--prefix", target, "--no-audit", "--no-fund", "--save-exact", spec], { timeoutMs: 900_000, onLine: progress, ...(opts.signal ? { signal: opts.signal } : {}) });
        if (!r.ok) throw new Error(`npm install failed: ${(r.error ?? r.stderr.trim()).slice(-300)}`);
      }
      steps.push({ name: `install ${spec}`, status: "done" });
      const executable = join(target, dep.install?.executable as string);
      const v = await run(executable, dep.versionArgs ?? ["--version"], { timeoutMs: 60_000 });
      if (!v.ok) throw new Error(`installed, but \`${dep.executable} ${(dep.versionArgs ?? []).join(" ")}\` failed: ${(v.error ?? v.stderr.trim()).slice(-200)}`);
      steps.push({ name: "verify executable", status: "done", detail: executable });
      // The browser must be complete BEFORE the new copy is adopted: a failed download leaves the
      // previous copy in use and removes this one (still staging), instead of repointing entries
      // to a copy that has no browser.
      if (dep.provision) {
        const p = await provisionUnlocked(id, { progress, ...(opts.signal ? { signal: opts.signal } : {}) }, target);
        steps.push(p);
        if (p.status === "failed") throw new Error(`${dep.provision.what}: ${p.detail ?? "download failed"}; the new copy was not adopted`);
      }
      removeMarker(target);
      forgetStaging(target);
      const adopted = adoptToolCopy(id, { path: target, executable, version: parseVersion(v.stdout + " " + v.stderr)?.join(".") ?? dep.install?.pin, installedAt: new Date().toISOString() });
      steps.push(...adopted.steps);
      const notes = adopted.notes;
      return { ok: notes.length === 0, dryRun: false, outcome: notes.length ? "partial" : "success", steps, changes, messages: [`installed ${dep.name} at ${executable}`, ...notes], errors: notes };
    } catch (error) {
      if (staging) {
        try {
          removeStaging(staging.path);
        } catch {
          /* left for repair, which re-checks ownership */
        }
      }
      steps.push({ name: `install ${spec}`, status: "failed", detail: (error as Error).message });
      return { ok: false, dryRun: false, outcome: "failed", steps, changes: [], messages: [], errors: [(error as Error).message] };
    }
  });
}

/**
 * Make a verified ARIA-managed copy the one in use: record it, repoint every ARIA-owned MCP entry
 * of that integration to it (an entry the user changed is left alone and reported), and record the
 * new tool set with the active release. Called by installDep after the install is verified; the
 * caller holds the lock.
 */
export function adoptToolCopy(id: string, record: ManagedTool): { steps: Step[]; notes: string[] } {
  const dep = dependency(id);
  const steps: Step[] = [];
  const notes: string[] = [];
  // 1. The copy is recorded first, so it is never left installed but unknown.
  const fresh = readState().state;
  fresh.tools[id] = record;
  recordTools(fresh, fresh.active); // the active release now runs with this copy
  writeState(fresh);
  // 2. Plan every repoint before writing any (a file with a syntax error is skipped and reported).
  const planned: { owned: (typeof fresh.owned)[number]; plan: ReturnType<typeof planEdits>; next: unknown }[] = [];
  for (const owned of fresh.owned.filter((o) => o.kind === "mcp" && o.path.join("/") === `mcp/servers/${dep?.mcp?.server}`)) {
    const read = readConfig(owned.file);
    if (read.errors.length) {
      notes.push(`${owned.file} has syntax errors; mcp.servers.${dep?.mcp?.server} there was not repointed`);
      continue;
    }
    const value = getPath(read.value, owned.path as (string | number)[]) as { command?: unknown } | undefined;
    if (value === undefined) continue;
    if (fingerprint(value) !== owned.fingerprint) {
      notes.push(`${owned.file}: mcp.servers.${dep?.mcp?.server} was changed by you; not repointed to the new copy`);
      continue;
    }
    if (!Array.isArray(value.command) || value.command[0] === record.executable) continue;
    try {
      planned.push({ owned, plan: planEdits(owned.file, [{ path: [...owned.path, "command", 0], value: record.executable }]), next: { ...value, command: [record.executable, ...value.command.slice(1)] } });
    } catch (error) {
      notes.push(`${owned.file}: ${(error as Error).message}`);
    }
  }
  // 3. Apply each, recording the new fingerprint right after its write.
  for (const p of planned) {
    applyEdit(p.plan);
    const s = readState().state;
    s.owned = s.owned.map((o) => (o.file === p.owned.file && o.path.join("/") === p.owned.path.join("/") ? { ...o, fingerprint: fingerprint(p.next) } : o));
    writeState(s);
    steps.push({ name: "repoint MCP entry", status: "done", detail: `${p.owned.file}: mcp.servers.${dep?.mcp?.server} -> ${record.executable}` });
  }
  return { steps, notes };
}

/** Download extra runtime pieces (Playwright's Chromium) into ARIA_HOME/tools. */
export async function provisionDep(id: string, opts: { progress?: Progress; signal?: AbortSignal }): Promise<Step> {
  // A download into ARIA_HOME/tools is a mutation: same lock and interrupted-operation gate as the rest.
  return withLock(() => provisionUnlocked(id, opts));
}

async function provisionUnlocked(id: string, opts: { progress?: Progress; signal?: AbortSignal }, copyPath?: string): Promise<Step> {
  const dep = dependency(id);
  if (!dep?.provision) return { name: "provision", status: "skipped" };
  const toolPath = copyPath ?? readState().state.tools[id]?.path;
  if (!toolPath) return { name: `provision ${dep.provision.what}`, status: "failed", detail: "provisioning needs the ARIA-managed install (aria deps install)" };
  const dir = join(toolsDir(), dep.provision.dir);
  const installed = () => browserInstalled(toolPath, dir).ok;
  if (installed()) return { name: `provision ${dep.provision.what}`, status: "skipped", detail: "already present" };
  const playwright = join(toolPath, "node_modules", ".bin", isWindows ? "playwright.cmd" : "playwright");
  if (!existsSync(playwright)) return { name: `provision ${dep.provision.what}`, status: "failed", detail: `${playwright} missing` };
  const r = await run(playwright, [...dep.provision.args], { timeoutMs: 1_200_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir }, onLine: opts.progress ?? (() => undefined), ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!r.ok) return { name: `provision ${dep.provision.what}`, status: "failed", detail: (r.error ?? r.stderr.trim()).slice(-300) };
  return installed() ? { name: `provision ${dep.provision.what}`, status: "done", detail: dir } : { name: `provision ${dep.provision.what}`, status: "failed", detail: `nothing installed in ${dir}` };
}

/**
 * Is the extra runtime piece completely installed for the ARIA-managed copy? (Playwright: the
 * chromium revision its playwright-core pins, with Playwright's INSTALLATION_COMPLETE marker.)
 * A complete install is never downloaded again.
 */
export function provisioned(id: string): boolean {
  const dep = dependency(id);
  if (!dep?.provision) return true;
  const tool = readState().state.tools[id];
  if (!tool) return false;
  return browserInstalled(tool.path, join(toolsDir(), dep.provision.dir)).ok;
}

/** Write (or repoint) the ARIA-owned `mcp.servers.<name>` entry for an integration. */
export async function enableDep(id: string, opts: { scope: Scope; project: string; dryRun: boolean; replace?: boolean }): Promise<OperationResult> {
  const interruptedGate = interruptedResult(opts.dryRun);
  if (interruptedGate) return interruptedGate;
  const dep = dependency(id);
  if (!dep?.mcp) return fail(opts.dryRun, `${id} is not an MCP integration`);
  if (!dep.mcp.config) return fail(opts.dryRun, `${dep.name} is user-managed: add mcp.servers.${dep.mcp.server} to your OpenCode config yourself; ARIA only detects it`);
  const exe = findExecutable(dep).path;
  const file = configFile(opts.scope, opts.project);
  const path = ["mcp", "servers", dep.mcp.server];
  const existing = getPath(readConfig(file).value, path);
  const { state } = readState();
  const owned = existing !== undefined && state.owned.some((o) => o.file === file && o.path.join("/") === path.join("/") && o.fingerprint === fingerprint(existing));
  if (existing !== undefined && !owned && !opts.replace) {
    return { ok: false, dryRun: opts.dryRun, changes: [], messages: [`existing value: ${JSON.stringify(existing)}`], errors: [], blocked: `${file} already has a user entry mcp.servers.${dep.mcp.server}; ARIA leaves it alone (use --replace to take it over)` };
  }
  if (dep.executable && !exe) return fail(opts.dryRun, `${dep.name}: ${dep.executable} not found. ${dep.install ? `Install it first: aria deps install ${id}` : dep.installHint ?? ""}`);
  const desired = dep.mcp.config(exe);
  if (dep.provision && !provisioned(id)) return fail(opts.dryRun, `${dep.provision.what} is not installed yet; run \`aria deps install ${id}\` (or setup --with ${id}) first`);
  if (existing !== undefined && !owned && JSON.stringify(existing) !== JSON.stringify(desired) && !opts.replace) {
    return {
      ok: false, dryRun: opts.dryRun, changes: [], messages: [`existing value: ${JSON.stringify(existing)}`, `ARIA would write: ${JSON.stringify(desired)}`],
      errors: [], blocked: `${file} already has a user entry mcp.servers.${dep.mcp.server}; ARIA leaves it alone (use --replace to take it over)`,
    };
  }
  let plan;
  try {
    plan = planEdits(file, [{ path, value: desired }]);
  } catch (error) {
    return fail(opts.dryRun, (error as Error).message);
  }
  const changes = plan.changed ? [{ kind: "config" as const, target: file, summary: plan.summary.join("; ") }] : [];
  const messages = [plan.changed ? `${file}: ${plan.summary.join("; ")}` : `mcp.servers.${dep.mcp.server} already configured as ARIA would`, "OpenCode picks up MCP changes for new sessions."];
  if (opts.dryRun || !plan.changed) {
    if (!opts.dryRun && !plan.changed && existing !== undefined && !owned && opts.replace) await recordOwned(file, path, desired);
    return { ok: true, dryRun: opts.dryRun, changes, messages, errors: [] };
  }
  await withLock(async () => {
    applyEdit(plan);
    await recordOwnedUnlocked(file, path, desired);
  });
  return { ok: true, dryRun: false, changes, messages, errors: [] };
}

async function recordOwnedUnlocked(file: string, path: (string | number)[], value: unknown) {
  const { state } = readState();
  state.owned = state.owned.filter((o) => !(o.file === file && o.path.join("/") === path.join("/")));
  state.owned.push({ file, path, kind: path[0] === "plugins" ? "plugin" : "mcp", fingerprint: fingerprint(value) });
  writeState(state);
}
const recordOwned = (file: string, path: (string | number)[], value: unknown) => withLock(() => recordOwnedUnlocked(file, path, value));

/** Remove an MCP entry, only if ARIA wrote it and nobody changed it since. */
export async function disableDep(id: string, opts: { project: string; dryRun: boolean }): Promise<OperationResult> {
  const interruptedGate = interruptedResult(opts.dryRun);
  if (interruptedGate) return interruptedGate;
  const dep = dependency(id);
  if (!dep?.mcp) return fail(opts.dryRun, `${id} is not an MCP integration`);
  const status = await depStatus(dep, opts.project);
  if (!status.config) return { ok: true, dryRun: opts.dryRun, changes: [], messages: [`${dep.name} is not configured`], errors: [] };
  if (!status.config.owned) return { ok: false, dryRun: opts.dryRun, changes: [], messages: [], errors: [], blocked: `${status.config.file} has a user-written mcp.servers.${dep.mcp.server}; ARIA does not remove it` };
  const path = ["mcp", "servers", dep.mcp.server];
  const plan = planEdits(status.config.file, [{ path, value: undefined }]);
  const changes = [{ kind: "config" as const, target: status.config.file, summary: plan.summary.join("; ") }];
  if (opts.dryRun) return { ok: true, dryRun: true, changes, messages: ["The installed executable is kept."], errors: [] };
  await withLock(async () => {
    applyEdit(plan);
    const { state } = readState();
    state.owned = state.owned.filter((o) => !(o.file === status.config?.file && o.path.join("/") === path.join("/")));
    writeState(state);
  });
  return { ok: true, dryRun: false, changes, messages: ["Removed. The installed executable is kept."], errors: [] };
}

export interface InventoryReport {
  readonly ok: boolean;
  readonly server?: { name?: string; version?: string };
  readonly tools: readonly string[];
  readonly classifiedRead: readonly string[];
  readonly classifiedMutating: readonly string[];
  /** Exposed by the server, unknown to ARIA's rules: hidden from the researcher until classified. */
  readonly unclassified: readonly string[];
  readonly ready?: { readonly ok: boolean; readonly detail: string };
  /** Named in ARIA's rules but not exposed (renamed or disabled toolset). */
  readonly absent: readonly string[];
  readonly error?: string;
}

/** The command a local server runs with: the actual config entry when there is one, else what ARIA would write. */
function localCommand(dep: Dependency, exe: string | undefined, project?: string): { command: string[]; environment: Record<string, string> } | undefined {
  const entry = project ? (mcpEntry(dep, project)?.value as { type?: string; command?: unknown; environment?: Record<string, string> } | undefined) : undefined;
  if (entry && entry.type !== "remote" && Array.isArray(entry.command) && entry.command.every((c) => typeof c === "string")) return { command: entry.command as string[], environment: entry.environment ?? {} };
  if (!dep.mcp?.config || !exe) return undefined;
  const c = dep.mcp.config(exe) as { command: string[]; environment?: Record<string, string> };
  return { command: c.command, environment: c.environment ?? {} };
}

/** Start a local MCP server briefly and compare its real tool list with ARIA's rules. Calls no tools. */
export async function probeDep(id: string, ready = false, project?: string): Promise<InventoryReport> {
  const dep = dependency(id);
  const exe = dep ? findExecutable(dep).path : undefined;
  const cmd = dep ? localCommand(dep, exe, project) : undefined;
  if (!dep?.mcp?.probe || !cmd) return { ok: false, tools: [], classifiedRead: [], classifiedMutating: [], unclassified: [], absent: [], error: !dep?.mcp?.probe ? "no local server to probe" : "executable not found" };
  const [command, ...args] = cmd.command;
  const r = await probeTools(command as string, args, cmd.environment, 60_000, ready && dep.mcp.readyCall ? { tool: dep.mcp.readyCall.tool, args: dep.mcp.readyCall.args } : undefined);
  const known = id === "zotero-mcp" ? { read: ZOTERO_READ, mutate: ZOTERO_MUTATE } : { read: [] as readonly string[], mutate: [] as readonly string[] };
  const tools = [...r.tools].sort();
  return {
    ok: r.ok,
    ...(r.server ? { server: r.server } : {}),
    tools,
    classifiedRead: tools.filter((t) => known.read.includes(t)),
    classifiedMutating: tools.filter((t) => known.mutate.includes(t)),
    unclassified: tools.filter((t) => !known.read.includes(t) && !known.mutate.includes(t)),
    absent: r.ok ? [...known.read, ...known.mutate].filter((t) => !tools.includes(t)) : [],
    ...(r.error ? { error: r.error } : {}),
    ...(r.call ? { ready: r.call } : {}),
  };
}

/** OpenCode substitutes `{env:NAME}` in config values; do the same for the probe's headers. */
function expandEnv(value: string): { value: string; unresolved?: string } {
  let unresolved: string | undefined;
  const out = value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) unresolved = name;
    return v ?? "";
  });
  return { value: out, ...(unresolved ? { unresolved } : {}) };
}

export interface Readiness {
  readonly id: string;
  readonly name: string;
  readonly ownership: string;
  /**
   * ready: the server works, including its read-only readiness call where it has one;
   * initialized: a remote server completed MCP initialize (its backend is not exercised);
   * not-ready: something failed (see steps); disabled: not configured; not-applicable: not MCP.
   */
  readonly state: "ready" | "initialized" | "not-ready" | "disabled" | "not-applicable";
  readonly ok: boolean;
  readonly class?: RemoteClass;
  readonly steps: readonly Step[];
  readonly detail: string;
}

/**
 * Operational readiness of an integration, the one implementation behind `aria deps check`,
 * `aria doctor --runtime`, `setup --with` and the management TUI. Local servers must start and
 * list tools (and answer the manifest's read-only readiness call); Playwright must also have a
 * complete, launchable browser; remote servers must complete a validated MCP initialize. Never
 * calls a mutating tool.
 */
export async function readiness(id: string, project: string, opts: { requireEnabled?: boolean } = {}): Promise<Readiness> {
  const dep = dependency(id);
  const tool = readState().state.tools[id];
  const base = { id, name: dep?.name ?? id, ownership: dep?.ownership === "aria" || tool ? "aria-managed" : dep?.ownership === "either" ? "reused" : dep?.executable ? "external" : "hosted" };
  if (!dep?.mcp) return { ...base, state: "not-applicable", ok: true, steps: [], detail: "not an MCP integration" };
  const entry = mcpEntry(dep, project);
  const enabled = Boolean(entry && (entry.value as { disabled?: boolean })?.disabled !== true);
  if (!enabled && opts.requireEnabled !== false) return { ...base, state: "disabled", ok: true, steps: [], detail: `not configured as mcp.servers.${dep.mcp.server}` };
  const steps: Step[] = [];
  if (dep.mcp.remoteUrl) {
    const value = (entry?.value ?? dep.mcp.config?.(undefined) ?? {}) as { url?: unknown; headers?: Record<string, unknown> };
    const rawUrl = typeof value.url === "string" ? value.url : dep.mcp.remoteUrl;
    const u = expandEnv(rawUrl);
    const url = u.value;
    if (u.unresolved) steps.push({ name: "url", status: "failed", detail: `{env:${u.unresolved}} is not set in this environment` });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.headers ?? {})) {
      if (typeof v !== "string") continue;
      const e = expandEnv(v);
      if (e.unresolved) steps.push({ name: `header ${k}`, status: "failed", detail: `{env:${e.unresolved}} is not set in this environment` });
      if (/\{file:/.test(v)) steps.push({ name: `header ${k}`, status: "failed", detail: "{file:...} substitution is not evaluated by ARIA's check" });
      headers[k] = e.value;
    }
    if (steps.some((st) => st.status === "failed")) {
      // OpenCode would send these values unexpanded or empty; checking without them proves nothing.
      return { ...base, state: "not-ready", ok: false, steps, detail: steps.filter((st) => st.status === "failed").map((st) => `${st.name}: ${st.detail}`).join("; ") };
    }
    const r = await probeRemote(url, { headers });
    steps.push({ name: `MCP initialize ${url}`, status: r.ok ? "done" : "failed", detail: r.detail });
    if (!r.ok) return { ...base, state: "not-ready", ok: false, class: r.class, steps, detail: r.detail };
    return { ...base, state: "initialized", ok: true, class: r.class, steps, detail: `${r.detail}; operational readiness of the hosted service is not verified` };
  }
  if (!dep.mcp.probe) return { ...base, state: "not-ready", ok: false, steps, detail: "no readiness check is defined" };
  if (dep.provision) {
    const tool = readState().state.tools[id];
    if (!tool) {
      steps.push({ name: "ARIA-managed copy", status: "failed", detail: `not installed by ARIA (aria deps install ${id})` });
      return { ...base, state: "not-ready", ok: false, steps, detail: "the ARIA-managed copy is not installed" };
    }
    const runs = localCommand(dep, tool.executable, project)?.command[0];
    if (runs && !runs.startsWith(tool.path)) {
      steps.push({ name: "ARIA-managed copy", status: "failed", detail: `the config entry runs ${runs}, not ARIA's managed copy ${tool.executable}; its browser cannot be checked` });
      return { ...base, state: "not-ready", ok: false, steps, detail: `config runs ${runs}, not the ARIA-managed copy` };
    }
    const b = await checkBrowser(tool.path, join(toolsDir(), dep.provision.dir), { launch: true });
    steps.push(...b.steps);
    if (!b.ok) return { ...base, state: "not-ready", ok: false, steps, detail: (b.steps.at(-1)?.detail ?? "browser not ready").slice(0, 300) };
  }
  const p = await probeDep(id, true, project);
  if (!p.ok) {
    steps.push({ name: "server starts and lists tools", status: "failed", detail: p.error ?? "no answer" });
    return { ...base, state: "not-ready", ok: false, steps, detail: p.error ?? "server did not answer" };
  }
  const unclassified = p.unclassified.length && id === "zotero-mcp" ? `; ${p.unclassified.length} unclassified tool(s) stay hidden from the researcher: ${p.unclassified.join(", ")}` : "";
  steps.push({ name: "server starts and lists tools", status: "done", detail: `${p.server?.name ?? "server"} ${p.server?.version ?? ""}: ${p.tools.length} tools${unclassified}` });
  if (dep.mcp.readyCall) {
    if (!p.ready?.ok) {
      steps.push({ name: `read-only call ${dep.mcp.readyCall.tool}`, status: "failed", detail: `${p.ready?.detail ?? "no answer"} (needs ${dep.mcp.readyCall.needs})` });
      return { ...base, state: "not-ready", ok: false, steps, detail: `${dep.mcp.readyCall.tool}: ${p.ready?.detail ?? "no answer"} (needs ${dep.mcp.readyCall.needs})` };
    }
    steps.push({ name: `read-only call ${dep.mcp.readyCall.tool}`, status: "done", detail: p.ready.detail.slice(0, 120) });
  }
  return { ...base, state: "ready", ok: true, steps, detail: steps.filter((st) => st.status === "done").map((st) => st.name).join(", ") };
}

/**
 * Everything `setup --with <id>` promises: reuse a compatible existing executable or install the
 * pinned ARIA-managed one, provision extra pieces, write the config entry, and check readiness.
 * Reports per-step status; the caller decides between success and partial.
 */
export async function ensureIntegration(id: string, opts: { scope: Scope; project: string; dryRun: boolean; replace?: boolean; progress?: Progress; signal?: AbortSignal }): Promise<OperationResult> {
  const interruptedGate = interruptedResult(opts.dryRun);
  if (interruptedGate) return interruptedGate;
  const dep = dependency(id);
  if (!dep?.mcp) return fail(opts.dryRun, `${id} is not an optional integration (choose from: ${MANIFEST.filter((d) => d.mcp?.config).map((d) => d.id).join(", ")})`);
  if (!dep.mcp.config) return fail(opts.dryRun, `${dep.name} is user-managed; configure it yourself`);
  const steps: Step[] = [];
  const changes: Change[] = [];
  const messages: string[] = [];
  const status = await depStatus(dep, opts.project);
  // Browsers must match the Playwright build that drives them, so an integration that needs
  // provisioning always uses ARIA's pinned copy (an external copy is left alone, not reused).
  const provisionNeedsManaged = Boolean(dep.provision) && status.ownership !== "aria-managed";
  const needsInstall = Boolean(dep.executable) && (!status.executable || status.health === "incompatible" || status.health === "runtime-error" || provisionNeedsManaged);
  if (opts.dryRun) {
    if (needsInstall) changes.push(...(await installDep(id, { dryRun: true })).changes);
    else if (dep.provision && !provisioned(id)) changes.push({ kind: "install", target: join(toolsDir(), dep.provision.dir), summary: `download ${dep.provision.what}`, network: true });
    else if (status.executable) messages.push(`${dep.name}: reusing ${status.executable} (${status.ownership})`);
    if (provisionNeedsManaged && status.executable) messages.push(`${dep.name}: ${status.executable} is not ARIA-managed; installing the pinned copy so the browser download matches it (the external copy is not changed)`);
    const en = await enableDep(id, { ...opts, dryRun: true });
    changes.push(...en.changes);
    messages.push(...en.messages, ...en.errors.filter((e) => !/not found|not installed yet/.test(e)));
    if (en.blocked) return { ...en, outcome: "blocked", changes, messages };
    messages.push(`Then: readiness check (${dep.mcp.remoteUrl ? "network" : dep.mcp.readyCall ? `needs ${dep.mcp.readyCall.needs}` : "server start"}).`);
    return { ok: true, dryRun: true, outcome: "preview", changes, messages, errors: [] };
  }
  if (needsInstall) {
    const r = await installDep(id, { dryRun: false, ...(opts.progress ? { progress: opts.progress } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    steps.push(...(r.steps ?? []));
    changes.push(...r.changes);
    // `partial`: the copy is installed and adopted, but something (e.g. a user-changed entry) was skipped.
    if (!r.ok) return { ok: false, dryRun: false, outcome: r.outcome === "partial" ? "partial" : "failed", steps, changes, messages: [...messages, ...r.messages], errors: r.errors };
  } else if (status.executable) steps.push({ name: "reuse existing executable", status: "done", detail: `${status.executable} (${status.ownership})` });
  if (dep.provision) {
    const p = await provisionDep(id, { ...(opts.progress ? { progress: opts.progress } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    steps.push(p);
    if (p.status === "failed") return { ok: false, dryRun: false, outcome: "failed", steps, changes, messages, errors: [p.detail ?? "provisioning failed"] };
  }
  const en = await enableDep(id, { ...opts, dryRun: false });
  changes.push(...en.changes);
  if (en.blocked) return { ok: false, dryRun: false, outcome: "blocked", steps, changes, messages: en.messages, errors: [], blocked: en.blocked };
  if (!en.ok) return { ok: false, dryRun: false, outcome: "failed", steps: [...steps, { name: "configure", status: "failed", detail: en.errors.join("; ") }], changes, messages, errors: en.errors };
  steps.push({ name: "configure", status: "done", detail: en.changes.length ? en.changes.map((c) => c.summary).join("; ") : "already configured" });
  const ready = await readiness(id, opts.project);
  steps.push(...ready.steps.map((st) => ({ ...st, name: `readiness: ${st.name}` })));
  if (!ready.ok) return { ok: false, dryRun: false, outcome: "partial", steps, changes, messages: [...messages, `${dep.name} is installed and configured but not ready: ${ready.detail}`], errors: [`${id}: not ready (${ready.detail})`] };
  if (ready.state === "initialized") messages.push(ready.detail);
  return { ok: true, dryRun: false, outcome: "success", steps, changes, messages, errors: [] };
}
