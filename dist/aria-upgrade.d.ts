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
export interface HandoffSpawnResult {
    ok: boolean;
    detail: string;
    stdout: string;
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
//# sourceMappingURL=aria-upgrade.d.ts.map