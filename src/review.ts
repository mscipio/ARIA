/**
 * Review state for one root session (a delegation tree). Pure data and transitions; index.ts feeds
 * it from OpenCode tool hooks and stores it in the root session's metadata (native, durable).
 *
 * What it records is observed, not inferred:
 *   - changes:   completed edit/write/patch calls by non-reviewer agents (plan and scratch files
 *                excluded) and shell commands (which may change files invisibly to the tools)
 *   - requests:  subagent calls that started `reviewer`
 *   - verdicts:  structured results the reviewer itself recorded with `aria_review_verdict`
 * It never parses model text. Whether a change NEEDED review is a judgement left to the agents;
 * this only makes the state of review visible and impossible to fake by assertion.
 */

export type Outcome = "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE";

export interface Finding {
  readonly summary: string;
  readonly location?: string;
}

export interface Review {
  /** Reviewer session id (unique per review). */
  readonly id: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** Change counter when the review started: later changes make it stale. */
  readonly atChange: number;
  /** Shell activity is counted conservatively, not asserted to be a filesystem edit. */
  readonly atShell?: number;
  readonly outcome?: Outcome;
  readonly scope?: string;
  readonly blocking?: readonly Finding[];
  readonly missingEvidence?: readonly string[];
  readonly nonBlocking?: number;
  readonly completedAt?: string;
}

export interface ReviewState {
  /** Root session this record belongs to; a copy inherited by a child or fork is ignored elsewhere. */
  readonly root: string;
  readonly changes: number;
  readonly shell: number;
  /** Changed paths (latest 40), for the reviewer brief and status display. */
  readonly paths: readonly string[];
  readonly reviews: readonly Review[];
  /** Retained independently of the bounded attempt history until a subsequent review passes. */
  readonly failure?: Review;
}

export const META_KEY = "aria_review";
const MAX_PATHS = 40;
const MAX_REVIEWS = 10;

export const emptyReview = (root: string): ReviewState => ({ root, changes: 0, shell: 0, paths: [], reviews: [] });

/** Read a stored record, rejecting one that belongs to another root (inherited by a fork or child). */
export function fromMetadata(meta: unknown, root: string): ReviewState {
  const value = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[META_KEY] : undefined;
  if (!value || typeof value !== "object") return emptyReview(root);
  const s = value as ReviewState;
  if (s.root !== root || !Array.isArray(s.reviews) || typeof s.changes !== "number") return emptyReview(root);
  return s;
}

const EXCLUDED = /(^|\/)\.aria\/(plans|scratch)\//;

export function onEdit(s: ReviewState, path: string): ReviewState {
  const p = path.replaceAll("\\", "/");
  if (EXCLUDED.test(p)) return s;
  return { ...s, changes: s.changes + 1, paths: [...s.paths.filter((x) => x !== p), p].slice(-MAX_PATHS) };
}

export function onShell(s: ReviewState): ReviewState {
  return { ...s, changes: s.changes + 1, shell: s.shell + 1 };
}

/** A reviewer launch, or a follow-up to an existing reviewer session (a re-review gets its own entry). */
export function onRequest(s: ReviewState, session: string, requestedBy: string, at = new Date().toISOString()): ReviewState {
  const attempts = s.reviews.filter((r) => r.id === session || r.id.startsWith(`${session}#`));
  const prior = Math.max(0, ...attempts.map((r) => r.id === session ? 1 : Number(r.id.slice(session.length + 1)) || 1));
  const id = prior === 0 ? session : `${session}#${prior + 1}`;
  return { ...s, failure: unresolvedFailure(s), reviews: [...s.reviews, { id, requestedBy, requestedAt: at, atChange: s.changes, atShell: s.shell }].slice(-MAX_REVIEWS) };
}

/** Also recovers failures from metadata written before the separate failure field existed. */
function unresolvedFailure(s: ReviewState): Review | undefined {
  if (s.failure) return s.failure;
  for (const r of [...s.reviews].reverse()) {
    if (r.outcome === "PASS") return undefined;
    if (r.outcome === "FAIL") return r;
  }
  return undefined;
}

export interface Verdict {
  readonly outcome: Outcome;
  readonly scope: string;
  readonly blocking: readonly Finding[];
  readonly missingEvidence: readonly string[];
  readonly nonBlocking: number;
}

/**
 * Record a verdict from reviewer session `session`: it completes that session's latest open review.
 * A verdict with no matching launch (e.g. a reviewer started outside ARIA's view) is recorded as a
 * review requested by "unknown" at the current change count.
 */
export function onVerdict(s: ReviewState, session: string, v: Verdict, at = new Date().toISOString()): ReviewState {
  const mine = (r: Review) => r.id === session || r.id.startsWith(`${session}#`);
  let target = [...s.reviews].reverse().find((r) => mine(r) && !r.outcome);
  let base = s;
  if (!target) {
    base = onRequest(s, session, "unknown", at);
    target = base.reviews.at(-1) as Review;
  }
  const id = target.id;
  const completed = { ...target, outcome: v.outcome, scope: v.scope, blocking: v.blocking, missingEvidence: v.missingEvidence, nonBlocking: v.nonBlocking, completedAt: at };
  let failure = unresolvedFailure(base);
  if (v.outcome === "FAIL") failure = completed;
  else if (v.outcome === "PASS" && failure && target.requestedAt >= (failure.completedAt ?? failure.requestedAt)) failure = undefined;
  return {
    ...base,
    failure,
    reviews: base.reviews.map((r) => (r.id === id ? completed : r)),
  };
}

export type Disposition = "none" | "requested" | "passed" | "failed" | "insufficient" | "stale";

export interface Summary {
  readonly disposition: Disposition;
  /** Changes made after the latest review started. */
  readonly changedSince: number;
  readonly shellSince?: number;
  readonly unresolvedBlocking: number;
  readonly latest?: Review;
  readonly line: string;
}

/**
 * The latest review decides the disposition. A verdict is stale once anything changed after the
 * review started; a FAIL stays failed until a later review passes (fixing code does not resolve it).
 */
export function summarize(s: ReviewState): Summary {
  const attempt = s.reviews.at(-1);
  const failure = unresolvedFailure(s);
  const latest = failure ?? attempt;
  if (!latest) {
    return { disposition: "none", changedSince: s.changes, shellSince: s.shell, unresolvedBlocking: 0, line: s.changes ? `no independent review recorded; ${s.changes} observed change(s) in this session${s.shell ? ` (includes ${s.shell} shell command(s); filesystem changes not checked)` : ""}` : "no changes, no review" };
  }
  const changedSince = s.changes - latest.atChange;
  const shellSince = latest.atShell === undefined ? undefined : Math.max(0, s.shell - latest.atShell);
  const blocking = latest.outcome === "FAIL" ? (latest.blocking?.length ?? 0) : 0;
  let disposition: Disposition;
  if (!latest.outcome) disposition = "requested";
  else if (latest.outcome === "FAIL") disposition = "failed";
  else if (changedSince > 0) disposition = "stale";
  else disposition = latest.outcome === "PASS" ? "passed" : "insufficient";
  const what = {
    requested: "independent review requested, no verdict recorded yet",
    failed: `independent review FAIL: ${blocking} blocking finding(s) unresolved until a re-review passes`,
    stale: `independent review ${latest.outcome} is stale: ${changedSince} change(s) since it started`,
    passed: "independent review PASS for the current changes",
    insufficient: `independent review INSUFFICIENT EVIDENCE: ${latest.missingEvidence?.join("; ") || "evidence missing"}`,
    none: "",
  }[disposition];
  const pending = failure && attempt !== failure && !attempt?.outcome ? "; re-review requested" : "";
  return { disposition, changedSince, shellSince, unresolvedBlocking: blocking, latest, line: `${what}${disposition !== "stale" && changedSince > 0 && disposition !== "passed" ? `; ${changedSince} observed change(s) since` : ""}${shellSince ? ` (includes ${shellSince} shell command(s); filesystem changes not checked)` : ""}${pending}` };
}

/** Validate the verdict tool input. */
export function parseVerdict(input: unknown): Verdict {
  const v = (input ?? {}) as Record<string, unknown>;
  const outcome = v.outcome;
  if (outcome !== "PASS" && outcome !== "FAIL" && outcome !== "INSUFFICIENT_EVIDENCE") throw new Error("outcome must be PASS, FAIL or INSUFFICIENT_EVIDENCE");
  const findings = (Array.isArray(v.blocking) ? v.blocking : []).map((f) => {
    const x = (f ?? {}) as Record<string, unknown>;
    if (typeof x.summary !== "string" || !x.summary.trim()) throw new Error("each blocking finding needs a summary");
    return { summary: x.summary.slice(0, 300), ...(typeof x.location === "string" ? { location: x.location.slice(0, 200) } : {}) };
  });
  const missing = (Array.isArray(v.missingEvidence) ? v.missingEvidence : []).filter((m): m is string => typeof m === "string").map((m) => m.slice(0, 300));
  if (outcome === "FAIL" && findings.length === 0) throw new Error("FAIL needs at least one blocking finding");
  if (outcome === "PASS" && findings.length > 0) throw new Error("PASS cannot have blocking findings; use FAIL");
  if (outcome === "INSUFFICIENT_EVIDENCE" && missing.length === 0) throw new Error("INSUFFICIENT_EVIDENCE needs missingEvidence");
  return { outcome, scope: typeof v.scope === "string" ? v.scope.slice(0, 500) : "", blocking: findings.slice(0, 20), missingEvidence: missing.slice(0, 10), nonBlocking: typeof v.nonBlocking === "number" ? Math.max(0, Math.trunc(v.nonBlocking)) : 0 };
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["PASS", "FAIL", "INSUFFICIENT_EVIDENCE"], description: "Overall result for the reviewed scope." },
    scope: { type: "string", description: "What you actually examined (files, diff, requirements)." },
    blocking: {
      type: "array",
      description: "Blocking findings (required for FAIL, empty for PASS).",
      items: { type: "object", properties: { summary: { type: "string" }, location: { type: "string", description: "path:line or diff hunk" } }, required: ["summary"], additionalProperties: false },
    },
    missingEvidence: { type: "array", items: { type: "string" }, description: "For INSUFFICIENT_EVIDENCE: what is missing and how to obtain it." },
    nonBlocking: { type: "integer", description: "Number of non-blocking suggestions in your report." },
  },
  required: ["outcome", "scope"],
  additionalProperties: false,
} as const;
