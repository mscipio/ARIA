import type { Readable, Writable } from "node:stream";
import { depsSync, type Executor } from "./deps.js";
import type { DependencyLifecycleResult, DependencyOutcome } from "./dependencies.js";
import { type ModelConfigurationResult, type ModelConfigureOptions } from "./model-config.js";
export interface LifecycleResult {
    ok: boolean;
    stage: string;
    setup?: SetupResult;
    update?: UpdateResult;
}
export interface SetupResult {
    registration: {
        action: "registered" | "already registered" | "failed";
        detail?: string;
    };
    sync: {
        ok: boolean;
        output?: string;
        error?: string;
    };
    /**
     * Outcome of the global V2 config phase (T008). Always present unless
     * registration failed first.
     */
    config?: SetupConfigPhase;
    /**
     * Outcome of the managed agent-file phase (T008). Always present unless
     * registration or config failed first.
     */
    agents?: SetupAgentsPhase;
    /**
     * Outcome of the shared dependency lifecycle (T017). Present only when a
     * `dependenciesFn` seam was provided (the `aria setup` CLI always provides
     * the real `runSetupDependencies`; omitted preserves the pre-T017
     * registration/config/agents/sync behavior for existing callers/tests).
     * The lifecycle invokes the shared adapters directly with no ARIA
     * self-upgrade handoff.
     */
    dependencies?: SetupDependenciesPhase;
    /** Outcome of the optional model-configuration phase; absent unless requested. */
    model?: ModelConfigurationResult;
}
/**
 * T008 file-phase outcomes: global `opencode.json(c)` (exact plugin URI,
 * single skills root, depth default 3; unrelated user keys preserved,
 * backup before replace, idempotent) and the eleven managed agent files
 * (via T003 `installAgentFiles`, resolved project-neutral). T002 discovery
 * selects which of `opencode.json` / `opencode.jsonc` is the target and
 * `path` always reports the resolved file.
 */
export interface SetupConfigPhase {
    path: string;
    changed: boolean;
    created: boolean;
    backupPath?: string;
    detail?: string;
}
export interface SetupAgentsPhase {
    dir: string;
    version: string;
    written: number;
    unchanged: number;
    detail?: string;
}
/**
 * Model-configuration seam for `setup` (defaults to the real `configureModels`),
 * so tests can inject a mock without touching discovery or the interactive UI.
 */
export type ConfigureModelsFn = (worktree: string, options?: ModelConfigureOptions) => Promise<ModelConfigurationResult>;
/**
 * Shared dependency lifecycle seam for `setup` (T017). Receives the same
 * executor plus the effective global config dir (`dirname(globalConfigPath)`,
 * shared with `depsSync`) and returns the shared lifecycle result. The
 * `aria setup` CLI always provides the real `runSetupDependencies` (direct
 * adapter invocation, no handoff); omitted preserves the pre-T017 behavior
 * for existing callers/tests.
 */
export type SetupDependenciesFn = (executor: Executor, configDir: string) => Promise<DependencyLifecycleResult>;
/**
 * Setup-visible projection of the shared dependency lifecycle outcome.
 */
export interface SetupDependenciesPhase {
    ok: boolean;
    outcomes: DependencyOutcome[];
    report: string;
}
/**
 * Options for `setup`. All fields are optional: omitting them preserves the
 * fully non-interactive `setup(binaryUrl, executor, depsSyncFn)` behavior.
 */
export interface SetupOptions {
    /** Request the optional model-configuration phase after registration and sync. */
    configure?: boolean;
    /** Worktree passed to model configuration (defaults to `process.cwd()`). */
    worktree?: string;
    /** Terminal input stream for interactive prompts (defaults to `process.stdin`). */
    input?: Readable;
    /** Terminal output stream for prompts (defaults to `process.stdout`). */
    output?: Writable;
    /** Explicit TTY override (defaults to `process.stdin.isTTY`). */
    tty?: boolean;
    /** Model-configuration seam (defaults to the real `configureModels`). */
    configureModelsFn?: ConfigureModelsFn;
    /**
     * T012 Git-package source (`aria setup --plugin-spec <spec>`): explicit
     * `opencode plugin add` package specifier (e.g.
     * `github:mscipio/ARIA#<EXACT_SHA>`). Used verbatim as the registration
     * argument and the config-file plugin identity — never rewritten to a
     * `file://` URI, never given `--global` (2.0.23 documents no such flag for
     * `plugin add`). Absent preserves the local-checkout behavior (absolute
     * checkout path, no `file://` scheme, no invented flags).
     */
    pluginSpec?: string;
    /**
     * T008 file-phase path overrides (all optional; omitted values resolve to
     * the production defaults: global `opencode.json`, global agents dir, and
     * the installed package skills root). Tests point these at temp dirs; no
     * workstation files are touched outside the resolved paths.
     */
    files?: SetupFilesOptions;
    /**
     * Shared dependency lifecycle seam (T017). When provided, `setup` invokes
     * it directly after the agent-file phase and before `depsSync` (install
     * if missing OR update if safely owned/outdated → normalize → validate,
     * no ARIA self-upgrade handoff). When omitted the phase is skipped and
     * `setup.dependencies` stays absent (pre-T017 behavior preserved).
     */
    dependenciesFn?: SetupDependenciesFn;
}
/**
 * Path overrides for the T008 setup file phases. Every field is optional;
 * omitted fields resolve to the production defaults.
 */
export interface SetupFilesOptions {
    /** Global V2 config path (defaults to `~/.config/opencode/opencode.json`). */
    globalConfigPath?: string;
    /** Managed agent directory (defaults to `~/.config/opencode/agents/`). */
    agentsDir?: string;
    /** Version-locked skills root (defaults to the installed package `skills/`). */
    skillsRoot?: string;
}
export interface CommandResult {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
export interface UpdateResult {
    git: {
        ok: boolean;
        error?: string;
    };
    npm: {
        ok: boolean;
        error?: string;
    };
    handoff: CommandResult & {
        error?: string;
    };
    /**
     * T002 identity-gate outcome for `update` (present only when the gate
     * ran). `ok:true` means the running checkout positively matched the
     * registered plugin (or registration was positively absent); `ok:false`
     * carries the fail-closed reason and no pull/npm/handoff mutation ran
     * beyond the read-only preconditions.
     */
    identity?: {
        ok: boolean;
        error?: string;
    };
}
/**
 * Resolve the checkout directory from a binary URL.
 * The binary is assumed to be at `<checkout>/bin/<name>`.
 */
declare function resolveCheckout(binaryUrl: string): Promise<string>;
declare function run(executor: Executor, cwd: string, command: string, ...args: string[]): Promise<CommandResult>;
/**
 * V2 `opencode plugin list` table entry (ID/VERSION/SOURCE columns).
 */
export interface PluginListEntry {
    id: string;
    version: string;
    /** SOURCE column: absolute local path for local plugins, package spec otherwise. */
    target: string;
}
/**
 * Parse V2 `opencode plugin list` output into table entries.
 * Recognized shapes: the `ID  VERSION  SOURCE` header followed by rows, or
 * the literal `No plugins found` (recognized empty). Anything else is
 * unrecognized (never guessed).
 */
declare function parsePluginList(output: string): {
    recognized: boolean;
    entries: PluginListEntry[];
};
/**
 * Exact core-version predicate for identity comparison. A leading `v`
 * (release-tag form) is accepted and stripped; anything that is not an
 * exact `X.Y.Z` core (with an optional prerelease/build suffix) is not
 * version evidence and is never compared. Short SHAs such as the plugin
 * list `842e4ec` and the `local` placeholder therefore stay unknown.
 */
export declare function normalizeIdentityVersion(raw: unknown): string | null;
/**
 * Exact version evidence carried by a plugin-list SOURCE reference: the
 * `#tag` suffix of a Git package specifier such as
 * `github:mscipio/ARIA#v1.0.7`. References without an exact tag (local
 * paths, bare specs) carry no version evidence and return null.
 */
export declare function pluginSpecTagVersion(target: string): string | null;
/**
 * T002 setup/update identity gate states (read-only classification, no
 * mutation). `matching` (exactly one registration for the intended target)
 * and `absent` (recognized list with no `aria` entry: deterministic
 * first-time bootstrap) allow the caller to proceed; every other state
 * fails closed before any `plugin add/remove`, file write, or sync:
 * - `mismatch`: at least one `aria` entry names a different source
 *   (definite mismatch, including exact-tag evidence when present);
 * - `ambiguous`: a duplicated `aria` registration (never guessed);
 * - `unknown`: the list probe failed or its output is unrecognized (never
 *   guessed; the compatibility fallback that once registered blindly is
 *   retired — callers must observe positive absence or an exact match).
 *
 * The only designed transition out of `mismatch` is the explicit
 * exact-target upgrade handoff (`aria upgrade --yes` via
 * `src/upgrade.ts`/`src/aria-upgrade.ts`); `setup()` never re-registers
 * over a conflicting entry.
 */
export type SetupIdentityGate = {
    kind: "matching";
    detail: string;
} | {
    kind: "absent";
    detail: string;
} | {
    kind: "mismatch";
    detail: string;
} | {
    kind: "ambiguous";
    detail: string;
} | {
    kind: "unknown";
    detail: string;
};
/**
 * True for a positively recognized ARIA Git source (approved prefix).
 * Exact-tag shape is not required here: any approved-source row proves an
 * existing registration exists, so bootstrap must not overwrite it (the
 * exact tag is validated separately by the upgrade handoff).
 */
export declare function isRecognizedAriaGitSource(target: string): boolean;
/**
 * T012 shared ARIA registration rule (single source for lifecycle gating
 * and doctor reporting). A plugin-list row is positively ARIA-identifying
 * when its ID is `aria` (any SOURCE, including local paths and foreign
 * specs) or its SOURCE is a positively recognized ARIA Git package
 * (approved `github:mscipio/ARIA#` prefix, any ID including TUI-only `-`
 * rows such as `- 842e4ec github:mscipio/ARIA#v1.0.7`). Exact-tag shape is
 * not required: any such row proves a registration exists, so it is never
 * classified absent (the exact tag is validated separately by the upgrade
 * handoff and the guarded doctor comparison).
 */
export declare function isAriaRegistrationEntry(entry: PluginListEntry): boolean;
/** Shared ARIA registration count: absent/single/ambiguous. */
export type AriaRegistrationKind = "absent" | "single" | "ambiguous";
export interface AriaRegistrationClassification {
    kind: AriaRegistrationKind;
    identifying: PluginListEntry[];
}
/**
 * T012 shared ARIA registration classification (pure, no mutation).
 * `isLocalMatch` optionally recognizes TUI-only local rows that name the
 * running checkout (lifecycle: `matchesIntended`; doctor:
 * `isSameLocalPluginIdentity(target, packageRoot)`). Exactly one
 * positively identified registration is `single`; zero is `absent`;
 * multiple/conflicting rows are `ambiguous` (never guessed).
 */
export declare function classifyAriaRegistration(entries: PluginListEntry[], isLocalMatch?: (target: string) => boolean): AriaRegistrationClassification;
/**
 * Classify the current plugin-list entries against the intended setup
 * registration target. `matchesIntended` is the exact setup matching rule
 * (verbatim `--plugin-spec` equality when given, otherwise the local
 * path/`file://` identity above, TUI `-` rows included via their SOURCE).
 * Pure: no executor, no mutation.
 *
 * T010: ARIA is identified by positively recognized source as well as ID.
 * A recognized Git-source row with any ID (including TUI-only `-`) is an
 * existing registration: when it does not match the intended target it is
 * a definite mismatch (never absent), so setup never bootstraps over it.
 *
 * T012: the ARIA-identifying set is shared with doctor via
 * `classifyAriaRegistration` (ID `aria` plus approved Git SOURCE, plus
 * TUI-local matches). Multiple/conflicting identifying rows are ambiguous
 * and fail closed: a matching local row plus a `- github:...` row,
 * duplicate matching Git/TUI rows, or any other multiple ARIA-identifying
 * rows are never accepted as a unique match.
 */
export declare function classifySetupIdentity(entries: PluginListEntry[], matchesIntended: (target: string) => boolean): SetupIdentityGate;
/**
 * T010 standalone-sync identity gate (read-only classification, no
 * mutation). The checkout running `aria deps sync` must positively match
 * the registered ARIA plugin (or registration must be positively absent)
 * before any dependency mutation runs. A definite mismatch, a duplicate,
 * or an unknown list (probe failure/unrecognized) fails closed with no
 * sync; the only designed transition between releases is the explicit
 * exact-target `aria upgrade --yes` handoff. Mirrors the `update()`
 * identity gate (matching/absent allow, all else blocks) so sync, setup,
 * and update can never diverge.
 */
export declare function gateStandaloneSync(executor: Executor, binaryUrl: string): Promise<{
    ok: true;
    detail: string;
} | {
    ok: false;
    detail: string;
}>;
/**
 * Parse the `opencode debug info` output to find registered plugin URIs.
 *
 * @deprecated V1-only. `debug info` does not exist on pinned OpenCode 2.0.23
 * (`debug --help` lists agents/config/paths only; `debug info` fails with
 * `Unknown subcommand "info"`). Kept exported for existing unit coverage;
 * setup now uses {@link parsePluginList} (`opencode plugin list`) plus
 * direct config-file truth and never invokes `debug info`.
 */
declare function parsePluginSpecifiers(output: string): {
    recognized: boolean;
    specifiers: string[];
};
export declare function setup(binaryUrl: string, executor?: Executor, depsSyncFn?: typeof depsSync, options?: SetupOptions): Promise<LifecycleResult>;
export declare function update(binaryUrl: string, executor?: Executor): Promise<LifecycleResult>;
export { resolveCheckout, parsePluginSpecifiers, parsePluginList, run as runInCheckout };
//# sourceMappingURL=lifecycle.d.ts.map