import { constants as fsConstants } from "node:fs";
import { access as fsAccess, readFile, stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";

import { getPackageRoot } from "./defaults.js";
import {
  defaultExecutor,
  doctor as dependencyDoctor,
  extractVersion,
  probeSubagentDepth,
  type DepsStatus,
  type Executor,
  type SubagentDepthProbe,
} from "./deps.js";
import { discoverAvailableModels, type AvailableModel, type ModelDiscoverFn, type ModelDiscovery } from "./model-config.js";
import {
  CODING_ROLES,
  PACKAGE_SKILL_NAMES,
  roleRequirementIssues,
  validateZotPilotPolicy,
} from "./register.js";
import { deriveRoutes, ROLES, type ResolvedRoute } from "./routes.js";
import type { AriaDefaults, RoleDefaults } from "./types.js";

/**
 * Read-only ARIA doctor: aggregates package, config, routes/models, skills,
 * required integrations, and optional ZotPilot/Wiki probes into
 * PASS/WARN/FAIL/SKIP findings. Probe and config errors are aggregated into
 * findings rather than thrown, and nothing is written, installed, or
 * repaired.
 */

export type DoctorFindingSeverity = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface DoctorFinding {
  severity: DoctorFindingSeverity;
  /** Finding group: "package", "config", "routes/models", "dependencies", "skills", "zotpilot", "wiki". */
  area: string;
  title: string;
  detail?: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
}

/** Read-only stat result used for non-mutating metadata checks. */
export interface DoctorFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Read-only filesystem seam used for package/skill/wiki validation. */
export interface DoctorFileOps {
  readText(path: string): Promise<string>;
  /** Non-mutating metadata check (defaults to node:fs stat). */
  stat?(path: string): Promise<DoctorFileStat>;
  /** Non-mutating accessibility check (defaults to node:fs access). */
  access?(path: string, mode: number): Promise<void>;
}

const defaultFileOps: DoctorFileOps = {
  readText: (path) => readFile(path, "utf8"),
  stat: (path) => fsStat(path),
  access: (path, mode) => fsAccess(path, mode),
};

export interface DoctorOptions {
  /** Command execution seam for the composed dependency doctor. */
  executor?: Executor;
  /** Model discovery seam (defaults to `discoverAvailableModels`). */
  discovery?: ModelDiscoverFn;
  /** Worktree whose config and resolved routes are inspected. */
  worktree?: string;
  /** Read-only filesystem seam for package validation (defaults to node:fs). */
  fileOps?: DoctorFileOps;
}

/**
 * ANSI escape sequences (SGR color codes and friends) that upstream CLIs can
 * emit even on non-TTY stderr. Embedded probe error text is stripped so the
 * rendered report stays plain in every environment.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function describeError(error: unknown): string {
  let text: string;
  if (error instanceof Error && error.message) {
    text = error.message;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return text.replace(ANSI_ESCAPE_RE, "");
}

// ---------------------------------------------------------------------------
// Package validation: package.json version, defaults, and packaged prompts
// ---------------------------------------------------------------------------

/** The current packaged-role mode contract (mirrors `RoleDefaults["mode"]`). */
const ROLE_MODES = new Set<RoleDefaults["mode"]>(["primary", "subagent", "all"]);

/**
 * Bounded validation of the current `AriaDefaults` shape that role resolution
 * and registration actually consume: every canonical role must be a plain
 * object with a non-empty `model` and `promptFile`, a `mode` from the current
 * contract, and, when present, a non-empty string `variant`. Malformed
 * defaults FAIL instead of silently reaching resolution.
 */
function validateDefaults(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "defaults root is not an object" };
  }
  const roles = (raw as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    return { ok: false, reason: "defaults.roles missing or not an object" };
  }
  const roleEntries = roles as Record<string, unknown>;
  for (const role of ROLES) {
    const entry = roleEntries[role];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `defaults.roles.${role} missing or invalid` };
    }
    const roleEntry = entry as Partial<Record<keyof RoleDefaults, unknown>>;
    const model = roleEntry.model;
    if (typeof model !== "string" || model.trim().length === 0) {
      return { ok: false, reason: `defaults.roles.${role}.model missing or empty` };
    }
    const mode = roleEntry.mode;
    if (typeof mode !== "string" || !ROLE_MODES.has(mode as RoleDefaults["mode"])) {
      return { ok: false, reason: `defaults.roles.${role}.mode missing or invalid (expected "primary", "subagent", or "all")` };
    }
    const variant = roleEntry.variant;
    if (variant !== undefined && (typeof variant !== "string" || variant.trim().length === 0)) {
      return { ok: false, reason: `defaults.roles.${role}.variant invalid (expected a non-empty string when present)` };
    }
    const promptFile = roleEntry.promptFile;
    if (typeof promptFile !== "string" || promptFile.trim().length === 0) {
      return { ok: false, reason: `defaults.roles.${role}.promptFile missing or empty` };
    }
  }
  return { ok: true };
}

async function collectPackageFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  // package.json version (required).
  try {
    const raw = await fileOps.readText(resolve(packageRoot, "package.json"));
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      findings.push({
        severity: "PASS",
        area: "package",
        title: "package.json version",
        detail: parsed.version,
      });
    } else {
      findings.push({
        severity: "FAIL",
        area: "package",
        title: "package.json version",
        detail: "missing or empty version",
      });
    }
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "package",
      title: "package.json version",
      detail: describeError(error),
    });
  }

  // Packaged defaults (required).
  let defaults: AriaDefaults | undefined;
  try {
    const raw = await fileOps.readText(resolve(packageRoot, "defaults", "aria.defaults.json"));
    const parsed = JSON.parse(raw) as unknown;
    const valid = validateDefaults(parsed);
    if (valid.ok) {
      defaults = parsed as AriaDefaults;
      findings.push({ severity: "PASS", area: "package", title: "defaults" });
    } else {
      findings.push({ severity: "FAIL", area: "package", title: "defaults", detail: valid.reason });
    }
  } catch (error) {
    findings.push({ severity: "FAIL", area: "package", title: "defaults", detail: describeError(error) });
  }

  // Each defaults-referenced prompt (required).
  if (defaults) {
    for (const role of ROLES) {
      const promptFile = defaults.roles[role].promptFile;
      try {
        const text = await fileOps.readText(resolve(packageRoot, "defaults", promptFile));
        if (text.trim().length === 0) {
          findings.push({
            severity: "FAIL",
            area: "package",
            title: `prompt ${role}`,
            detail: `defaults/${promptFile} is empty`,
          });
        } else {
          findings.push({ severity: "PASS", area: "package", title: `prompt ${role}` });
        }
      } catch (error) {
        findings.push({
          severity: "FAIL",
          area: "package",
          title: `prompt ${role}`,
          detail: `defaults/${promptFile}: ${describeError(error)}`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Route/model cross-check
// ---------------------------------------------------------------------------

function routeFinding(route: ResolvedRoute, discovered: Map<string, AvailableModel>): DoctorFinding[] {
  const model = discovered.get(route.model);
  const routeText = route.variant ? `${route.model} (${route.variant})` : route.model;
  if (!model) {
    return [{
      severity: "FAIL",
      area: "routes/models",
      title: route.role,
      detail: `configured model ${route.model} is not listed by opencode models`,
    }];
  }
  if (!route.variant) {
    return [{ severity: "PASS", area: "routes/models", title: route.role, detail: route.model }];
  }
  if (model.variantsObservable !== true) {
    // Metadata absent: never guess whether the variant is supported.
    return [{
      severity: "WARN",
      area: "routes/models",
      title: route.role,
      detail: `${routeText}: variant metadata not observable; configured variant not verified`,
    }];
  }
  if (model.variants.includes(route.variant)) {
    return [{ severity: "PASS", area: "routes/models", title: route.role, detail: routeText }];
  }
  const reported = model.variants.length > 0
    ? ` (reported: ${model.variants.join(", ")})`
    : " (no reported variants)";
  return [{
    severity: "FAIL",
    area: "routes/models",
    title: route.role,
    detail: `${routeText}: configured variant not supported${reported}`,
  }];
}

// ---------------------------------------------------------------------------
// Config: effective subagent depth (read-only `opencode debug config`)
// ---------------------------------------------------------------------------

/**
 * Advisory finding for the effective merged top-level `subagent_depth`
 * reported by the read-only `opencode debug config` probe. An absent field is
 * PASS (ARIA supplies the runtime default/recommendation 3); a finite numeric
 * value >= 3 is PASS with the effective value; a finite numeric value < 3 is
 * a nonfatal WARN with the effective value and possible degraded nested
 * cooperation; unavailable/malformed output is a nonfatal WARN. This finding
 * never FAILs and never attributes the value to user configuration or ARIA.
 */
function subagentDepthFinding(probe: SubagentDepthProbe): DoctorFinding {
  if (probe.status === "absent") {
    return {
      severity: "PASS",
      area: "config",
      title: "subagent depth",
      detail: "absent from merged debug config; ARIA supplies runtime default/recommendation 3",
    };
  }
  if (probe.status === "value") {
    return probe.depth >= 3
      ? {
          severity: "PASS",
          area: "config",
          title: "subagent depth",
          detail: `effective value ${probe.depth} is sufficient for nested ARIA cooperation`,
        }
      : {
          severity: "WARN",
          area: "config",
          title: "subagent depth",
          detail: `effective value ${probe.depth}; nested ARIA cooperation may be degraded`,
        };
  }
  return {
    severity: "WARN",
    area: "config",
    title: "subagent depth",
    detail: `effective value not identified: ${probe.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Composed dependency doctor (legacy deps.ts health probes)
// ---------------------------------------------------------------------------

/** Wording marking fresh CLI observations as distinct from live-session inventory. */
const FRESH_CLI_OBSERVATION = "fresh standalone `opencode mcp list` CLI observation (not live-session inventory)";

function dependencyFindings(deps: DepsStatus): DoctorFinding[] {
  return [
    {
      severity: deps.opencode.found ? "PASS" : "FAIL",
      area: "dependencies",
      title: "OpenCode",
      detail: deps.opencode.found ? (deps.opencode.version ?? "version unknown") : "not found",
    },
    {
      severity: deps.engram.found && deps.engram.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "Engram",
      detail: !deps.engram.found
        ? "not found"
        : !deps.engram.connected
          ? "not connected"
          : `${deps.engram.version ?? "version unknown"} (${FRESH_CLI_OBSERVATION})`,
    },
    {
      severity: deps.context7.configured && deps.context7.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "Context7",
      detail: !deps.context7.configured
        ? "not configured"
        : !deps.context7.connected
          ? "not connected"
          : `configured (${FRESH_CLI_OBSERVATION})`,
    },
    {
      severity: deps.codegraph.found && deps.codegraph.connected ? "PASS" : "FAIL",
      area: "dependencies",
      title: "CodeGraph",
      detail: !deps.codegraph.found
        ? "not found"
        : !deps.codegraph.connected
          ? "not connected"
          : `${deps.codegraph.version ?? "version unknown"} (${FRESH_CLI_OBSERVATION})`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Optional ZotPilot: CLI availability/version, MCP connectivity, limitation
// ---------------------------------------------------------------------------

/**
 * Smallest safe ZotPilot CLI probe: `zotpilot --version` only. Never runs
 * `mcp serve`, doctor/setup/upgrade/index, or anything touching Zotero or
 * configuration.
 */
async function probeZotPilotCli(executor: Executor): Promise<{ found: boolean; version: string | null; reason?: string }> {
  try {
    const result = await executor("zotpilot", ["--version"]);
    const version = extractVersion(result.stdout);
    if (!version) return { found: false, version: null, reason: "probe output not parseable" };
    return { found: true, version };
  } catch (error) {
    return { found: false, version: null, reason: describeError(error) };
  }
}

function zotPilotCliFinding(probe: { found: boolean; version: string | null; reason?: string }): DoctorFinding {
  if (probe.found && probe.version) {
    return {
      severity: "PASS",
      area: "zotpilot",
      title: "ZotPilot CLI",
      detail: `available (${probe.version}) via zotpilot --version`,
    };
  }
  return {
    severity: "WARN",
    area: "zotpilot",
    title: "ZotPilot CLI",
    detail: probe.reason
      ? `availability/version not identified: ${probe.reason} (ZotPilot MCP may still work)`
      : "availability/version not identified (ZotPilot MCP may still work)",
  };
}

/**
 * ZotPilot MCP connectivity, kept clearly separate from CLI availability.
 * Optional at runtime but expected for the advertised researcher capability,
 * so degraded states are WARN, never FAIL.
 */
function zotPilotMcpFindings(deps: DepsStatus | undefined): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (!deps || deps.mcpListFailed) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: deps?.mcpListFailed
        ? "opencode mcp list failed; server presence unknown"
        : "dependency probes failed; server presence unknown",
    });
  } else if (!deps.zotpilot) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: "not listed by opencode mcp list",
    });
  } else if (!deps.zotpilot.connected) {
    findings.push({
      severity: "WARN",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: "listed by opencode mcp list but not connected",
    });
  } else {
    findings.push({
      severity: "PASS",
      area: "zotpilot",
      title: "ZotPilot MCP",
      detail: `connected (${FRESH_CLI_OBSERVATION})`,
    });
  }
  findings.push({
    severity: "SKIP",
    area: "zotpilot",
    title: "live tool inventory",
    detail: "standalone aria doctor cannot compare expected/present/missing/unexpected live ZotPilot tool IDs or OpenCode session permissions; no safe supported tools/list mechanism exists",
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Package skills and canonical role/ZotPilot policy validation
// ---------------------------------------------------------------------------

/** Minimal YAML-frontmatter extraction for packaged SKILL.md validation. */
function parseSkillFrontmatter(text: string): { name?: string; owner?: string; error?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return { error: "frontmatter missing" };
  const block = match[1];
  const nameMatch = block.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  const metadataMatch = block.match(/^metadata:\s*\r?\n((?:\s+[^\r\n]*\r?\n?)*)/m);
  const ownerMatch = metadataMatch?.[1]?.match(/^\s+owner:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return {
    name: nameMatch?.[1]?.trim(),
    owner: ownerMatch?.[1]?.trim(),
  };
}

/**
 * Validate every exact `<package skill root>/<name>/SKILL.md` referenced by
 * the derived packaged-skill inventory, with matching frontmatter `name` and
 * `metadata.owner: aria`. Only the exact derived paths are read; the skills
 * directory is never scanned, so user skills are never touched.
 */
async function collectSkillFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const failures: string[] = [];

  for (const name of PACKAGE_SKILL_NAMES) {
    const skillPath = resolve(packageRoot, "skills", name, "SKILL.md");
    try {
      const text = await fileOps.readText(skillPath);
      const meta = parseSkillFrontmatter(text);
      if (meta.error) {
        failures.push(`${name}: ${meta.error}`);
      } else if (meta.name !== name) {
        failures.push(`${name}: frontmatter name mismatch (got ${meta.name ?? "none"})`);
      } else if (meta.owner !== "aria") {
        failures.push(`${name}: metadata.owner is ${meta.owner ?? "missing"}, expected aria`);
      }
    } catch (error) {
      failures.push(`${name}: ${describeError(error)}`);
    }
  }

  if (failures.length === 0) {
    findings.push({
      severity: "PASS",
      area: "skills",
      title: "packaged skills",
      detail: `${PACKAGE_SKILL_NAMES.length} of ${PACKAGE_SKILL_NAMES.length} validated (matching name, metadata.owner: aria)`,
    });
  } else {
    findings.push({
      severity: "FAIL",
      area: "skills",
      title: "packaged skills",
      detail: failures.join("; "),
    });
  }
  return findings;
}

/**
 * Canonical role policy findings. The ZotPilot policy finding compares the
 * canonical expected IDs with the effective researcher entries and truthfully
 * reports present/missing/unexpected package-policy IDs; this is internal
 * policy validation, not a live tool inventory.
 */
function rolePolicyFindings(): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const roleIssues = roleRequirementIssues();
  findings.push(roleIssues.length === 0
    ? {
        severity: "PASS",
        area: "skills",
        title: "role permission requirements",
        detail: `coding roles (${CODING_ROLES.join(", ")}) have Engram/Context7/CodeGraph; researcher has Context7 + exact ZotPilot policy; writer/archivist are non-coding`,
      }
    : {
        severity: "FAIL",
        area: "skills",
        title: "role permission requirements",
        detail: roleIssues.join("; "),
      });

  const policy = validateZotPilotPolicy();
  if (policy.issues.length === 0) {
    findings.push({
      severity: "PASS",
      area: "skills",
      title: "ZotPilot policy",
      detail: `${policy.expectedReadIds.length} read allow + ${policy.expectedMutationIds.length} mutation ask, disjoint, no wildcards`,
    });
  } else {
    const parts = [
      ...policy.issues,
      policy.missing.length > 0 ? `missing: ${policy.missing.join(", ")}` : "",
      policy.unexpected.length > 0 ? `unexpected: ${policy.unexpected.join(", ")}` : "",
      policy.wildcards.length > 0 ? `wildcards: ${policy.wildcards.join(", ")}` : "",
    ].filter(Boolean);
    findings.push({
      severity: "FAIL",
      area: "skills",
      title: "ZotPilot policy",
      detail: parts.join("; "),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Wiki: packaged pipeline assets and optional WIKI_DIR accessibility
// ---------------------------------------------------------------------------

/** Packaged wiki-pipeline assets referenced by the archivist/package contract. */
const WIKI_PIPELINE_ASSETS = [
  "__init__.py",
  "run.py",
  "compiler.py",
  "search.py",
  "docs/instructions.md",
  "docs/compile-workflow.md",
] as const;

/**
 * Non-mutating Wiki checks: packaged pipeline assets must exist; WIKI_DIR
 * unset is SKIP, while a configured path that does not exist, is not a
 * directory, or lacks read/write accessibility is FAIL. No archival,
 * compilation, lint, installation, or other integration action is run.
 */
async function collectWikiFindings(packageRoot: string, fileOps: DoctorFileOps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const stat = fileOps.stat ?? ((path: string) => fsStat(path));
  const access = fileOps.access ?? ((path: string, mode: number) => fsAccess(path, mode));

  const missingAssets: string[] = [];
  for (const asset of WIKI_PIPELINE_ASSETS) {
    const assetPath = resolve(packageRoot, "wiki-pipeline", asset);
    try {
      const info = await stat(assetPath);
      if (!info.isFile()) missingAssets.push(`${asset} (not a file)`);
    } catch (error) {
      missingAssets.push(`${asset} (${describeError(error)})`);
    }
  }
  findings.push(missingAssets.length === 0
    ? {
        severity: "PASS",
        area: "wiki",
        title: "wiki pipeline assets",
        detail: `${WIKI_PIPELINE_ASSETS.length} of ${WIKI_PIPELINE_ASSETS.length} packaged assets present`,
      }
    : {
        severity: "FAIL",
        area: "wiki",
        title: "wiki pipeline assets",
        detail: `missing or invalid: ${missingAssets.join("; ")}`,
      });

  const wikiDir = process.env.WIKI_DIR;
  if (!wikiDir || wikiDir.trim().length === 0) {
    findings.push({
      severity: "SKIP",
      area: "wiki",
      title: "WIKI_DIR",
      detail: "unset; wiki archival/compile capability degraded",
    });
    return findings;
  }

  let info;
  try {
    info = await stat(wikiDir);
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} does not exist (${describeError(error)})`,
    });
    return findings;
  }
  if (!info.isDirectory()) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} is not a directory`,
    });
    return findings;
  }
  try {
    await access(wikiDir, fsConstants.R_OK | fsConstants.W_OK);
    findings.push({
      severity: "PASS",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} is an accessible directory (read/write)`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "wiki",
      title: "WIKI_DIR",
      detail: `${wikiDir} lacks required read/write accessibility (${describeError(error)})`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Runner / formatter / exit code
// ---------------------------------------------------------------------------

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const worktree = options.worktree ?? process.cwd();
  const executor = options.executor ?? defaultExecutor;
  const discovery = options.discovery ?? ((worktreePath: string) => discoverAvailableModels(worktreePath));
  const fileOps = options.fileOps ?? defaultFileOps;
  const findings: DoctorFinding[] = [];

  // Package: version, defaults, prompts (independent of worktree config).
  findings.push(...await collectPackageFindings(getPackageRoot(), fileOps));

  // Config: resolved role routes (invalid global/project config is FAIL).
  let routes: ResolvedRoute[] | undefined;
  try {
    routes = deriveRoutes(worktree);
    findings.push({
      severity: "PASS",
      area: "config",
      title: "role route resolution",
      detail: `defaults, global, and project overrides applied for ${worktree}`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "config",
      title: "role route resolution",
      detail: describeError(error),
    });
  }

  // Effective cooperation depth: read-only `opencode debug config` probe of
  // the merged config's own top-level subagent_depth (advisory, never FAIL).
  findings.push(subagentDepthFinding(await probeSubagentDepth(executor, worktree)));

  // Model discovery (failure is FAIL; nothing is guessed).
  let discovered: ModelDiscovery | undefined;
  try {
    discovered = await discovery(worktree);
    findings.push({
      severity: "PASS",
      area: "routes/models",
      title: "model discovery",
      detail: `${discovered.models.length} model${discovered.models.length === 1 ? "" : "s"} reported`,
    });
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "routes/models",
      title: "model discovery",
      detail: describeError(error),
    });
  }

  // Cross-check each resolved route against the discovered models.
  if (routes && discovered) {
    const byId = new Map(discovered.models.map((model) => [model.id, model]));
    for (const route of routes) findings.push(...routeFinding(route, byId));
  } else {
    findings.push({
      severity: "SKIP",
      area: "routes/models",
      title: "route/model validation",
      detail: "skipped because role route resolution or model discovery failed",
    });
  }

  // Compose the existing dependency doctor and derive the optional ZotPilot
  // MCP state from the same fresh `opencode mcp list` observation.
  let deps: DepsStatus | undefined;
  try {
    deps = await dependencyDoctor(executor);
    findings.push(...dependencyFindings(deps));
  } catch (error) {
    findings.push({
      severity: "FAIL",
      area: "dependencies",
      title: "dependency probes",
      detail: describeError(error),
    });
  }
  findings.push(...zotPilotMcpFindings(deps));

  // Optional ZotPilot CLI availability/version (separate from MCP connectivity).
  findings.push(zotPilotCliFinding(await probeZotPilotCli(executor)));

  // Packaged skills and canonical role/ZotPilot policy validation.
  findings.push(...await collectSkillFindings(getPackageRoot(), fileOps));
  findings.push(...rolePolicyFindings());

  // Wiki: packaged pipeline assets and optional WIKI_DIR accessibility.
  findings.push(...await collectWikiFindings(getPackageRoot(), fileOps));

  return { findings };
}

/**
 * Expanded-report exit code: exactly 0 when no finding is FAIL, otherwise 1.
 */
export function doctorExitCode(findings: readonly DoctorFinding[]): number {
  return findings.some((finding) => finding.severity === "FAIL") ? 1 : 0;
}

/** Compact plain-text rendering with literal PASS/WARN/FAIL/SKIP labels. */
export function formatDoctorReport(report: DoctorReport): string {
  const sections: Array<{ area: string; lines: string[] }> = [];
  let current: { area: string; lines: string[] } | undefined;
  for (const finding of report.findings) {
    if (!current || current.area !== finding.area) {
      current = { area: finding.area, lines: [] };
      sections.push(current);
    }
    current.lines.push(`  [${finding.severity}] ${finding.title}${finding.detail ? `: ${finding.detail}` : ""}`);
  }
  const body = sections
    .map((section) => [`${section.area}:`, ...section.lines].join("\n"))
    .join("\n\n");
  return `ARIA doctor\n\n${body}`;
}
