import { parseMcpServers, type Executor } from "./deps.js";
import type { DependencyComponentName } from "./dependencies.js";
import { parsePluginList } from "./lifecycle.js";
import { QUOTA_MAJOR, quotaMajor } from "./quota.js";
import { checkUpgradeInventory, type UpgradeCheckResult, type UpgradeComponentRow } from "./upgrade.js";

/**
 * Integration discovery: what OpenCode actually loads (plugins from `opencode
 * plugin list`, MCP servers from `opencode mcp list`) merged with ARIA's
 * dependency definitions. Runtime discovery decides what exists; the
 * definitions decide what ARIA can manage. Read-only: no call here mutates
 * configuration or installs anything.
 */

export type ManagedComponent = "aria" | DependencyComponentName;
export type IntegrationKind = "plugin" | "mcp";
export type IntegrationOwnership =
  | "aria-managed"
  | "external"
  | "remote"
  | "user"
  | "unverified"
  | "not-installed";

export interface IntegrationDefinition {
  component: ManagedComponent;
  /** Runtime MCP server name in `opencode mcp list`. */
  mcp?: string;
  /** Runtime plugin id in `opencode plugin list`. */
  plugin?: string;
  required: boolean;
  mechanism: string;
}

/**
 * ARIA's managed dependency definitions. A runtime integration matching none of
 * these is reported as user-owned and is never acted on.
 */
export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = [
  {
    component: "engram",
    mcp: "engram",
    plugin: "engram",
    required: true,
    mechanism: "Engram release (Homebrew formula or GitHub asset); registered via `engram setup opencode`",
  },
  {
    component: "context7",
    mcp: "context7",
    required: true,
    mechanism: "remote MCP endpoint in the global OpenCode config (no local package, no client-side version)",
  },
  {
    component: "codegraph",
    mcp: "codegraph",
    required: true,
    mechanism: "npm @colbymchenry/codegraph (pinned install); ARIA V2 mcp.servers registration",
  },
  {
    component: "playwright",
    mcp: "playwright",
    required: true,
    mechanism: "pinned @playwright/mcp in an ARIA-owned prefix plus matching Chromium",
  },
  {
    component: "quota",
    plugin: "@slkiser/opencode-quota.server",
    required: false,
    mechanism: "native OpenCode plugin: 'opencode plugin add' (install) and targeted 'opencode plugin update @slkiser/opencode-quota' (update); Quota 6 only",
  },
  {
    component: "zotpilot",
    mcp: "zotpilot",
    required: false,
    mechanism: "user-managed Python package; ARIA reports and checks health, updates stay with the owner",
  },
  {
    component: "aria",
    plugin: "aria",
    required: true,
    mechanism: "ARIA self-upgrade through the exact-target handoff",
  },
];

export interface IntegrationEntry {
  kind: IntegrationKind;
  /** Runtime name: MCP server name or plugin id. */
  name: string;
  component: ManagedComponent | null;
  required: boolean | null;
  version: string | null;
  /** Plugin SOURCE column or "remote" for remote MCP endpoints. */
  source: string | null;
  /** Runtime state: MCP status word, or "listed" for plugins. */
  runtime: string;
  ownership: IntegrationOwnership;
  mechanism: string | null;
  action: string;
  blocker: string | null;
}

export interface IntegrationInventory {
  entries: IntegrationEntry[];
  /** MCP server names the effective config declares (`opencode debug config`). */
  declaredMcp: string[];
  /** Declared MCP servers the runtime list did not report even after one retry. */
  unreported: string[];
  /** Required ARIA components with no runtime presence (install via `aria setup`). */
  missingRequired: ManagedComponent[];
  /** Optional ARIA components with no runtime presence (install only with consent). */
  missingOptional: ManagedComponent[];
  pluginListOk: boolean;
  mcpListOk: boolean;
}

export interface IntegrationDiscoveryOptions {
  /** Reuse an inventory already computed in the same run (avoids duplicate probes). */
  inventory?: UpgradeCheckResult;
  configDir?: string;
}

function ownershipOf(row: UpgradeComponentRow | undefined): IntegrationOwnership {
  if (!row) return "unverified";
  switch (row.status) {
    case "current":
    case "upgrade-available":
      return "aria-managed";
    case "unmanaged-observed":
    case "provider-upgrade-available":
      return "external";
    case "remote-healthy":
      return "remote";
    case "skipped":
      return "not-installed";
    default:
      return "unverified";
  }
}

function actionFor(ownership: IntegrationOwnership, definition: IntegrationDefinition, row: UpgradeComponentRow | undefined): string {
  if (ownership === "external" && row?.installed && row.available && row.installed === row.available) {
    return `none (up to date with the latest release ${row.available})`;
  }
  if (definition.component === "quota" && ownership === "external") {
    // Quota is an ARIA-supported component: its update path is the gated Quota adapter, not adoption.
    return row?.available
      ? `update to ${row.available} via the gated Quota adapter after approval (see blocker, if any)`
      : "no update available or allowed right now (see blocker)";
  }
  switch (ownership) {
    case "user":
      return "none (not an ARIA dependency)";
    case "aria-managed":
      return row?.status === "upgrade-available"
        ? `update to ${row.available ?? "the ARIA pin"} (confirmed in Updates or 'aria deps --upgrade --yes')`
        : "none (up to date with the ARIA target)";
    case "external":
      if (row?.status === "provider-upgrade-available") {
        return `update to ${row.available ?? "the latest release"} via the provider's own mechanism after explicit approval (ARIA does not take ownership)`;
      }
      return "report-only; updates require an explicit adoption decision";
    case "remote":
      return "none (remote endpoint; no client-side version to update)";
    case "not-installed":
      return definition.required
        ? "missing required: install via 'aria setup'"
        : `missing optional: install only with consent (aria setup --install-optional ${definition.component})`;
    default:
      return "report-only; no action without fresh evidence";
  }
}

function blockerFor(ownership: IntegrationOwnership, row: UpgradeComponentRow | undefined): string | null {
  if (!row) return null;
  // Installed equals the latest known release: nothing blocks, nothing to do.
  if (row.installed !== null && row.available !== null && row.installed === row.available) return null;
  if (ownership === "external" || ownership === "unverified") return row.detail;
  return null;
}

/** Quota outside ARIA's supported major is reported with the reason, never downgraded. */
function quotaMajorBlocker(runtimeVersion: string): string | null {
  const major = quotaMajor(runtimeVersion);
  if (major === null || major === QUOTA_MAJOR) return null;
  return `Quota ${runtimeVersion} is outside ARIA's supported Quota ${QUOTA_MAJOR}.x major; reported only, never downgraded (run 'opencode plugin update @slkiser/opencode-quota' manually after review)`;
}

/**
 * Discover OpenCode's effective plugin and MCP inventory and merge it with ARIA's
 * definitions. Failed runtime lists are reported (`pluginListOk`/`mcpListOk`),
 * never guessed.
 */
/**
 * MCP server names declared by the effective OpenCode config. Read-only
 * (`opencode debug config`); the merged config is the `document` record that
 * carries `info.mcp`. Legacy `mcp.<name>` entries and V2 `mcp.servers.<name>`
 * entries are both declarations. Failure yields an empty list (unknown, never
 * guessed as absent).
 */
export function declaredMcpNames(debugConfigOutput: string): string[] {
  let records: unknown;
  try {
    records = JSON.parse(debugConfigOutput) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];
  const names = new Set<string>();
  for (const record of records) {
    const info = (record as { info?: { mcp?: Record<string, unknown> } } | null)?.info;
    const mcp = info?.mcp;
    if (!mcp || typeof mcp !== "object") continue;
    for (const [key, value] of Object.entries(mcp)) {
      if (key === "timeout") continue;
      if (key === "servers" && value && typeof value === "object") {
        for (const serverName of Object.keys(value)) names.add(serverName);
      } else if (value && typeof value === "object") {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

const MCP_RETRY_DELAY_MS = 1500;

export async function discoverIntegrations(
  executor: Executor,
  options: IntegrationDiscoveryOptions = {},
): Promise<IntegrationInventory> {
  const inventory = options.inventory ?? (await checkUpgradeInventory(executor, { availableOverride: null }));
  const rowFor = (component: ManagedComponent): UpgradeComponentRow | undefined =>
    inventory.components.find((row) => row.component === component);

  const pluginResult = await executor("opencode", ["plugin", "list"], { timeoutMs: 60_000 }).then(
    (result) => result,
    () => null,
  );
  const debugResult = await executor("opencode", ["debug", "config"], { timeoutMs: 60_000 }).then(
    (result) => result,
    () => null,
  );
  const declaredMcp = debugResult ? declaredMcpNames(debugResult.stdout) : [];

  const listMcp = async (): Promise<{ list: ReturnType<typeof parseMcpServers> | null }> => {
    const result = await executor("opencode", ["mcp", "list"], { timeoutMs: 60_000 }).then(
      (value) => value,
      () => null,
    );
    return { list: result ? parseMcpServers(result.stdout) : null };
  };
  let mcpRead = await listMcp();
  let unreported = declaredMcp.filter((name) => !(mcpRead.list ?? []).some((server) => server.name === name));
  if (mcpRead.list !== null && unreported.length > 0) {
    // A server can still be starting when the list is first read; retry once
    // before reporting it as not reported. Declared is never reported as absent.
    await new Promise((resolve) => setTimeout(resolve, MCP_RETRY_DELAY_MS));
    mcpRead = await listMcp();
    unreported = declaredMcp.filter((name) => !(mcpRead.list ?? []).some((server) => server.name === name));
  }
  const plugins = pluginResult ? parsePluginList(pluginResult.stdout) : { recognized: false, entries: [] };
  const mcps = mcpRead.list ?? [];
  const pluginListOk = plugins.recognized;
  const mcpListOk = mcpRead.list !== null;

  const entries: IntegrationEntry[] = [];
  const presentComponents = new Set<ManagedComponent>();
  // Declared-but-unreported servers are still configured: never "missing".
  for (const definition of INTEGRATION_DEFINITIONS) {
    if (definition.mcp !== undefined && declaredMcp.includes(definition.mcp)) presentComponents.add(definition.component);
    if (definition.plugin !== undefined && plugins.entries.some((entry) => entry.id === definition.plugin)) {
      presentComponents.add(definition.component);
    }
  }

  for (const server of mcps) {
    const definition = INTEGRATION_DEFINITIONS.find((candidate) => candidate.mcp === server.name);
    const component = definition?.component ?? null;
    const row = component ? rowFor(component) : undefined;
    const ownership = definition ? ownershipOf(row) : "user";
    if (component) presentComponents.add(component);
    entries.push({
      kind: "mcp",
      name: server.name,
      component,
      required: definition?.required ?? null,
      version: row?.installed ?? null,
      source: definition?.component === "context7" ? "remote" : null,
      runtime: server.status,
      ownership,
      mechanism: definition?.mechanism ?? null,
      action: definition ? actionFor(ownership, definition, row) : "none (not an ARIA dependency)",
      blocker: blockerFor(ownership, row),
    });
  }

  for (const plugin of plugins.entries) {
    const definition = INTEGRATION_DEFINITIONS.find((candidate) => candidate.plugin === plugin.id);
    const component = definition?.component ?? null;
    const row = component ? rowFor(component) : undefined;
    const ownership = definition ? ownershipOf(row) : "user";
    if (component) presentComponents.add(component);
    entries.push({
      kind: "plugin",
      name: plugin.id,
      component,
      required: definition?.required ?? null,
      version: row?.installed ?? (plugin.version === "local" ? null : plugin.version),
      source: plugin.target,
      runtime: "listed",
      ownership,
      mechanism: definition?.mechanism ?? null,
      action: definition ? actionFor(ownership, definition, row) : "none (not an ARIA dependency)",
      blocker: definition?.component === "quota" && plugin.version !== "local"
        ? quotaMajorBlocker(plugin.version) ?? blockerFor(ownership, row)
        : blockerFor(ownership, row),
    });
  }

  // Managed components the runtime does not list at all are missing, not guessed.
  const missingRequired: ManagedComponent[] = [];
  const missingOptional: ManagedComponent[] = [];
  const declaredKnown = debugResult !== null;
  for (const definition of INTEGRATION_DEFINITIONS) {
    if (definition.component === "aria") continue;
    if (presentComponents.has(definition.component)) continue;
    // Missing is claimed only when the source that would show the component answered.
    const judgeable = (definition.mcp !== undefined && (mcpListOk || declaredKnown))
      || (definition.plugin !== undefined && pluginListOk);
    if (!judgeable) continue;
    if (definition.component === "context7" && rowFor("context7")?.status === "remote-healthy") continue;
    if (definition.required) missingRequired.push(definition.component);
    else missingOptional.push(definition.component);
  }

  return { entries, declaredMcp, unreported, missingRequired, missingOptional, pluginListOk, mcpListOk };
}

/** Short label for an entry's ownership, shown in the console. */
export function ownershipLabel(ownership: IntegrationOwnership): string {
  switch (ownership) {
    case "aria-managed":
      return "ARIA-managed";
    case "external":
      return "external";
    case "remote":
      return "remote";
    case "user":
      return "user-managed";
    case "not-installed":
      return "not installed";
    default:
      return "unverified";
  }
}

/**
 * Per-dependency update proposal for ARIA-managed (and ARIA-observed) entries.
 * Read-only: it states what would happen on explicit confirmation and what
 * blocks it. User-managed integrations are listed without any action.
 */
export function formatIntegrationProposal(inventory: IntegrationInventory): string {
  const lines = ["Managed dependency details (read-only; no changes were made)", ""];
  for (const entry of inventory.entries) {
    if (entry.component === null || entry.component === "aria") continue;
    lines.push(`${entry.component} (${entry.kind} ${entry.name})`);
    lines.push(`  installed: ${entry.version ?? "unknown"}`);
    lines.push(`  source:    ${entry.source ?? "effective OpenCode config"} [${ownershipLabel(entry.ownership)}]`);
    if (entry.mechanism) lines.push(`  mechanism: ${entry.mechanism}`);
    lines.push(`  action:    ${entry.action}`);
    lines.push(`  blocker:   ${entry.blocker ?? "none"}`);
    lines.push("");
  }
  for (const name of inventory.unreported) {
    lines.push(`declared but not reported by the runtime: ${name} (state unknown; not treated as missing)`);
  }
  for (const component of inventory.missingRequired) {
    lines.push(`missing required: ${component} (install with 'aria setup')`);
  }
  for (const component of inventory.missingOptional) {
    lines.push(`missing optional: ${component} (install only with consent: aria setup --install-optional ${component})`);
  }
  return lines.join("\n").trimEnd();
}
