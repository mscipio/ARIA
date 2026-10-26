import { type Executor } from "./deps.js";
import { type PluginListEntry } from "./lifecycle.js";
import { type AriaAvailableTarget, type SelfUpgradeOutcome, type UpgradeContinuationOptions, type UpgradeContinuationResult, type UpgradeHandoff } from "./upgrade.js";
/** Plugin-list ID of the ARIA registration. */
export declare const ARIA_PLUGIN_ID = "aria";
export type AriaRegistrationDetection = {
    kind: "identified";
    spec: string;
    ref: string;
    version: string | null;
    entries: PluginListEntry[];
} | {
    kind: "unknown";
    reason: string;
} | {
    kind: "ambiguous";
    reason: string;
} | {
    kind: "unsupported";
    reason: string;
};
/**
 * Classify ARIA registrations from `opencode plugin list` output. Exactly
 * one ARIA-identifying row (shared T012 `isAriaRegistrationEntry` rule,
 * never deduplicated before the uniqueness decision) with an exact
 * `vX.Y.Z`-tag or 40-hex-SHA ref identifies; zero ARIA entries, multiple
 * rows (including duplicate identical specs), a conflicting non-Git `aria`
 * id, or an inexact ref (branch, moving tag, short SHA) fails closed.
 * Pure: no executor, no mutation.
 */
export declare function classifyAriaRegistration(stdout: string): AriaRegistrationDetection;
/** Read-only current-registration probe (`opencode plugin list`; never mutates). */
export declare function detectAriaRegistration(executor: Executor): Promise<AriaRegistrationDetection>;
export type PersistedPluginRead = {
    kind: "ok";
    path: string;
    specs: string[];
} | {
    kind: "ambiguous";
    reason: string;
    path?: string;
} | {
    kind: "unreadable";
    reason: string;
    path?: string;
};
export type PersistedReader = () => Promise<PersistedPluginRead>;
export interface ListConvergenceBound {
    attempts?: number;
    delayMs?: number;
}
export interface HandoffSpawnResult {
    ok: boolean;
    detail: string;
    stdout: string;
    /** Set when target-owned continuation began, even if it stopped or threw. */
    continuationStarted?: boolean;
    /** Exact result when target-owned continuation returned normally. */
    continuationResult?: UpgradeContinuationResult;
}
/**
 * One-shot handoff spawn: invoke the exact installed release (addressed by
 * its immutable spec, the only stable handle — the npm cache layout is
 * content-addressed) with the serialized handoff payload. The payload is
 * JSON (a process-boundary snapshot: later caller mutations cannot alter
 * what was sent). Git-capable (`npm exec` fetches the spec), so the
 * per-call git allowlist travels here too.
 */
export type HandoffSpawnFn = (handoff: UpgradeHandoff, target: AriaAvailableTarget) => Promise<HandoffSpawnResult>;
/**
 * T003 dispatcher analysis (no launcher needed).
 *
 * `bin/aria.mjs` dispatches `upgrade` (and `--handoff-json`) by importing
 * `../dist/upgrade.js` / `../dist/aria-upgrade.js` relative to its own
 * location, so the code that runs is always the `aria` binary's own
 * release. `npm exec --yes --package <spec> -- aria ...` (equivalently
 * `npx --yes --package <spec> -- aria ...`) therefore selects the release
 * by resolving the `aria` binary from the named exact Git spec; the `--`
 * boundary keeps the `aria ...` argv (including `--handoff-json <payload>`
 * or `--yes`) from being parsed as npm options, and `--package <spec>`
 * never names a local path or a bare `aria`. No separate launcher file is
 * added: the existing dispatcher plus the exact-spec spawn is the whole
 * mechanism. Pure builder below carries the boundary contract.
 */
/**
 * Pure argv for the one-shot handoff spawn (no executor, no mutation):
 * `exec --yes --package <target.spec> -- aria upgrade --handoff-json
 * <payload>`. The caller prefixes `npm`; `npx` accepts the same trailing
 * boundary.
 */
export declare function buildHandoffSpawnArgv(target: AriaAvailableTarget, payloadJson: string): string[];
export declare function makeDefaultHandoffSpawn(executor: Executor): HandoffSpawnFn;
export interface AriaSelfUpgradeOptions {
    executor?: Executor;
    /** One-shot new-release handoff transport (default: npm-exec the exact spec). */
    handoffSpawn?: HandoffSpawnFn;
    /**
     * T002 persisted-config seam: explicit global config path for isolated
     * HOME/XDG fixtures and deterministic tests (default: canonical
     * `defaultGlobalConfigPath()` discovery). Never a launcher or publisher.
     */
    globalConfigPath?: string;
    /**
     * T002 injectable persisted reader (default: filesystem read at
     * `globalConfigPath` via `readPersistedPluginSpecs`). Tests inject an
     * in-memory synchronous-persist view; production reads the authoritative
     * `opencode.json(c)` without arbitrary sleep.
     */
    readPersistedPlugins?: PersistedReader;
    /**
     * T002 injectable delay for list-convergence backoff only (default:
     * real `setTimeout`). Tests inject a no-op counter; the persisted path
     * never sleeps.
     */
    delay?: (ms: number) => Promise<void>;
    /**
     * T002 bounded list-convergence bound (default 5 polls/~5s: 1s delay).
     * Applies ONLY to the runtime `list` surface T001 proved eventually
     * consistent; persisted verification has no retry/sleep.
     */
    listConvergence?: ListConvergenceBound;
    /** Isolated config/read-only doctor options for an installed-target continuation. */
    continuationOptions?: Pick<UpgradeContinuationOptions, "configDir" | "doctorFn">;
    /**
     * T003 explicit-from gate for the newer-CLI migrate path
     * (`migrateAriaFromExact` sets this to the operator-approved
     * `--migrate-from` spec): the detected registration must exactly equal
     * it AND the persisted config must agree, before any mutation. Absent on
     * the normal path (no behavior change there).
     */
    expectedFromSpec?: string;
}
/**
 * T011 self-upgrade: exact-ref remove/replace/re-register plus the one-shot
 * handoff. Matches the T010 `SelfUpgradeFn` seam `(target, handoff)` with an
 * optional third options argument. On handoff success this function returns
 * WITHOUT any further normalization, regen, sync, doctor, or reporting —
 * the new release owns the remainder. `plugin update` is never invoked.
 */
export declare function selfUpgradeAria(target: AriaAvailableTarget, handoff: UpgradeHandoff, options?: AriaSelfUpgradeOptions): Promise<SelfUpgradeOutcome>;
/**
 * New-release handoff receiver (invoked as
 * `aria upgrade --handoff-json <payload>` by the old release's one-shot
 * spawn). Parses the payload, binds the receiving release's own exact
 * version as the actual target, and continues ONLY on an exact handoff
 * match via the T010 sequence (`continueUpgradeInNewRelease`, wired in,
 * never duplicated). Any drift, malformed payload, or inexact own version
 * stops for fresh approval with zero mutation.
 */
export declare function receiveUpgradeHandoff(payloadJson: string, ownVersion: string, options?: UpgradeContinuationOptions): Promise<UpgradeContinuationResult>;
/**
 * Migrate an exact installed registration (`--migrate-from`) to this
 * release's own exact target using the CURRENT code paths only: shape
 * gates, then the shared remove→add→persisted-verify→bounded-list-converge
 * transition (`selfUpgradeAria` with the explicit-from gate), then the
 * caller continues the normal post-handoff pipeline in-process.
 *
 * Already in the newer release, so there is no handoff spawn of any
 * release (old or new): the default transport is an in-process
 * continuation ack carrying the exact tag (an explicit `handoffSpawn`
 * seam, e.g. in tests, still wins). `plugin update` is never invoked and
 * this module writes no files.
 */
export declare function migrateAriaFromExact(fromSpec: string, target: AriaAvailableTarget, handoff: UpgradeHandoff, options?: AriaSelfUpgradeOptions): Promise<SelfUpgradeOutcome>;
//# sourceMappingURL=aria-upgrade.d.ts.map