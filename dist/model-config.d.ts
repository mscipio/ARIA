import { installAgentFiles } from "./agents.js";
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
    /**
     * True when the model's verbose metadata reported a `variants` key (even an
     * explicitly empty object). Absent/false means variant metadata is not
     * observable, so a configured variant for this model cannot be verified.
     */
    variantsObservable?: boolean;
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
 *
 * Retained as a tested parser only: pinned OpenCode 2.0.23 discovery uses
 * plain `opencode models` and never assumes `--verbose` support.
 */
export declare function parseModelVerbose(stdout: string): AvailableModel[];
/**
 * Discover the models the installed `opencode` CLI reports as usable for a
 * worktree.
 *
 * `aria setup` is a standalone CLI without a PluginInput client, so this
 * shells out to plain `opencode models` for the usable identifier list.
 * Pinned OpenCode 2.0.23 has no supported `--verbose` variant-metadata
 * surface, so variant capability stays unestablished here (`variants` is
 * empty and `variantsObservable` is absent); doctor reports a configured
 * variant as unknown rather than verified or failed.
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
 * T003 — Regenerate managed agent files from freshly resolved routes.
 *
 * Project-neutral (packaged defaults plus global overrides only, never
 * CWD project models) so global files never bake in project state; the
 * worktree argument only anchors project-neutral resolution. Unmanaged
 * pre-existing files are backed up and unrelated files untouched via
 * `installAgentFiles`. Callers invoke this only after a successful route
 * write; failed writes must never rewrite agents.
 */
export declare function regenerateManagedAgents(worktree: string, options?: {
    dir?: string;
}): ReturnType<typeof installAgentFiles>;
/**
 * Lightweight interactive model configuration for `aria setup --configure`.
 *
 * Discovers the models the installed `opencode` CLI reports once per run and
 * shows the eleven configurable roles with their four-layer precedence
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