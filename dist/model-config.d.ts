import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2/types";
import type { RoleName } from "./types.js";
/**
 * An available model, normalized to ARIA's providerID/modelID identifier.
 */
export interface AvailableModel {
    /** ARIA model identifier in provider/model format (e.g. "opencode/deepseek-v4-pro"). */
    id: string;
    providerID: string;
    modelID: string;
    name: string;
    /** Model-reported variant IDs that are not disabled. */
    variants: string[];
}
/**
 * An active AI provider.
 */
export interface AvailableProvider {
    id: string;
    name: string;
}
/**
 * Available enabled models and active providers discovered for a worktree.
 */
export interface ModelDiscovery {
    models: AvailableModel[];
    providers: AvailableProvider[];
}
/**
 * Discovery failed; no configuration has been written or changed.
 */
export declare class ModelDiscoveryError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Retain only enabled models whose provider is returned as active (not
 * disabled), normalizing each choice to ARIA's providerID/modelID identifier.
 */
export declare function normalizeAvailableModels(models: ModelV2Info[], providers: ProviderV2Info[]): AvailableModel[];
/**
 * Retain only providers returned as active (not disabled).
 */
export declare function normalizeAvailableProviders(providers: ProviderV2Info[]): AvailableProvider[];
/**
 * Discover available models and providers for a worktree.
 *
 * `aria setup` is a standalone CLI without a PluginInput client, so this
 * starts an ephemeral loopback OpenCode server through the SDK's server
 * bootstrap, creates the generated V2 directory-scoped client for the server
 * URL and worktree, and reads Model.list({ location }) and
 * Provider2.list({ location }).
 *
 * Server-startup, API-incompatibility, and discovery-response errors fail
 * discovery cleanly and leave configuration untouched.
 */
export declare function discoverAvailableModels(worktree: string): Promise<ModelDiscovery>;
/**
 * Discovery seam for `configureModels` (defaults to `discoverAvailableModels`).
 */
export type ModelDiscoverFn = (worktree: string) => Promise<ModelDiscovery>;
/**
 * Terminal input seam: resolve one trimmed line of user input.
 */
export type ModelConfigureInput = (prompt: string) => Promise<string>;
/**
 * Terminal output seam: emit one line of terminal text.
 */
export type ModelConfigureOutput = (text: string) => void;
/**
 * Injectable options for `configureModels`; every seam defaults to the real
 * implementation (SDK discovery, readline over stdin, stdout).
 */
export interface ModelConfigureOptions {
    /** Discovery override (defaults to `discoverAvailableModels`). */
    discovery?: ModelDiscoverFn;
    /** Input override (defaults to readline over `process.stdin`). */
    input?: ModelConfigureInput;
    /** Output override (defaults to `process.stdout`). */
    output?: ModelConfigureOutput;
    /** Explicit TTY override; defaults to `process.stdin.isTTY`. */
    tty?: boolean;
}
export type ModelConfigurationStatus = "configured" | "unchanged" | "skipped" | "failed";
/**
 * Outcome of `configureModels`. Exactly one of `configured`, `unchanged`,
 * `skipped`, or `failed`; configuration is only written for `configured`.
 */
export interface ModelConfigurationResult {
    status: ModelConfigurationStatus;
    /** Canonical global config path written, when status is "configured". */
    wrotePath?: string;
    /** Roles whose global assignment changed in the written file. */
    changedRoles?: RoleName[];
    /** Roles whose edit is masked by a project-local `aria.json` override. */
    maskedRoles?: RoleName[];
    /** Human-readable summary for setup output. */
    message: string;
    /** Error detail, when status is "failed". */
    error?: string;
}
/**
 * Lightweight interactive model configuration for `aria setup --configure`.
 *
 * Displays the nine configurable roles with their resolved current route and
 * the packaged recommended route, annotating each from discovery as available
 * or unavailable (purely diagnostic — no fallback routing is added). The user
 * may keep ARIA recommended defaults (removing any diverging global
 * overrides), keep current assignments (never writes), or configure specific
 * roles by selecting discovered models and their reported enabled variants.
 *
 * Only the canonical global config `~/.config/opencode/aria.json` is written
 * (atomically); project-local `aria.json` files and untouched global role
 * fields are preserved. When the canonical file is absent, legacy-global
 * choices seed the result only if an explicit edit is made. No file is
 * created for an unchanged or default-only result when none existed.
 */
export declare function configureModels(worktree: string, options?: ModelConfigureOptions): Promise<ModelConfigurationResult>;
//# sourceMappingURL=model-config.d.ts.map