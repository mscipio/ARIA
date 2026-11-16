/** Structured results shared by the CLI (text or --json) and the management TUI. */

export type Health =
  | "healthy"
  | "missing"
  | "disabled"
  | "outdated"
  | "incompatible"
  | "config-error"
  | "runtime-error"
  | "unverified";

/** How a status was established. `static` never proves that something works at run time. */
export type Evidence = "static" | "runtime" | "none";

export interface Check {
  readonly id: string;
  readonly component: string;
  readonly status: Health;
  readonly basis: Evidence;
  /** One line: what is wrong or what is fine. */
  readonly summary: string;
  /** Facts the diagnosis rests on (paths, versions, command output excerpts). */
  readonly evidence: readonly string[];
  readonly repair?: Repair;
}

export interface Repair {
  readonly id: string;
  readonly automatic: boolean;
  /** What applying it changes. Empty means it changes nothing ARIA can do automatically. */
  readonly changes: readonly string[];
  readonly network?: boolean;
  /** Command to apply it non-interactively. */
  readonly command?: string;
}

export interface Change {
  readonly kind: "config" | "install" | "release" | "activate" | "cleanup" | "state";
  readonly target: string;
  readonly summary: string;
  readonly detail?: readonly string[];
  readonly network?: boolean;
}

/** success: everything requested was done. partial: the main change was applied but a requested
 *  part failed (see steps). failed: nothing (or nothing durable) was applied. blocked: needs a decision. */
export type Outcome = "success" | "partial" | "failed" | "blocked" | "preview" | "unchanged";

export interface Step {
  readonly name: string;
  readonly status: "done" | "failed" | "skipped";
  readonly detail?: string;
}

export interface OperationResult {
  readonly outcome?: Outcome;
  readonly steps?: readonly Step[];
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly changes: readonly Change[];
  readonly messages: readonly string[];
  readonly errors: readonly string[];
  /** The operation needs a decision (conflict, confirmation) before it can proceed. */
  readonly blocked?: string;
}

export type Progress = (message: string) => void;

export const healthy = (c: Check) => c.status === "healthy" || c.status === "disabled";
