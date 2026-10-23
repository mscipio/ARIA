import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getPackageRoot } from "./defaults.js";
import { ROLES } from "./overrides.js";
import { openCodeGlobalDir } from "./paths.js";
import { getPermissionsForRole } from "./permissions.js";
import type { AgentRule } from "./permissions.js";
import type { ResolvedAriaConfig, ResolvedRoleConfig, RoleName } from "./types.js";

export { ROLES };
export type { AgentRule };

/**
 * T003 — ARIA-managed V2 agent installation.
 *
 * Canonical source remains `defaults/aria.defaults.json` plus the
 * prompt/override machinery (`resolveAriaConfig`): this module only renders
 * an already-resolved config into deterministic managed agent files. It never
 * invents models, modes, prompts, or variants.
 *
 * Creation mechanism is managed Markdown files, one per role:
 *   `<agents-dir>/<role>.md`  (global default: `~/.config/opencode/agents/`)
 * Frontmatter accepts the same fields as an `agents.<id>` configuration
 * entry and the Markdown body becomes the agent's `system` prompt
 * (opencode.ai/v2/docs/agents). No project copies are written here: project
 * model overlays are T005 runtime work, not files.
 *
 * The `AgentEditor` (`ctx.agent.transform`) has no public `add()`, and
 * `agent.update()` must not be relied on to materialize missing agents, so
 * files are the preferred creation mechanism; any runtime transform stays
 * narrow post-load work for T004/T005 and lives outside this module.
 *
 * T004 — permissions are real parity `Rule[]` from the canonical
 * `src/permissions.ts` source (`getPermissionsForRole`), ordered
 * last-match-wins with V2 `shell`/`subagent` names and no legacy
 * `bash`/`task`/`plan`/`todowrite` actions. Every security-relevant field
 * stays explicit so nothing inherits builtins by accident.
 *
 * T004 workspace policy: generated bodies inherit the workspace execution
 * policy from the resolved prompts (canonical `src/scratch.ts` via
 * `src/paths.ts`); this module adds no path checks and duplicates no guards.
 */

/** V1 descriptions preserved verbatim as V2 `description` frontmatter. */
const AGENT_DESCRIPTIONS: Record<RoleName, string> = {
  coder: "Coordinates planning, implementation, and review.",
  explorer: "explorer coding specialist for ARIA Review-Driven Coding.",
  visualizer: "Qt UI/UX Engineer for ARIA Review-Driven Coding: UX/interaction and Qt visual design, approved-scope PySide6 implementation, and capture→inspect→refine→verify visual validation.",
  planner: "planner coding specialist for ARIA Review-Driven Coding.",
  architect: "architect coding specialist for ARIA Review-Driven Coding.",
  implementer: "implementer coding specialist for ARIA Review-Driven Coding.",
  reviewer: "reviewer coding specialist for ARIA Review-Driven Coding.",
  researcher: "Direct or delegated specialist for external literature and evidence research.",
  archivist: "Direct or delegated specialist for curated Wiki lookup and maintenance.",
  writer: "Primary scientific, academic, and professional writing agent.",
  scientist:
    "Scientific authority for question specification and result interpretation; delegates evidence to researcher, prose to writer, and computation to coder.",
};

/** V2 model selector: `provider/model` with an optional `#variant`. */
export function formatAgentModel(model: string, variant: string | undefined): string {
  return variant ? `${model}#${variant}` : model;
}

const MANAGED_MARKER = "# ARIA-managed agent definition";
const VERSION_PREFIX = "# aria-version:";
const CHECKSUM_PREFIX = "# aria-checksum:";

function yamlString(value: string): string {
  // JSON strings are valid YAML double-quoted scalars; deterministic quoting
  // keeps model/description rendering byte-stable regardless of `/`, `#`, `:`.
  return JSON.stringify(value);
}

/** Canonical payload the ownership checksum covers (never the checksum itself). */
function checksumPayload(
  description: string,
  model: string,
  mode: string,
  permissions: readonly AgentRule[],
  body: string,
): string {
  return [description, model, mode, JSON.stringify(permissions), body].join("\n");
}

function routeIndependentChecksum(
  description: string,
  mode: string,
  permissions: readonly AgentRule[],
  body: string,
): string {
  return createHash("sha256")
    .update([description, mode, JSON.stringify(permissions), body].join("\n"), "utf8")
    .digest("hex");
}

export function agentFileChecksum(
  description: string,
  model: string,
  mode: string,
  permissions: readonly AgentRule[],
  body: string,
): string {
  return createHash("sha256").update(checksumPayload(description, model, mode, permissions, body), "utf8").digest("hex");
}

/**
 * Render one deterministic managed agent file. The body is the resolved
 * system prompt verbatim (exactly one trailing newline); frontmatter carries
 * only agent fields independent of model routing plus ARIA ownership comments.
 * Models are applied at runtime and are deliberately not baked into these
 * globally managed files.
 */
export function generateAgentFile(role: RoleName, resolved: ResolvedRoleConfig, version: string): string {
  const description = AGENT_DESCRIPTIONS[role];
  const body = resolved.promptText.endsWith("\n") ? resolved.promptText : `${resolved.promptText}\n`;
  const permissions = getPermissionsForRole(role);
  const checksum = routeIndependentChecksum(description, resolved.mode, permissions, body);
  return renderManagedAgentFile({ description, mode: resolved.mode, permissions, body, version, checksum });
}

function renderManagedAgentFile(input: {
  description: string;
  mode: string;
  permissions: readonly AgentRule[];
  body: string;
  version: string;
  checksum: string;
  model?: string;
}): string {
  const lines = [
    "---",
    MANAGED_MARKER + " — DO NOT EDIT.",
    "# Regenerated deterministically by ARIA setup from defaults/aria.defaults.json + prompt/override machinery.",
    `# aria-version: ${input.version}`,
    `# aria-checksum: ${input.checksum}`,
    `description: ${yamlString(input.description)}`,
    ...(input.model === undefined ? [] : [`model: ${yamlString(input.model)}`]),
    `mode: ${input.mode}`,
    "permissions:",
    ...input.permissions.map(
      (rule) => `  - action: ${yamlString(rule.action)}\n    resource: ${yamlString(rule.resource)}\n    effect: ${rule.effect}`,
    ),
    "---",
    "",
    "",
  ];
  return `${lines.join("\n")}${input.body}`;
}

/** Render all eleven managed agent files in canonical role order. */
export function generateAgentFiles(resolved: ResolvedAriaConfig, version: string): Record<RoleName, string> {
  return Object.fromEntries(
    ROLES.map((role) => [role, generateAgentFile(role, resolved.roles[role], version)]),
  ) as Record<RoleName, string>;
}

export function agentFileName(role: RoleName): string {
  return `${role}.md`;
}

/** Global V2 agent location (`$XDG_CONFIG_HOME/opencode/agents/` or `~/.config/opencode/agents/`). */
export function defaultAgentsDir(explicit?: string): string {
  return join(openCodeGlobalDir(explicit), "agents");
}

export function readPackageVersion(metaUrl: string = import.meta.url): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(getPackageRoot(metaUrl), "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json is missing a version string");
  }
  return packageJson.version;
}

export interface ManagedHeader {
  version: string;
  checksum: string;
}

/** Ownership probe: a file we generated carries the managed marker + version + checksum. */
export function parseManagedHeader(content: string): ManagedHeader | null {
  if (!content.includes(MANAGED_MARKER)) return null;
  const versionLine = content.split("\n").find((line) => line.startsWith(VERSION_PREFIX));
  const checksumLine = content.split("\n").find((line) => line.startsWith(CHECKSUM_PREFIX));
  if (!versionLine || !checksumLine) return null;
  const version = versionLine.slice(VERSION_PREFIX.length).trim();
  const checksum = checksumLine.slice(CHECKSUM_PREFIX.length).trim();
  if (!version || !/^[0-9a-f]{64}$/.test(checksum)) return null;
  return { version, checksum };
}

export function isAriaManaged(content: string): boolean {
  return parseManagedHeader(content) !== null;
}

export interface AgentInstallResult {
  dir: string;
  version: string;
  /** Roles whose file was created or regenerated. */
  written: RoleName[];
  /** Roles whose managed file was already byte-identical (no write). */
  unchanged: RoleName[];
  /** Roles whose managed file was hand-edited after generation (still regenerated). */
  tampered: RoleName[];
  /** Unmanaged pre-existing files moved aside before generation, by role. */
  backups: Partial<Record<RoleName, string>>;
  /**
   * Prior managed contents replaced by this install, by role.
   *
   * Present only when a managed file already existed with different bytes
   * (version upgrade or tampered regeneration). Absence means the file was
   * newly created. Rollback restores these bytes verbatim; it never deletes
   * a replaced managed file.
   */
  previousContents: Partial<Record<RoleName, string>>;
}

/**
 * Partial install state carried on a thrown `installAgentFiles` error so
 * callers (T008 lifecycle) can roll back accumulated agent changes. The
 * install itself already attempts a best-effort rollback before throwing;
 * the partial is exposed for a defensive second pass.
 */
export interface AgentInstallPartialError extends Error {
  partialResult?: AgentInstallResult;
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Recompute the embedded checksum from a managed file's own fields. */
function verifyManagedContent(content: string): boolean {
  const header = parseManagedHeader(content);
  if (!header) return false;
  const lines = content.split("\n");
  if (lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  if (closing < 0 || lines[closing + 1] !== "") return false;
  const frontmatter = lines.slice(1, closing);
  const body = lines.slice(closing + 2).join("\n");
  const valueLine = (prefix: string): string | undefined => frontmatter.find((line) => line.startsWith(prefix));
  const descriptionLine = valueLine("description: ");
  const modelLine = valueLine("model: ");
  const modeLine = valueLine("mode: ");
  if (!descriptionLine || !modeLine) return false;
  let description: string;
  let model: string | undefined;
  try {
    description = JSON.parse(descriptionLine.slice("description: ".length)) as string;
    if (modelLine) model = JSON.parse(modelLine.slice("model: ".length)) as string;
  } catch {
    return false;
  }
  if (typeof description !== "string" || (modelLine && typeof model !== "string")) return false;
  const mode = modeLine.slice("mode: ".length).trim();
  const permissions = parsePermissionsFromContent(content);
  if (!permissions) return false;
  const checksum = model !== undefined
    ? agentFileChecksum(description, model, mode, permissions, body)
    : routeIndependentChecksum(description, mode, permissions, body);
  if (checksum !== header.checksum) return false;
  // Re-rendering the parsed fields recognizes only the exact generated layouts;
  // unchecksummed frontmatter or ownership metadata is never migrated.
  return renderManagedAgentFile({
    description,
    ...(model === undefined ? {} : { model }),
    mode,
    permissions,
    body,
    version: header.version,
    checksum: header.checksum,
  }) === content;
}

/** Parse the frontmatter `permissions:` Rule[] from generated bytes. */
function parsePermissionsFromContent(content: string): AgentRule[] | null {
  const lines = content.split("\n");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return null;
  const frontmatter = lines.slice(1, closing);
  const permissions: AgentRule[] = [];
  for (let index = 0; index < frontmatter.length; index += 1) {
    const actionMatch = frontmatter[index]?.match(/^\s*-\s*action:\s*(.*)$/);
    if (!actionMatch) continue;
    const resourceLine = frontmatter[index + 1];
    const effectLine = frontmatter[index + 2];
    if (!resourceLine?.includes("resource:") || !effectLine?.includes("effect:")) return null;
    try {
      const action = JSON.parse(actionMatch[1]!.trim()) as unknown;
      const resource = JSON.parse(resourceLine.split("resource:")[1]!.trim()) as unknown;
      const effect = effectLine.split("effect:")[1]!.trim();
      if (typeof action !== "string" || typeof resource !== "string") return null;
      if (effect !== "allow" && effect !== "deny" && effect !== "ask") return null;
      permissions.push({ action, resource, effect });
    } catch {
      return null;
    }
  }
  return permissions;
}

/** Atomic write: temp file in the same directory, then rename into place. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Install (or regenerate) the eleven managed agent files.
 *
 * Safe regeneration: byte-identical managed files are left untouched;
 * managed files are regenerated in place with their prior bytes retained on
 * the result for rollback; pre-existing files WITHOUT the ownership marker
 * are never overwritten — they are moved to
 * `<role>.md.aria-backup-<stamp>` first so user agents survive with a
 * rollback path. Files with unrelated names are never touched.
 *
 * Atomicity (T008): a mid-install throw rolls back accumulated changes
 * before throwing (including a backup-moved-before-failed-replacement for
 * the current role) and exposes the partial result on the thrown error as
 * `partialResult` for a defensive caller rollback.
 */
export async function installAgentFiles(
  resolved: ResolvedAriaConfig,
  options: { dir?: string; version?: string } = {},
): Promise<AgentInstallResult> {
  const dir = options.dir ?? defaultAgentsDir();
  const version = options.version ?? readPackageVersion();
  const files = generateAgentFiles(resolved, version);
  await mkdir(dir, { recursive: true });

  const result: AgentInstallResult = {
    dir,
    version,
    written: [],
    unchanged: [],
    tampered: [],
    backups: {},
    previousContents: {},
  };
  try {
    for (const role of ROLES) {
      const path = join(dir, agentFileName(role));
      const wanted = files[role];
      const existing = await readExisting(path);
      if (existing === undefined) {
        await writeFileAtomic(path, wanted);
        result.written.push(role);
        continue;
      }
      if (existing === wanted) {
        result.unchanged.push(role);
        continue;
      }
      if (!isAriaManaged(existing)) {
        const backupPath = `${path}.aria-backup-${backupStamp()}`;
        await rename(path, backupPath);
        // T008 transient-rollback: record the rollback obligation
        // immediately after the move, before any replacement/write can
        // fail, so a post-move failure with a failed immediate restore
        // still leaves a retryable entry for the accumulated rollback.
        result.backups[role] = backupPath;
        result.written.push(role);
        try {
          await writeFileAtomic(path, wanted);
        } catch (error) {
          // Backup-moved-before-failed-replacement: the live path is
          // missing after the rename above, so restore it before the
          // accumulated rollback below.
          await rename(backupPath, path).catch(() => undefined);
          throw error;
        }
        continue;
      }
      if (!verifyManagedContent(existing)) result.tampered.push(role);
      result.previousContents[role] = existing;
      await writeFileAtomic(path, wanted);
      result.written.push(role);
    }
  } catch (error) {
    await rollbackAgentInstall(dir, result).catch(() => undefined);
    (error as AgentInstallPartialError).partialResult = result;
    throw error;
  }
  return result;
}

/**
 * Roll back one `installAgentFiles` result: restore every backup, restore
 * replaced managed contents byte-for-byte, and remove only files that were
 * newly created by that install. Unchanged files are ignored.
 *
 * Retry-safe (T008 transient-rollback): already-restored roles whose backup
 * was consumed (missing backup, live present) are treated as resolved so a
 * defensive second pass is not blocked by consumed entries. Roles with an
 * existing backup are still attempted. Unresolved failures (missing backup
 * with missing live, failed renames/rewrites) are collected across all roles
 * and rethrown at the end — fail-closed, never silently discarded.
 */
export async function rollbackAgentInstall(dir: string, result: AgentInstallResult): Promise<void> {
  let pending: unknown;
  let hasPending = false;
  for (const role of result.written) {
    const path = join(dir, agentFileName(role));
    const backupPath = result.backups[role];
    if (backupPath) {
      try {
        await rename(backupPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          try {
            const live = await readExisting(path);
            if (live !== undefined) continue;
          } catch {
            // Live probe failed: fall through to fail-closed below.
          }
        }
        hasPending = true;
        pending = error;
      }
      continue;
    }
    const previous = result.previousContents?.[role];
    if (previous !== undefined) {
      try {
        await writeFileAtomic(path, previous);
      } catch (error) {
        hasPending = true;
        pending = error;
      }
    } else {
      await unlink(path).catch(() => undefined);
    }
  }
  if (hasPending) throw pending;
}

/**
 * Strict managed-agent reconciliation (post-handoff): positive classification
 * of the eleven expected role paths with fail-closed conflicts.
 *
 * Classification reuses the generated definitions plus the managed
 * header/version/checksum metadata above:
 * - missing expected file → created;
 * - byte-identical to the generated bytes → unchanged (never rewritten, so
 *   mtime is preserved);
 * - ARIA-managed but different bytes (older version, or the marker intact
 *   with edited content failing `verifyManagedContent`) → regenerated in
 *   place with prior bytes retained on the result for `rollbackAgentInstall`;
 * - pre-existing file WITHOUT the ownership marker → `unowned` conflict;
 * - role path that is not a regular file (directory, symlink, anything
 *   else) or cannot be read → `ambiguous` conflict.
 *
 * Preflight inspects all eleven role paths BEFORE any write/rename, so an
 * unowned or ambiguous conflict throws with an actionable error while every
 * original file is still preserved — nothing is created, modified, renamed,
 * or backed up. Only the exact `<role>.md` paths are inspected; unrelated
 * files (user agents, `*.aria-backup-*`, `*.tmp` sentinels) are never read,
 * listed, or mutated.
 *
 * Standalone setup keeps the tolerant `installAgentFiles` (unmanaged
 * incumbents are backed up, never failed); this strict entry point is for
 * post-handoff continuation, where silently replacing user-owned files
 * would destroy evidence. Write/skip decisions and rollback semantics match
 * `installAgentFiles` exactly (same `AgentInstallResult` shape, same atomic
 * writes, same `partialResult` on error).
 */
export interface AgentFileConflict {
  role: RoleName;
  path: string;
  kind: "unowned" | "ambiguous";
  detail: string;
}

export class AgentReconciliationError extends Error {
  conflicts: AgentFileConflict[];
  constructor(conflicts: AgentFileConflict[], dir: string) {
    const lines = conflicts.map(
      (conflict) => `  ${conflict.role} (${conflict.path}): ${conflict.kind} — ${conflict.detail}`,
    );
    super(
      `Managed-agent reconciliation found ${conflicts.length} conflict(s) in ${dir}:\n${lines.join("\n")}\n` +
        `No files were created, modified, renamed, or backed up, and unrelated files were left untouched. ` +
        `Move each listed path aside (or remove it) to let ARIA manage that role, then re-run.`,
    );
    this.name = "AgentReconciliationError";
    this.conflicts = conflicts;
  }
}

/** Preflight probe of one expected role path; returns a conflict or null when reconcilable. */
async function preflightRolePath(dir: string, role: RoleName, wanted: string): Promise<AgentFileConflict | null> {
  const path = join(dir, agentFileName(role));
  let probe: Awaited<ReturnType<typeof lstat>>;
  try {
    probe = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : String(error);
    return { role, path, kind: "ambiguous", detail: `could not inspect role path (${reason}); refusing to guess` };
  }
  if (probe.isDirectory()) {
    return { role, path, kind: "ambiguous", detail: "role path is a directory, not a regular file" };
  }
  if (probe.isSymbolicLink() || !probe.isFile()) {
    return { role, path, kind: "ambiguous", detail: "role path is not a regular file" };
  }
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { role, path, kind: "ambiguous", detail: `role path could not be read (${reason}); refusing to guess` };
  }
  if (existing === wanted) return null;
  if (!isAriaManaged(existing)) {
    return {
      role,
      path,
      kind: "unowned",
      detail: "pre-existing file carries no ARIA ownership marker (never silently overwritten)",
    };
  }
  if (!verifyManagedContent(existing)) {
    return {
      role,
      path,
      kind: "ambiguous",
      detail: "ARIA-owned file has invalid integrity or an unsupported/hand-edited generated layout; refusing to overwrite",
    };
  }
  return null;
}

export async function reconcileManagedAgents(
  resolved: ResolvedAriaConfig,
  options: { dir?: string; version?: string } = {},
): Promise<AgentInstallResult> {
  const dir = options.dir ?? defaultAgentsDir();
  const version = options.version ?? readPackageVersion();
  const files = generateAgentFiles(resolved, version);

  // Phase 1 — preflight every role path before overwriting anything.
  const conflicts: AgentFileConflict[] = [];
  for (const role of ROLES) {
    const conflict = await preflightRolePath(dir, role, files[role]);
    if (conflict) conflicts.push(conflict);
  }
  if (conflicts.length > 0) throw new AgentReconciliationError(conflicts, dir);

  await mkdir(dir, { recursive: true });

  // Phase 2 — same write/skip decisions as `installAgentFiles`. The unowned
  // branch is unreachable after preflight except on a concurrent rename, so
  // it fails closed (never backs up silently) instead of backing up.
  const result: AgentInstallResult = {
    dir,
    version,
    written: [],
    unchanged: [],
    tampered: [],
    backups: {},
    previousContents: {},
  };
  try {
    for (const role of ROLES) {
      const path = join(dir, agentFileName(role));
      const wanted = files[role];
      const existing = await readExisting(path);
      if (existing === undefined) {
        await writeFileAtomic(path, wanted);
        result.written.push(role);
        continue;
      }
      if (existing === wanted) {
        result.unchanged.push(role);
        continue;
      }
      if (!isAriaManaged(existing)) {
        throw new AgentReconciliationError(
          [{
            role,
            path,
            kind: "unowned",
            detail: "role path changed under reconciliation (pre-existing file carries no ARIA ownership marker); refusing to overwrite",
          }],
          dir,
        );
      }
      if (!verifyManagedContent(existing)) result.tampered.push(role);
      result.previousContents[role] = existing;
      await writeFileAtomic(path, wanted);
      result.written.push(role);
    }
  } catch (error) {
    await rollbackAgentInstall(dir, result).catch(() => undefined);
    (error as AgentInstallPartialError).partialResult = result;
    throw error;
  }
  return result;
}
