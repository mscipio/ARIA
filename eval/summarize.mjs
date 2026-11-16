#!/usr/bin/env node
// Compact comparison table from runs.json: node eval/summarize.mjs <runs-dir> [--md out.md]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node eval/summarize.mjs <runs-dir> [--md file]");
  process.exit(2);
}
const runs = JSON.parse(readFileSync(join(root, "runs.json"), "utf8"));
const REVIEW_REQUIRED = new Set(["D"]);
const DELEGATION_UNNECESSARY = new Set(["A", "C", "E"]);

const groups = new Map();
for (const r of runs) {
  const key = `${r.task}\t${r.condition}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const pct = (a, b) => (b ? `${a}/${b}` : "-");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rows = [];
for (const [key, rs] of [...groups].sort()) {
  const [task, condition] = key.split("\t");
  const n = rs.length;
  const passes = rs.filter((r) => r.pass).length;
  const prompts = n + rs.reduce((a, r) => a + r.interventions, 0);
  const usage = rs.map((r) => r.usage).filter(Boolean);
  rows.push({
    task, condition, n,
    completion: pct(rs.filter((r) => !r.timedOut && r.exit === 0).length, n),
    correct: pct(passes, n),
    interventions: rs.reduce((a, r) => a + r.interventions, 0),
    correctPerPrompt: (passes / prompts).toFixed(2),
    delegation: DELEGATION_UNNECESSARY.has(task) ? `${rs.filter((r) => r.delegations.some((d) => d !== "reviewer")).length} unnecessary` : `${mean(rs.map((r) => r.delegations.length))?.toFixed(1)} avg`,
    recovery: task === "C" ? pct(rs.filter((r) => r.pass && r.interventions === 0).length, n) : "-",
    review: REVIEW_REQUIRED.has(task) ? pct(rs.filter((r) => r.reviewerInvoked).length, n) : `${rs.filter((r) => r.reviewerInvoked).length} used`,
    correction: rs.some((r) => r.correctionLoop !== null) ? pct(rs.filter((r) => r.correctionLoop).length, rs.filter((r) => r.correctionLoop !== null).length) : "-",
    verification: pct(rs.filter((r) => r.ranVerification).length, n),
    seconds: Math.round(mean(rs.map((r) => r.seconds)) ?? 0),
    tokens: usage.length ? Math.round(mean(usage.map((u) => u.input + u.output + u.reasoning))) : "n/a",
    cost: usage.length ? `$${usage.reduce((a, u) => a + u.cost, 0).toFixed(3)}` : "n/a",
  });
}
const head = ["Task", "Condition", "Runs", "Completed", "Correct (hidden check)", "Corrective prompts", "Correct per prompt", "Delegation", "Recovered alone (C)", "Review (required for D)", "Correction loop", "Ran verification", "Mean s", "Mean tokens", "Total cost"];
const keys = ["task", "condition", "n", "completion", "correct", "interventions", "correctPerPrompt", "delegation", "recovery", "review", "correction", "verification", "seconds", "tokens", "cost"];
const models = [...new Set(runs.map((r) => r.model))];
const md = [
  `Model: ${models.join(", ")} (same for both conditions) · OpenCode: ${[...new Set(runs.map((r) => r.opencode))].join(", ")} · ARIA: ${[...new Set(runs.map((r) => r.aria).filter(Boolean))].join(", ") || "-"}`,
  "",
  `| ${head.join(" | ")} |`,
  `| ${head.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${keys.map((k) => r[k]).join(" | ")} |`),
  "",
  "Correct = the hidden check passed. Correct per prompt = correct runs / (runs + corrective prompts). Delegation for A/C/E counts runs that delegated to anything other than the reviewer. Review for D counts runs where the reviewer was actually launched; a recorded PASS is not taken as proof (inspect `reviewRecord` in runs.json).",
  "Failed checks per run are in runs.json (`failedChecks`); read the transcripts before drawing conclusions from a single run.",
].join("\n");
console.log(md);
const at = process.argv.indexOf("--md");
if (at > 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1], md + "\n");
