// ---------------------------------------------------------------------------
// T013 — CodeGraph lifecycle adapter (shared by `aria setup` and `aria upgrade`).
//
// Consumes the T006 shared evidence gate plus the T016 bootstrap evidence in
// `src/bootstrap.ts` and implements ONLY evidence-supported behavior:
//
// - Clean system (no `codegraph` binary AND no V2/legacy registration):
//   install-if-missing via the demonstrated-safe ARIA-controlled path —
//   `npm view` discovery pinned exact at install time, binary-only
//   `npm install -g @colbymchenry/codegraph@<discovered>`, then ARIA
//   file-based V2 `mcp.servers.codegraph` registration (the shape from the
//   T006 `install --print-config` probe) with post-install validation
//   (`codegraph --version` + `opencode mcp list` connected) and
//   config-snapshot rollback. The upstream `codegraph install --target`
//   reconciler (legacy `mcp.codegraph` writer per T006) is NEVER invoked.
// - Existing installation (binary found OR any V2/legacy registration):
//   report-only with zero mutation. Per T006 the installed npm-global target
//   carries no ARIA ownership/provenance evidence, `codegraph upgrade` tracks
//   unpinned latest, and no demonstrated-safe XDG-aware update was
//   established — so even an outdated existing install stays untouched and
//   never guessed. The read-only `npm view` discovery may run to report the
//   available release alongside the installed version; it never authorizes a
//   mutation.
//
// - Binding: shared — callable directly by `aria setup` (no handoff needed)
//   AND post-handoff by `aria upgrade` via `codegraphUpgradeComponent`.
// - XDG-contained: config reads/writes go through the explicit `configDir`
//   seam (`openCodeGlobalDir(configDir)`); the install path reuses the T016
//   bootstrap mechanism which honors that seam. Dual `opencode.json` +
//   `opencode.jsonc` ambiguity, conflicting containers, and unparseable JSON
//   fail closed with zero mutation (T002).
// - `aria deps sync` still performs no CodeGraph mutation (the report-only
//   `syncCodeGraph` gate in `src/deps.ts` is unchanged by this task; T017
//   owns setup/upgrade wiring).
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BOOTSTRAP_EVIDENCE,
  discoverCodegraphLatest,
  installCodegraphIfMissing,
} from "./bootstrap.js";
import { detectCodeGraph, parseMcpList, stripJsoncComments, type Executor } from "./deps.js";
import { openCodeGlobalDir } from "./paths.js";
import type { ComponentContext, ComponentUpgradeOutcome } from "./upgrade.js";

/** Demonstrated-safe missing-install evidence owning this adapter's install path (T016). */
export const CODEGRAPH_BOOTSTRAP_EVIDENCE = BOOTSTRAP_EVIDENCE.find((entry) => entry.component === "codegraph");

/** Read-only classification of the local CodeGraph registration surface. */
export type CodegraphRegistration =
  | "absent"
  | "v2"
  | "legacy"
  | "conflicting"
  | "ambiguous"
  | "unparseable";

export interface CodegraphState {
  found: boolean;
  version: string | null;
  registration: CodegraphRegistration;
  /** Single config path the registration was read from (undefined when missing/ambiguous). */
  path?: string;
}

export type CodegraphLifecycleStatus = "installed" | "report-only" | "install-failed" | "validation-failed";

export interface CodegraphLifecycleResult {
  status: CodegraphLifecycleStatus;
  /** Version observed before any mutation (null when absent/unknown). */
  installedVersion: string | null;
  /** Version observed after a successful install (null unless installed). */
  resultingVersion: string | null;
  /** Latest upstream release from read-only `npm view` discovery (null when undiscovered). */
  availableVersion: string | null;
  detail: string;
  /** True only when a mutating command ran or a config file was written. */
  mutated: boolean;
  /** True when a config snapshot was restored after a failure. */
  rolledBack?: boolean;
  mcpConnected: boolean;
}

export interface CodegraphLifecycleOptions {
  /** Explicit global config dir (XDG-contained; omits to the effective root). */
  configDir?: string;
}

type SingleConfigState =
  | { kind: "missing" }
  | { kind: "ambiguous"; jsonPath: string; jsoncPath: string }
  | { kind: "single"; path: string; parsed: unknown; unparseable: boolean };

async function readSingleConfigState(configDir?: string): Promise<SingleConfigState> {
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
  if (jsonRaw !== null && jsoncRaw !== null) return { kind: "ambiguous", jsonPath, jsoncPath };
  if (jsonRaw !== null) {
    try {
      return { kind: "single", path: jsonPath, parsed: JSON.parse(jsonRaw.toString("utf8")) as unknown, unparseable: false };
    } catch {
      return { kind: "single", path: jsonPath, parsed: null, unparseable: true };
    }
  }
  if (jsoncRaw !== null) {
    try {
      return {
        kind: "single",
        path: jsoncPath,
        parsed: JSON.parse(stripJsoncComments(jsoncRaw.toString("utf8"))) as unknown,
        unparseable: false,
      };
    } catch {
      return { kind: "single", path: jsoncPath, parsed: null, unparseable: true };
    }
  }
  return { kind: "missing" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fail-closed classification of the local CodeGraph registration (read-only,
 * mirrors the T016 bootstrap rules): `absent` only when neither the
 * canonical V2 `mcp.servers.codegraph` nor the legacy `mcp.codegraph` shape
 * is present. Any present-but-unidentifiable container is `conflicting`.
 */
function classifyRegistration(parsed: unknown): Exclude<CodegraphRegistration, "ambiguous" | "unparseable"> {
  if (!isPlainObject(parsed)) return "conflicting";
  const mcp = parsed["mcp"];
  if (mcp === undefined) return "absent";
  if (!isPlainObject(mcp)) return "conflicting";
  const servers = mcp["servers"];
  if (servers !== undefined && !isPlainObject(servers)) return "conflicting";
  const v2 = isPlainObject(servers) ? (servers as Record<string, unknown>)["codegraph"] : undefined;
  const legacy = mcp["codegraph"];
  if (v2 !== undefined) return "v2";
  if (legacy !== undefined) return "legacy";
  return "absent";
}

/** Read-only MCP connectivity probe (`opencode mcp list` codegraph row). */
async function mcpConnected(executor: Executor): Promise<boolean> {
  try {
    const result = await executor("opencode", ["mcp", "list"]);
    return parseMcpList(result.stdout).codegraph;
  } catch {
    return false;
  }
}

/**
 * Read-only installed-state probe: binary presence/version via
 * `codegraph --version` plus the V2/legacy registration surface. Never
 * mutates (no npm/codegraph mutating command, no file write).
 */
export async function detectCodegraphState(executor: Executor, configDir?: string): Promise<CodegraphState> {
  const detected = await detectCodeGraph(executor);
  const config = await readSingleConfigState(configDir);
  if (config.kind === "ambiguous") {
    return { found: detected.found, version: detected.version, registration: "ambiguous" };
  }
  if (config.kind === "missing") {
    return { found: detected.found, version: detected.version, registration: "absent" };
  }
  if (config.unparseable) {
    return { found: detected.found, version: detected.version, registration: "unparseable", path: config.path };
  }
  return {
    found: detected.found,
    version: detected.version,
    registration: classifyRegistration(config.parsed),
    path: config.path,
  };
}

function reportOnly(
  installedVersion: string | null,
  availableVersion: string | null,
  detail: string,
  mcpConnectedValue: boolean,
): CodegraphLifecycleResult {
  return {
    status: "report-only",
    installedVersion,
    resultingVersion: null,
    availableVersion,
    detail,
    mutated: false,
    mcpConnected: mcpConnectedValue,
  };
}

/**
 * Shared lifecycle: install-if-missing on a clean system via the
 * demonstrated-safe ARIA-controlled path (delegated to the T016 bootstrap
 * mechanism: exact npm spec, binary-only install, ARIA file-based V2
 * registration, validation + rollback); every existing, ambiguous, or
 * otherwise unidentifiable installation stays report-only with zero
 * mutation. The upstream `codegraph install --target` legacy writer is never
 * invoked on any path.
 *
 * Callable directly by `aria setup` (no handoff needed) and post-handoff by
 * `aria upgrade` (see `codegraphUpgradeComponent`); it takes no handoff
 * payload and performs no ARIA self-replacement.
 */
export async function ensureCodegraph(
  executor: Executor,
  options: CodegraphLifecycleOptions = {},
): Promise<CodegraphLifecycleResult> {
  const configDir = options.configDir;

  const initial = await detectCodegraphState(executor, configDir);
  const connected = await mcpConnected(executor);

  // Fail-closed config surfaces (T002): never guess which file or container
  // is authoritative. Read-only probes above already ran; nothing mutates.
  if (initial.registration === "ambiguous") {
    return reportOnly(
      initial.version,
      null,
      "global opencode.json and opencode.jsonc both exist; dual-file ambiguity fails closed with neither file mutated (existing CodeGraph state left untouched, never guessed)",
      connected,
    );
  }
  if (initial.registration === "unparseable") {
    return reportOnly(
      initial.version,
      null,
      `${initial.path ?? "global config"}: invalid JSON; refusing to register without risking user settings (existing CodeGraph state left untouched)`,
      connected,
    );
  }
  if (initial.registration === "conflicting") {
    return reportOnly(
      initial.version,
      null,
      `${initial.path ?? "global config"}: unidentifiable CodeGraph registration container; refusing to write without risking user settings (existing state left untouched)`,
      connected,
    );
  }

  // Existing-install conservatism (T006): any detected binary or any V2 /
  // legacy registration means an existing installation whose npm-global
  // provenance is not positively ARIA-owned and whose update has no
  // demonstrated-safe path — report-only with zero mutation, never guessed.
  // A read-only `npm view` discovery reports the available release next to
  // the installed version when the installed version is positively known; it
  // never authorizes an update.
  if (initial.found || initial.registration !== "absent") {
    let available: string | null = null;
    if (initial.found && initial.version !== null) {
      const discovered = await discoverCodegraphLatest(executor);
      if (discovered.ok) available = discovered.version;
    }
    const shape = initial.registration === "absent"
      ? "binary present with no local registration"
      : `existing ${initial.registration} registration${initial.path ? ` (${initial.path})` : ""}`;
    const versionNote = initial.version !== null ? `CodeGraph ${initial.version}` : "CodeGraph (version not positively identified)";
    const availableNote = available !== null
      ? available !== initial.version
        ? `; latest upstream is ${available} but ownership is not positively established (npm-global per T006, no ARIA provenance) and no demonstrated-safe update path exists, so no update is attempted`
        : `; latest upstream is also ${available}`
      : "; available release undiscovered";
    return reportOnly(
      initial.version,
      available,
      `${versionNote} already installed (${shape}); ownership-gated/report-only with zero mutation — no \`npm install\`, no \`codegraph install --target\` (legacy writer), no \`codegraph upgrade\`${availableNote}`,
      connected,
    );
  }

  // Clean system: delegate to the demonstrated-safe T016 install-if-missing
  // mechanism (exact npm spec + binary-only install + ARIA file-based V2
  // registration + validation with config-snapshot rollback).
  const installed = await installCodegraphIfMissing(executor, configDir);
  switch (installed.status) {
    case "installed":
      return {
        status: "installed",
        installedVersion: null,
        resultingVersion: installed.installedVersion,
        availableVersion: installed.installedVersion,
        detail: installed.detail,
        mutated: true,
        rolledBack: false,
        // The bootstrap mechanism validates `codegraph --version` plus
        // `opencode mcp list` connected before reporting installed.
        mcpConnected: true,
      };
    case "already-present":
      // Defensive: the pre-check above found a clean system, so reaching
      // here would mean a concurrent change; stay report-only regardless.
      return reportOnly(null, null, `${installed.detail} (observed during install; leaving untouched with zero further mutation)`, connected);
    case "report-only":
      return reportOnly(null, null, installed.detail, connected);
    case "install-failed":
      return {
        status: "install-failed",
        installedVersion: null,
        resultingVersion: null,
        availableVersion: installed.installedVersion,
        detail: installed.detail,
        mutated: installed.mutated,
        mcpConnected: false,
      };
    case "validation-failed":
      return {
        status: "validation-failed",
        installedVersion: null,
        resultingVersion: null,
        availableVersion: installed.installedVersion,
        detail: installed.detail,
        mutated: installed.mutated,
        rolledBack: installed.rolledBack,
        mcpConnected: false,
      };
  }
}

/**
 * Post-handoff component wrapper for the T010 continuation
 * (`continueUpgradeInNewRelease` `components.codegraph` seam). Maps lifecycle
 * outcomes to component states with no global transactionality: completed
 * work stays, failures report rolled-back vs unresolved, and report-only
 * stays skipped. The `target` is intentionally unused — CodeGraph releases
 * are discovered at runtime (never a version database).
 */
export async function codegraphUpgradeComponent(ctx: ComponentContext): Promise<ComponentUpgradeOutcome> {
  void ctx.target;
  const result = await ensureCodegraph(ctx.executor, { configDir: ctx.configDir });
  switch (result.status) {
    case "installed":
      return { component: "codegraph", status: "completed", detail: result.detail, mutated: result.mutated };
    case "report-only":
      return { component: "codegraph", status: "skipped", detail: result.detail, mutated: false };
    case "install-failed":
    case "validation-failed":
      return {
        component: "codegraph",
        status: result.rolledBack === true ? "rolled-back" : "unresolved",
        detail: result.detail,
        mutated: true,
      };
  }
}
