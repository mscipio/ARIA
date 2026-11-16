import { join } from "node:path";
import { UnsafePath, entries, readRegularFile, realRoot, secureDir } from "./safe-fs.ts";

/**
 * Plans are plain Markdown in `.aria/plans/`, edited with the native edit/write tools. There is
 * no plan tool and no database. This module only READS them, through one confined reader used by
 * the server plugin, the CLI and the TUI.
 *
 * Format (see skills/aria-plan):
 *   ---
 *   status: active            # active | done | abandoned
 *   objective: one line
 *   session: ses_...          # root session that owns the plan (set by the agent that works on it)
 *   ---
 *   - [ ] T1 pending     - [~] T2 in progress     - [x] T3 executed     - [!] T4 blocked
 *       - verified: what was checked and what it showed
 *       - review: required | not-required | skipped (why) | pass | fail | insufficient  (+ reviewer session, date)
 *
 * State kept apart: the checkbox is PLAN state; a `verified:` line is a RECORD of claimed
 * evidence (not independent proof); what an agent is doing right now is EXECUTION state and lives
 * in OpenCode sessions, not here. A `[x]` without `verified:` is "executed, not verified".
 *
 * Confinement: `.aria` and `.aria/plans` must be real directories inside the real project root,
 * and each plan must be a regular file (not a symlink) at the top level of `.aria/plans`. Anything
 * else is skipped with a problem note that names the file but never its content.
 */

export type TaskMark = " " | "~" | "x" | "!";

export type ReviewMark = "required" | "not-required" | "skipped" | "pass" | "fail" | "insufficient";

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly mark: TaskMark;
  readonly verified: boolean;
  /** `- review: <mark> ...` under the task: the recorded review disposition (a claim, like verified:). */
  readonly review?: ReviewMark;
}

export interface PlanSummary {
  readonly file: string;
  readonly title: string;
  readonly status: string;
  readonly objective: string;
  /** Root session that owns the plan, if recorded. */
  readonly session: string | undefined;
  readonly tasks: readonly PlanTask[];
  readonly counts: { readonly pending: number; readonly active: number; readonly executed: number; readonly verified: number; readonly blocked: number };
  readonly next: PlanTask | undefined;
}

/**
 * How a read went. `absent`: no `.aria/plans` directory. `empty`: read, no plans. `ok`: every
 * candidate read. `partial`: some files skipped (see problems). `unavailable`: the directory could
 * not be read at all; `plans` is empty and says nothing about what exists.
 */
export type PlanReadState = "absent" | "empty" | "ok" | "partial" | "unavailable";

export interface PlanLoad {
  readonly state: PlanReadState;
  readonly plans: readonly PlanSummary[];
  readonly problems: readonly string[];
}

const TASK = /^-\s+\[([ ~x!])\]\s+(T\d+)\b[\s.:)-]*(.*)$/;
const PLAN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_PLANS = 100;

export const PLANS_DIR = ".aria/plans";

export function parsePlan(file: string, text: string): PlanSummary {
  const lines = text.split(/\r?\n/);
  const front: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length && lines[i]?.trim() !== "---"; i++) {
      const m = /^([A-Za-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(lines[i] ?? "");
      if (m?.[1]) front[m[1].toLowerCase()] = m[2] ?? "";
    }
    i++;
  }
  const title = lines.slice(i).find((l) => l.startsWith("# "))?.slice(2).trim() ?? file;
  const tasks: PlanTask[] = [];
  let current: { id: string; title: string; mark: TaskMark; verified: boolean; review?: ReviewMark } | undefined;
  for (const line of lines.slice(i)) {
    const m = TASK.exec(line);
    if (m) {
      if (current) tasks.push(current);
      current = { id: m[2] ?? "", title: (m[3] ?? "").trim(), mark: (m[1] ?? " ") as TaskMark, verified: false };
    } else if (current && /^\s+-\s+verified:\s*\S/i.test(line)) {
      current.verified = true;
    } else if (current) {
      const r = /^\s+-\s+review:\s*(required|not[- ]required|skipped|pass(?:ed)?|fail(?:ed)?|insufficient)/i.exec(line);
      if (r?.[1]) {
        const w = r[1].toLowerCase().replace(" ", "-");
        current.review = (w.startsWith("pass") ? "pass" : w.startsWith("fail") ? "fail" : w) as ReviewMark;
      }
    }
  }
  if (current) tasks.push(current);
  const counts = {
    pending: tasks.filter((t) => t.mark === " ").length,
    active: tasks.filter((t) => t.mark === "~").length,
    executed: tasks.filter((t) => t.mark === "x").length,
    verified: tasks.filter((t) => t.mark === "x" && t.verified).length,
    blocked: tasks.filter((t) => t.mark === "!").length,
  };
  const session = (front.session ?? "").trim();
  return {
    file,
    title,
    status: (front.status ?? "active").toLowerCase(),
    objective: front.objective ?? "",
    session: session || undefined,
    tasks,
    counts,
    next: tasks.find((t) => t.mark === "~") ?? tasks.find((t) => t.mark === " "),
  };
}

/** All readable plans in a project, newest-named first, plus why anything was skipped. Never throws. */
export function loadPlans(projectDir: string): PlanLoad {
  let dir: string | undefined;
  try {
    dir = secureDir(realRoot(projectDir), [".aria", "plans"], false);
  } catch (error) {
    return { state: "unavailable", plans: [], problems: [`plans unavailable: ${(error as Error).message}`] };
  }
  if (!dir) return { state: "absent", plans: [], problems: [] };
  const plans: PlanSummary[] = [];
  const problems: string[] = [];
  let listing: ReturnType<typeof entries>;
  try {
    listing = entries(dir);
  } catch (error) {
    return { state: "unavailable", plans: [], problems: [`plans unavailable: ${(error as Error).message}`] };
  }
  const candidates = listing.filter((e) => e.name.endsWith(".md")).sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const { name, kind } of candidates.slice(0, MAX_PLANS)) {
    if (!PLAN_FILE.test(name)) {
      problems.push(`skipped ${JSON.stringify(name)}: unexpected file name`);
      continue;
    }
    if (kind !== "file") {
      problems.push(`skipped ${name}: ${kind === "symlink" ? "symbolic link (never followed)" : `not a regular file (${kind})`}`);
      continue;
    }
    try {
      const text = readRegularFile(join(dir, name), MAX_PLAN_BYTES);
      if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text) || !/^status:/m.test(text)) {
        problems.push(`skipped ${name}: no front matter with a status line`);
        continue;
      }
      plans.push(parsePlan(`${PLANS_DIR}/${name}`, text));
    } catch (error) {
      problems.push(`skipped ${name}: ${error instanceof UnsafePath ? error.message.replace(dir, PLANS_DIR) : "unreadable"}`);
    }
  }
  if (candidates.length > MAX_PLANS) problems.push(`only the first ${MAX_PLANS} plans were read`);
  const state: PlanReadState = problems.length ? "partial" : plans.length ? "ok" : "empty";
  return { state, plans, problems };
}

export const isActive = (p: PlanSummary) => p.status === "active";

/** Active plans split by ownership relative to a root session. */
export function partitionPlans(plans: readonly PlanSummary[], rootSession: string | undefined) {
  const active = plans.filter(isActive);
  const own = rootSession ? active.filter((p) => p.session === rootSession) : [];
  return { own, other: active.filter((p) => !own.includes(p)) };
}

/** Compact one-liner per plan; used for recovery context and status output. */
export function describePlan(p: PlanSummary): string {
  const c = p.counts;
  const next = p.next ? ` Next: ${p.next.id} ${p.next.title}`.trimEnd() : "";
  return `${p.file} — ${p.title}: ${c.executed}/${p.tasks.length} executed, ${c.verified} with recorded evidence, ${c.active} in progress, ${c.blocked} blocked.${next}`;
}
