/**
 * Bound for the runtime-list read only. `attempts` caps total polls (first
 * read plus retries); `delayMs` separates retries. Both injectable so tests
 * use a fake delay with no real sleeps. Persisted verification never uses
 * this bound (single read, no sleep).
 */
export interface ListConvergenceBound {
    attempts?: number;
    delayMs?: number;
}
/** Injectable clock: real `setTimeout` in production, a recorder in tests. */
export type DelayFn = (ms: number) => Promise<void>;
export declare function defaultDelay(ms: number): Promise<void>;
/**
 * Default bound: 3 polls/100ms — 1 initial read plus 2 retries, 200ms
 * worst-case added latency (sub-second total). The smallest proven bound
 * (MCP 3x100ms reference); chosen because the persisted read is
 * authoritative, so the runtime poll is best-effort convergence only.
 */
export declare const DEFAULT_LIST_CONVERGENCE: Required<ListConvergenceBound>;
/** Exact-match style check (mirrors the `verifySingleRegistration` shape). */
export type ConvergenceCheck = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export interface ListPollResult<T> {
    /** Last observed sample (null when unavailable/unrecognized). */
    value: T | null;
    /** Polls actually performed (1-based count of `observe` calls). */
    polls: number;
    converged: boolean;
    reason: string | null;
}
/**
 * Bounded runtime-list poll: returns the first sample `isConverged`
 * accepts, else the last sample once the bound is exhausted. A null sample
 * (unavailable/unrecognized output, or an `observe` throw) never converges
 * — malformed output fails closed and is never treated as not-present.
 * Callers fail closed on exhaustion (validation-failed + rollback) or apply
 * their documented stale policy; retries repeat observation only, never
 * mutation.
 */
export declare function pollListConvergence<T>(observe: () => Promise<T | null>, isConverged: (value: T) => ConvergenceCheck, bound?: ListConvergenceBound, delay?: DelayFn): Promise<ListPollResult<T>>;
/**
 * Persisted-state read for the persisted-first step. `ambiguous` (dual
 * `opencode.json` + `opencode.jsonc`, conflicting containers) and
 * `unreadable` (missing/unparseable/probe failure) both fail closed with
 * zero runtime-list samples.
 */
export type PersistedRead<T> = {
    kind: "ok";
    value: T;
} | {
    kind: "ambiguous";
    reason: string;
} | {
    kind: "unreadable";
    reason: string;
};
export type PersistedThenConverged<TPersisted, TRuntime> = 
/** Genuine persisted failure: no list sample was taken (`polls` is 0). */
{
    outcome: "persisted-failed";
    reason: string;
    polls: number;
}
/** Persisted verified AND the runtime list converged within the bound. */
 | {
    outcome: "converged";
    persisted: TPersisted;
    runtime: TRuntime;
    polls: number;
}
/**
 * Persisted verified but the runtime list stayed stale past the bound.
 * The caller applies its documented policy: strict install/upgrade paths
 * keep validation-failed + rollback (exhaustion still rolls back); the
 * already-safe ARIA handoff path instead proceeds with a staleness note
 * because persisted state is authoritative there.
 */
 | {
    outcome: "persisted-ok-runtime-stale";
    persisted: TPersisted;
    runtime: TRuntime | null;
    polls: number;
    reason: string | null;
};
/**
 * Persisted-first post-mutation verification: one synchronous persisted
 * read (no retry, no sleep), then bounded runtime-list convergence. A
 * `readPersisted` throw is a persisted failure (fail-closed), never a list
 * sample. Enforces mutation -> persisted-state verification -> bounded
 * runtime-list convergence, never mutation -> single runtime-list sample.
 */
export declare function verifyPersistedThenConverge<TPersisted, TRuntime>(readPersisted: () => Promise<PersistedRead<TPersisted>>, verifyPersisted: (value: TPersisted) => ConvergenceCheck, observe: () => Promise<TRuntime | null>, isConverged: (value: TRuntime) => ConvergenceCheck, bound?: ListConvergenceBound, delay?: DelayFn): Promise<PersistedThenConverged<TPersisted, TRuntime>>;
//# sourceMappingURL=list-convergence.d.ts.map