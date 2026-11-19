#!/usr/bin/env node
// Collect observations from benchmark runs: node eval/collect.mjs <runs-dir>  ->  <runs-dir>/runs.json
//
// Everything here is read from what the run recorded (OpenCode's JSON event stream, the session
// export, ARIA's review record in session metadata, the hidden check's result, follow-ups). The
// event schema is not assumed beyond "objects with a tool name, an input and a state"; fields that
// cannot be found are reported as null, never guessed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node eval/collect.mjs <runs-dir>");
  process.exit(2);
}
const json = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").flatMap((l) => {
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
}) : []);

/** Every object in a JSON value (depth-first). */
function* objects(v) {
  if (!v || typeof v !== "object") return;
  yield v;
  for (const x of Array.isArray(v) ? v : Object.values(v)) yield* objects(x);
}

/** Tool calls, deduplicated by call id (streams repeat a part as its state changes; the last wins). */
function toolCalls(values) {
  const calls = new Map();
  let anon = 0;
  for (const v of values) for (const o of objects(v)) {
    if (typeof o.tool !== "string" || !o.state || typeof o.state !== "object") continue;
    const id = o.callID ?? o.callId ?? o.id ?? `anon-${anon++}`;
    calls.set(id, { tool: o.tool, input: o.state.input ?? o.input ?? {}, status: o.state.status ?? null, output: typeof o.state.output === "string" ? o.state.output.slice(0, 2000) : null, metadata: o.state.metadata ?? null });
  }
  return [...calls.values()];
}

/**
 * Token and cost totals. Preferred: the `info` totals OpenCode records per session, for the root
 * session and every exported child session (delegated work). Fallback: assistant messages,
 * deduplicated by id.
 */
function usage(sessions, values) {
  const infos = sessions.map((s) => s?.info).filter((i) => i && i.tokens && typeof i.tokens === "object");
  const sum = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, sessions: infos.length };
  const add = (cost, t) => {
    sum.cost += typeof cost === "number" ? cost : 0;
    sum.input += t.input ?? 0;
    sum.output += t.output ?? 0;
    sum.reasoning += t.reasoning ?? 0;
    sum.cacheRead += t.cache?.read ?? 0;
  };
  if (infos.length) {
    for (const i of infos) add(i.cost, i.tokens);
    return sum;
  }
  const byMessage = new Map();
  for (const v of values) for (const o of objects(v)) if ((o.role === "assistant" || o.type === "assistant") && o.tokens && typeof o.tokens === "object") byMessage.set(o.id ?? byMessage.size, o);
  if (!byMessage.size) return null;
  for (const m of byMessage.values()) add(m.cost, m.tokens);
  return sum;
}

const VERIFY = /\b(pytest|unittest|check\.sh|python3?\s+-m\s+\w+|python3?\s+-c|npm\s+test|node\s+--test)\b/;
const runs = [];
for (const task of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort()) {
  for (const cond of readdirSync(join(root, task)).sort()) {
    for (const r of readdirSync(join(root, task, cond)).sort()) {
      const dir = join(root, task, cond, r);
      const meta = json(join(dir, "meta.json"));
      if (!meta) continue;
      const followups = readdirSync(dir).filter((f) => /^followup-\d+\.jsonl$/.test(f)).sort();
      const events = [...lines(join(dir, "events.jsonl")), ...followups.flatMap((f) => lines(join(dir, f)))];
      const session = json(join(dir, "session.json"));
      const children = existsSync(join(dir, "children")) ? readdirSync(join(dir, "children")).filter((f) => f.endsWith(".json")).map((f) => json(join(dir, "children", f))).filter(Boolean) : [];
      const values = [...events, ...(session ? [session] : []), ...children];
      const calls = toolCalls(values);
      const delegations = calls.filter((c) => c.tool === "subagent" || c.tool === "task").map((c) => c.input?.agent ?? c.input?.subagent_type ?? "?");
      const review = [...objects(session)].find((o) => o.aria_review)?.aria_review ?? null;
      const verdicts = review?.verdicts ?? calls.filter((c) => c.tool === "aria_review_verdict").map((c) => c.input);
      const shell = calls.filter((c) => /^(bash|shell|exec|opencode_shell)$/i.test(c.tool) || typeof c.input?.command === "string");
      const check = json(join(dir, "check.json"));
      const final = existsSync(join(dir, "final.txt")) ? readFileSync(join(dir, "final.txt"), "utf8") : "";
      const interventions = json(join(dir, "interventions.json")) ?? [];
      const verdictList = (Array.isArray(verdicts) ? verdicts : []).map((v) => v?.verdict ?? v?.result ?? v?.status ?? null);
      runs.push({
        task: meta.task, condition: meta.condition, repeat: meta.repeat, model: meta.model, opencode: meta.opencode, aria: meta.aria,
        seconds: meta.seconds, timedOut: meta.timedOut, exit: meta.exit,
        pass: check ? Boolean(check.pass) : null,
        failedChecks: check ? check.checks.filter((c) => !c.ok).map((c) => c.name) : null,
        interventions: interventions.length,
        toolCalls: calls.length,
        tools: Object.fromEntries([...new Set(calls.map((c) => c.tool))].map((t) => [t, calls.filter((c) => c.tool === t).length])),
        delegations,
        reviewerInvoked: delegations.includes("reviewer"),
        reviewRecord: review,
        verdicts: verdictList,
        correctionLoop: verdictList.includes("FAIL") ? verdictList.lastIndexOf("PASS") > verdictList.indexOf("FAIL") : null,
        ranVerification: shell.some((c) => VERIFY.test(String(c.input?.command ?? ""))),
        askedUser: /\?\s*$/.test(final.trim().split("\n").slice(-3).join(" ")),
        usage: usage([session, ...children], values),
        childSessions: children.length,
        finalExcerpt: final.slice(-600),
        eventsSeen: events.length,
        sessionExported: Boolean(session),
      });
    }
  }
}
writeFileSync(join(root, "runs.json"), JSON.stringify(runs, null, 1));
console.log(`${runs.length} run(s) -> ${join(root, "runs.json")}`);
