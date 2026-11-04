import { type Executor } from "./deps.js";
import type { DependencyComponentName } from "./dependencies.js";
import { type UpgradeCheckResult } from "./upgrade.js";
/**
 * Integration discovery: what OpenCode actually loads (plugins from `opencode
 * plugin list`, MCP servers from `opencode mcp list`) merged with ARIA's
 * dependency definitions. Runtime discovery decides what exists; the
 * definitions decide what ARIA can manage. Read-only: no call here mutates
 * configuration or installs anything.
 */
export type ManagedComponent = "aria" | DependencyComponentName;
export type IntegrationKind = "plugin" | "mcp";
export type IntegrationOwnership = "aria-managed" | "external" | "remote" | "user" | "unverified" | "not-installed";
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
export declare const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[];
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
export declare function declaredMcpNames(debugConfigOutput: string): string[];
export declare function discoverIntegrations(executor: Executor, options?: IntegrationDiscoveryOptions): Promise<IntegrationInventory>;
/** Short label for an entry's ownership, shown in the console. */
export declare function ownershipLabel(ownership: IntegrationOwnership): string;
/**
 * Per-dependency update proposal for ARIA-managed (and ARIA-observed) entries.
 * Read-only: it states what would happen on explicit confirmation and what
 * blocks it. User-managed integrations are listed without any action.
 */
export declare function formatIntegrationProposal(inventory: IntegrationInventory): string;
//# sourceMappingURL=integrations.d.ts.map