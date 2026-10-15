import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIST_CONVERGENCE,
  pollListConvergence,
  verifyPersistedThenConverge,
  type ConvergenceCheck,
  type PersistedRead,
} from "../src/list-convergence.js";

// ---------------------------------------------------------------------------
// T002 shared list-convergence seam: deterministic contract checks.
//
// Fake observe queue (scripted runtime-list samples) + fake delay recorder:
// zero real sleeps. Covers the seam contract T003 builds on — immediate
// visibility without extra polling, stale→visible convergence, exact-bound
// exhaustion, malformed (null) fail-closed, persisted-failure short-circuit
// with zero list samples, and the persisted-ok-but-stale outcome carrying
// enough evidence for the caller's rollback/staleness-note policy.
// ---------------------------------------------------------------------------

const EXPECTED = "@slkiser/opencode-quota@5.0.2";

function isExpected(sample: string[]): ConvergenceCheck {
  return sample.includes(EXPECTED)
    ? { ok: true }
    : { ok: false, reason: `expected ${EXPECTED} in [${sample.join(", ")}]` };
}

function scriptedObserve(script: Array<string[] | null>, calls: { count: number }): () => Promise<string[] | null> {
  return async () => {
    calls.count++;
    const next = script.shift();
    return next === undefined ? null : next;
  };
}

function delayRecorder(delays: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    delays.push(ms);
  };
}

function persistedOk(specs: string[]): () => Promise<PersistedRead<string[]>> {
  return async () => ({ kind: "ok", value: specs });
}

function verifyPersistedHasExpected(specs: string[]): ConvergenceCheck {
  return specs.includes(EXPECTED) ? { ok: true } : { ok: false, reason: `persisted config carries no quota entry for ${EXPECTED}` };
}

describe("pollListConvergence", () => {
  it("converges on the first poll with zero delays when immediately visible", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const result = await pollListConvergence(scriptedObserve([[EXPECTED]], calls), isExpected, {}, delayRecorder(delays));
    expect(result.converged).toBe(true);
    expect(result.polls).toBe(1);
    expect(calls.count).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries observation within the bound until stale samples converge", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const result = await pollListConvergence(
      scriptedObserve([[], [], [EXPECTED]], calls),
      isExpected,
      { attempts: 3, delayMs: 100 },
      delayRecorder(delays),
    );
    expect(result.converged).toBe(true);
    expect(result.polls).toBe(3);
    expect(calls.count).toBe(3);
    expect(delays).toEqual([100, 100]);
  });

  it("exhausts at the exact bound with sub-second added latency", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const result = await pollListConvergence(
      scriptedObserve([[], [], []], calls),
      isExpected,
      { attempts: 3, delayMs: 100 },
      delayRecorder(delays),
    );
    expect(result.converged).toBe(false);
    expect(result.polls).toBe(3);
    expect(calls.count).toBe(3);
    expect(delays).toEqual([100, 100]);
    expect((DEFAULT_LIST_CONVERGENCE.attempts - 1) * DEFAULT_LIST_CONVERGENCE.delayMs).toBeLessThan(1000);
  });

  it("fails closed on malformed/unavailable output without consulting the predicate", async () => {
    const calls = { count: 0 };
    let predicateCalls = 0;
    const delays: number[] = [];
    const result = await pollListConvergence(
      scriptedObserve([null, null, null], calls),
      (sample: string[]) => {
        predicateCalls++;
        return isExpected(sample);
      },
      { attempts: 3, delayMs: 100 },
      delayRecorder(delays),
    );
    expect(result.converged).toBe(false);
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/unavailable or unrecognized/);
    expect(predicateCalls).toBe(0);
    expect(calls.count).toBe(3);
  });
});

describe("verifyPersistedThenConverge", () => {
  it("short-circuits persisted failure with zero runtime-list samples", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const outcome = await verifyPersistedThenConverge<string[], string[]>(
      async () => ({ kind: "ambiguous", reason: "both opencode.json and opencode.jsonc exist" }),
      verifyPersistedHasExpected,
      scriptedObserve([[EXPECTED]], calls),
      isExpected,
      {},
      delayRecorder(delays),
    );
    expect(outcome.outcome).toBe("persisted-failed");
    expect(outcome.polls).toBe(0);
    expect(calls.count).toBe(0);
    expect(delays).toEqual([]);
  });

  it("treats a throwing persisted probe as persisted failure with zero samples", async () => {
    const calls = { count: 0 };
    const outcome = await verifyPersistedThenConverge<string[], string[]>(
      async () => {
        throw new Error("EACCES");
      },
      verifyPersistedHasExpected,
      scriptedObserve([[EXPECTED]], calls),
      isExpected,
      {},
      async () => {},
    );
    expect(outcome.outcome).toBe("persisted-failed");
    expect(outcome.polls).toBe(0);
    expect(calls.count).toBe(0);
  });

  it("converges persisted-first then runtime within the bound", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const outcome = await verifyPersistedThenConverge(
      persistedOk([EXPECTED, "other@1.0.0"]),
      verifyPersistedHasExpected,
      scriptedObserve([[], [EXPECTED]], calls),
      isExpected,
      { attempts: 3, delayMs: 100 },
      delayRecorder(delays),
    );
    expect(outcome.outcome).toBe("converged");
    if (outcome.outcome === "converged") {
      expect(outcome.persisted).toEqual([EXPECTED, "other@1.0.0"]);
      expect(outcome.runtime).toEqual([EXPECTED]);
      expect(outcome.polls).toBe(2);
    }
    expect(delays).toEqual([100]);
  });

  it("surfaces persisted-ok-but-stale distinctly for the caller rollback policy", async () => {
    const calls = { count: 0 };
    const delays: number[] = [];
    const outcome = await verifyPersistedThenConverge(
      persistedOk([EXPECTED]),
      verifyPersistedHasExpected,
      scriptedObserve([[], []], calls),
      isExpected,
      { attempts: 2, delayMs: 100 },
      delayRecorder(delays),
    );
    expect(outcome.outcome).toBe("persisted-ok-runtime-stale");
    if (outcome.outcome === "persisted-ok-runtime-stale") {
      expect(outcome.persisted).toEqual([EXPECTED]);
      expect(outcome.polls).toBe(2);
      expect(outcome.reason).not.toBeNull();
    }
    expect(calls.count).toBe(2);
    expect(delays).toEqual([100]);
  });
});
