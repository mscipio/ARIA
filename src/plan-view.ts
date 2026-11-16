import type { PlanSummary, PlanTask } from "./plans.ts";

/**
 * Pure helpers behind the TUI: how a plan task is shown and which changes are worth telling the
 * user about. No UI and no OpenCode imports, so the behaviour can be checked without a TUI.
 *
 * Task state is derived only from what the plan file says: the checkbox is plan state and a
 * `verified:` line is a RECORD of claimed evidence. The UI calls it "evidence recorded", never
 * "verified", because nothing here re-checks it. A done task without a record is "executed".
 * Session events (a subagent going idle) never change task state.
 */

export type TaskState = "pending" | "active" | "blocked" | "executed" | "verified";
export type Tone = "info" | "success" | "warning" | "error";

export interface StatusEvent {
  readonly message: string;
  readonly variant: Tone;
  /** Worth an OS-level notification when the terminal is not focused. */
  readonly attention: boolean;
}

export function taskState(task: PlanTask): TaskState {
  switch (task.mark) {
    case "~":
      return "active";
    case "!":
      return "blocked";
    case "x":
      return task.verified ? "verified" : "executed";
    default:
      return "pending";
  }
}

const SYMBOL: Record<TaskState, string> = { pending: "○", active: "●", blocked: "✗", executed: "◐", verified: "✔" };
const LABEL: Record<TaskState, string> = {
  pending: "pending",
  active: "in progress",
  blocked: "blocked",
  executed: "executed, no evidence recorded",
  verified: "executed, evidence recorded (not re-checked)",
};

export const taskSymbol = (task: PlanTask) => SYMBOL[taskState(task)];
export const taskLabel = (task: PlanTask) => `${LABEL[taskState(task)]}${task.review === "fail" ? "; independent review FAILED (blocking findings recorded)" : task.review === "required" ? "; independent review required, not yet recorded" : ""}`;
const REVIEW_TAG: Record<NonNullable<PlanTask["review"]>, string> = {
  required: " [review pending]",
  "not-required": "",
  skipped: " [review skipped]",
  pass: " [review PASS]",
  fail: " [review FAIL]",
  insufficient: " [review: insufficient evidence]",
};
export const taskLine = (task: PlanTask) => `${taskSymbol(task)} ${task.id} ${task.title}${task.review ? REVIEW_TAG[task.review] : ""}`.trimEnd();

/** One-line progress for a header, e.g. "3/8 executed · 2 with evidence · 1 blocked". */
export function progressLine(plan: PlanSummary): string {
  const c = plan.counts;
  const parts = [`${c.executed}/${plan.tasks.length} executed`, `${c.verified} with evidence`];
  if (c.active) parts.push(`${c.active} in progress`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  return parts.join(" · ");
}

/** A window of at most `max` tasks that keeps the current task in view. */
export function visibleTasks(plan: PlanSummary, max: number): { tasks: PlanTask[]; before: number; after: number } {
  const all = plan.tasks;
  if (all.length <= max) return { tasks: [...all], before: 0, after: 0 };
  const focus = Math.max(0, plan.next ? all.findIndex((t) => t.id === plan.next?.id) : 0);
  const start = Math.min(Math.max(0, focus - 1), all.length - max);
  return { tasks: all.slice(start, start + max), before: start, after: all.length - start - max };
}

const MAX_EVENTS = 4;

function limit(events: StatusEvent[]): StatusEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  const rest = events.length - (MAX_EVENTS - 1);
  return [...events.slice(0, MAX_EVENTS - 1), { message: `+${rest} more plan updates`, variant: "info", attention: false }];
}

/** What changed between two reads of the plan directory. Plans seen for the first time are reported as new. */
export function diffPlans(prev: readonly PlanSummary[], next: readonly PlanSummary[]): StatusEvent[] {
  const events: StatusEvent[] = [];
  const before = new Map(prev.map((p) => [p.file, p]));
  for (const plan of next) {
    const old = before.get(plan.file);
    if (!old) {
      if (plan.status === "active") events.push({ message: `Plan started: ${plan.title} (${plan.tasks.length} tasks)`, variant: "info", attention: false });
      continue;
    }
    const oldTasks = new Map(old.tasks.map((t) => [t.id, t]));
    for (const task of plan.tasks) {
      const was = oldTasks.get(task.id);
      const now = taskState(task);
      if (!was) {
        events.push({ message: `${task.id} added: ${task.title}`, variant: "info", attention: false });
        continue;
      }
      const prior = taskState(was);
      if (prior === now) continue;
      if (now === "active") events.push({ message: `${task.id} started: ${task.title}`, variant: "info", attention: false });
      else if (now === "executed" && prior === "verified") events.push({ message: `${task.id} evidence record removed: ${task.title}`, variant: "warning", attention: false });
      else if (now === "executed") events.push({ message: `${task.id} executed, no evidence recorded yet: ${task.title}`, variant: "info", attention: false });
      else if (now === "verified") events.push({ message: `${task.id} evidence recorded: ${task.title}`, variant: "success", attention: false });
      else if (now === "blocked") events.push({ message: `${task.id} blocked: ${task.title}`, variant: "warning", attention: true });
      else if (prior === "blocked") events.push({ message: `${task.id} unblocked: ${task.title}`, variant: "info", attention: false });
      else if (prior === "verified" || prior === "executed") events.push({ message: `${task.id} reopened: ${task.title}`, variant: "warning", attention: false });
    }
    if (old.status !== plan.status) {
      if (plan.status === "done") events.push({ message: `Plan done: ${plan.title} — ${progressLine(plan)}`, variant: "success", attention: true });
      else if (plan.status === "abandoned") events.push({ message: `Plan abandoned: ${plan.title}`, variant: "warning", attention: false });
      else events.push({ message: `Plan ${plan.status}: ${plan.title}`, variant: "info", attention: false });
    }
  }
  return limit(events);
}

export type SessionState = "running" | "idle" | "failed";

export interface SessionSnapshot {
  readonly agent: string;
  readonly state: SessionState;
  readonly isRoot: boolean;
}

/** Subagent and root-session transitions: started, finished, failed. Sessions seen for the first time are only reported when they are already running. */
export function diffSessions(prev: ReadonlyMap<string, SessionSnapshot>, next: ReadonlyMap<string, SessionSnapshot>): StatusEvent[] {
  const events: StatusEvent[] = [];
  for (const [id, now] of next) {
    const was = prev.get(id);
    const name = now.agent || "agent";
    if (!was) {
      if (now.state === "running" && !now.isRoot) events.push({ message: `${name} started`, variant: "info", attention: false });
      continue;
    }
    if (was.state === now.state) continue;
    if (now.state === "failed") events.push({ message: `${name} failed`, variant: "error", attention: true });
    else if (now.state === "running" && !now.isRoot) events.push({ message: `${name} started`, variant: "info", attention: false });
    else if (was.state === "running" && now.state === "idle") {
      events.push(now.isRoot ? { message: `${name} finished`, variant: "success", attention: true } : { message: `${name} finished`, variant: "info", attention: false });
    }
  }
  return events;
}
