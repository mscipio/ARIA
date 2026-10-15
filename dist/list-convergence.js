// ---------------------------------------------------------------------------
// T002 — Shared bounded OpenCode list-convergence seam.
//
// ONE shared primitive for post-mutation runtime-list verification, built on
// the T001-proven patterns instead of another bespoke retry:
// - `pollListConvergence` in `src/aria-upgrade.ts` (bounded plugin-list
//   convergence with injectable delay, default 5 polls/1000ms) plus its
//   persisted-first model (authoritative `opencode.json(c)` read, then
//   bounded list convergence);
// - `pollMcpConnectivity` in `src/engram.ts` (bounded `opencode mcp list`
//   read, default 3 polls/100ms with injectable delay).
//
// Contract:
// - Bounded attempts with sub-second/small total added latency. The default
//   is the smallest proven bound (3 polls/100ms: 1 initial read + 2 retries,
//   200ms worst-case added latency). The ARIA plugin path keeps its own
//   longer bound; nothing here lengthens any sleep to solve staleness
//   (binding rule: persisted-first, then bounded poll of the eventually
//   consistent list surface).
// - Injectable `observe` (wraps the Executor list call) and `delay` seams,
//   so deterministic tests use fakes with zero real sleeps.
// - Malformed/ambiguous output fails closed: `observe` returns null when the
//   list is unavailable or unrecognized, and null never counts as converged
//   (never treated as not-present). An `observe` throw is likewise a null
//   sample, never success.
// - No unbounded polling (attempts clamp to >= 1, non-finite bounds fall
//   back to the default) and no arbitrary fixed sleeps (the delay runs only
//   between retries, never on the persisted path).
// - Persisted-first ordering via `verifyPersistedThenConverge`: mutation ->
//   single persisted-state verification (no retry, no sleep) -> bounded
//   runtime-list convergence -> outcome. A genuine persisted failure returns
//   before any list sample (zero polls); callers preserve rollback after a
//   persisted failure or convergence exhaustion (existing semantics).
//
// Scope: seam only (T003 wires call sites). T003 applies this to
// `installQuotaIfMissing` (quota plugin-list surface + persisted
// global-config quota entry) and only the T001-proven equivalents
// (CodeGraph/ZotPilot MCP surfaces + persisted V2 registration):
// persisted-failed -> validation-failed + rollback; converged -> success;
// persisted-ok-but-stale -> caller policy (strict paths keep
// validation-failed + rollback, so a stale first sample retries within the
// bound instead of rolling back immediately). Already-safe ARIA/Engram
// paths keep their own helpers, untouched.
// ---------------------------------------------------------------------------
export function defaultDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Default bound: 3 polls/100ms — 1 initial read plus 2 retries, 200ms
 * worst-case added latency (sub-second total). The smallest proven bound
 * (MCP 3x100ms reference); chosen because the persisted read is
 * authoritative, so the runtime poll is best-effort convergence only.
 */
export const DEFAULT_LIST_CONVERGENCE = { attempts: 3, delayMs: 100 };
/**
 * Bounded runtime-list poll: returns the first sample `isConverged`
 * accepts, else the last sample once the bound is exhausted. A null sample
 * (unavailable/unrecognized output, or an `observe` throw) never converges
 * — malformed output fails closed and is never treated as not-present.
 * Callers fail closed on exhaustion (validation-failed + rollback) or apply
 * their documented stale policy; retries repeat observation only, never
 * mutation.
 */
export async function pollListConvergence(observe, isConverged, bound = {}, delay = defaultDelay) {
    const rawAttempts = bound.attempts ?? DEFAULT_LIST_CONVERGENCE.attempts;
    const rawDelayMs = bound.delayMs ?? DEFAULT_LIST_CONVERGENCE.delayMs;
    const total = Number.isFinite(rawAttempts) ? Math.max(1, Math.floor(rawAttempts)) : DEFAULT_LIST_CONVERGENCE.attempts;
    const waitMs = Number.isFinite(rawDelayMs) ? Math.max(0, rawDelayMs) : DEFAULT_LIST_CONVERGENCE.delayMs;
    let lastValue = null;
    let lastReason = null;
    for (let poll = 1; poll <= total; poll++) {
        if (poll > 1)
            await delay(waitMs);
        let sample = null;
        try {
            sample = await observe();
        }
        catch {
            sample = null;
        }
        if (sample !== null) {
            const checked = isConverged(sample);
            if (checked.ok)
                return { value: sample, polls: poll, converged: true, reason: null };
            lastValue = sample;
            lastReason = checked.reason;
        }
        else {
            lastValue = null;
            lastReason = "runtime list unavailable or unrecognized; malformed output fails closed (never treated as not-present)";
        }
    }
    return { value: lastValue, polls: total, converged: false, reason: lastReason };
}
/**
 * Persisted-first post-mutation verification: one synchronous persisted
 * read (no retry, no sleep), then bounded runtime-list convergence. A
 * `readPersisted` throw is a persisted failure (fail-closed), never a list
 * sample. Enforces mutation -> persisted-state verification -> bounded
 * runtime-list convergence, never mutation -> single runtime-list sample.
 */
export async function verifyPersistedThenConverge(readPersisted, verifyPersisted, observe, isConverged, bound = {}, delay = defaultDelay) {
    let persisted;
    try {
        persisted = await readPersisted();
    }
    catch (error) {
        return {
            outcome: "persisted-failed",
            reason: `persisted state probe threw (${error instanceof Error ? error.message : String(error)}); failing closed with zero runtime-list samples`,
            polls: 0,
        };
    }
    if (persisted.kind !== "ok") {
        return { outcome: "persisted-failed", reason: persisted.reason, polls: 0 };
    }
    const checked = verifyPersisted(persisted.value);
    if (!checked.ok) {
        return { outcome: "persisted-failed", reason: checked.reason, polls: 0 };
    }
    const poll = await pollListConvergence(observe, isConverged, bound, delay);
    if (poll.converged && poll.value !== null) {
        return { outcome: "converged", persisted: persisted.value, runtime: poll.value, polls: poll.polls };
    }
    return { outcome: "persisted-ok-runtime-stale", persisted: persisted.value, runtime: poll.value, polls: poll.polls, reason: poll.reason };
}
//# sourceMappingURL=list-convergence.js.map