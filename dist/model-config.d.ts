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
    /** Model-reported variant IDs. */
    variants: string[];
}
/**
 * Available models discovered for a worktree.
 */
export interface ModelDiscovery {
    models: AvailableModel[];
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
 * Parse `opencode models` output: one usable model identifier per line,
 * without variant metadata.
 */
export declare function parseModelList(stdout: string): AvailableModel[];
/**
 * Parse `opencode models --verbose` output: each model identifier line is
 * followed by its JSON metadata block, whose `variants` object keys are the
 * reported variant IDs.
 */
export declare function parseModelVerbose(stdout: string): AvailableModel[];
/**
 * Discover the models the installed `opencode` CLI reports as usable for a
 * worktree.
 *
 * `aria setup` is a standalone CLI without a PluginInput client, so this
 * shells out to `opencode models` for the usable identifier list and to
 * `opencode models --verbose` for metadata (names and reported variants),
 * merging the two by identifier.
 *
 * CLI failures (non-zero exit or no output) fail discovery cleanly and leave
 * configuration untouched.
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
 * implementation (CLI discovery, readline over stdin, stdout).
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
 * Discovers the models the installed `opencode` CLI reports once per run and
 * shows the nine configurable roles with their four-layer precedence
 * (packaged default, global override, project override, resolved route),
 * annotating resolved models the CLI did not list (purely diagnostic — no
 * fallback routing is added). The user may keep the current configuration
 * (never writes) or configure specific roles through a search-driven model
 * prompt and compact variant selection.
 *
 * Only the canonical global config `~/.config/opencode/aria.json` is written
 * (atomically); project-local `aria.json` files and untouched global role
 * fields are preserved. When the canonical file is absent, legacy-global
 * choices seed the result only if an explicit edit is made. No file is
 * created for an unchanged or default-only result when none existed.
 */
export declare function configureModels(worktree: string, options?: ModelConfigureOptions): Promise<ModelConfigurationResult>;
//# sourceMappingURL=model-config.d.ts.map