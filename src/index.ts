import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Skill } from "@opencode/plugin";
import { cancelledMessage, classify, createDenials, createReplyTracker, rejectionMessage, repeatMessage, settle } from "./denials.ts";
import { createGuard, createRootResolver } from "./guard.ts";
import { GIT_INPUT_SCHEMA, runGit, type GitInput } from "./git-tool.ts";
import { describePlan, loadPlans, partitionPlans } from "./plans.ts";
import { ROLE_IDS, buildRoles, loadPrompt } from "./roles.ts";
import { SCRATCH_DIR, ensureScratch, shellQuote, validSessionID } from "./scratch.ts";
import { discoverSkills } from "./skills.ts";
import { META_KEY, VERDICT_SCHEMA, fromMetadata, onEdit, onRequest, onShell, onVerdict, parseVerdict, summarize, type ReviewState } from "./review.ts";
import { createApprovalCarry, needsGate } from "./tool-gate.ts";

/**
 * ARIA 2: one server plugin that adds only what OpenCode v2.3.0 does not do natively.
 *
 *   agents      role prompts, modes and permission rules via `agent.transform`. External plugins
 *               run before OpenCode's config agent plugin, so user `agents.<id>` settings and
 *               top-level `permissions` are layered on top natively. No models are pinned.
 *   skills      curated skills registered with the native skill registry
 *   guard       `permission` `evaluate` hook: symlink boundary + scratch ownership (deny-only)
 *   tool gate   `tool` `execute.before` hook: per-call permission for tools that never assert; a user
 *               rejection is reported to the model as such and holds for the session tree until the
 *               user's next prompt (denials.ts)
 *   aria_git    read-only status/diff/log/show for roles without a shell
 *   aria_status effective roles, models, plans and review state as the running server sees them
 *   review      observed review state per root session (changes, reviewer launches, verdicts the
 *               reviewer recorded with aria_review_verdict), stored in the root session's metadata
 *   context     per-session scratch path (re-provisioned on every request, which also marks the
 *               session as active for cleanup) and the plan owned by this session tree
 *
 * Options (`plugins: [{ "package": "/path/to/aria", "options": { ... } }]`):
 *   zoteroServer  MCP server name of zotero-mcp (default "zotero")
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const SCRATCH_ROLES = new Set(["aria", "scientist", "visualizer"]);
const PLAN_ROLES = new Set(["aria", "scientist", "planner"]);

export default Plugin.define({
  id: "aria",
  async setup(ctx) {
    const directory = ctx.location.directory as string;
    const projectDirectory = ctx.location.project?.directory as string | undefined;
    const option = (ctx.options ?? {}) as { zoteroServer?: unknown };
    const zoteroServer = typeof option.zoteroServer === "string" && option.zoteroServer ? option.zoteroServer : "zotero";
    const roles = buildRoles({ zoteroServer });
    const disposers: Array<() => Promise<void>> = [];
    const track = async (registration: Promise<{ dispose: () => Promise<void> }>) => {
      disposers.push((await registration).dispose);
    };

    // Prompts are read once. A missing prompt file is a packaging error and fails setup loudly.
    const prompts = new Map(ROLE_IDS.map((id) => [id, loadPrompt(packageRoot, id)]));

    await track(
      ctx.agent.transform((editor) => {
        for (const role of roles) {
          editor.update(role.id, (agent) => {
            agent.mode = role.mode;
            agent.description = role.description;
            agent.system = prompts.get(role.id) ?? "";
            agent.permissions.push(...role.rules);
          });
        }
        editor.default("aria");
      }),
    );

    await track(
      ctx.skill.transform((editor) => {
        for (const skill of discoverSkills(packageRoot)) {
          editor.add(
            Skill.Info.make({
              id: skill.id as never,
              name: skill.name as never,
              description: skill.description,
              path: skill.path as never,
              content: skill.content,
            }),
          );
        }
      }),
    );

    const parentOf = async (sessionID: string) => {
      const info = await ctx.session.get({ sessionID: sessionID as never });
      return (info.parentID as string | undefined) || undefined;
    };
    const rootOf = createRootResolver(parentOf);

    await track(ctx.permission.hook("evaluate", createGuard({ directory, projectDirectory, rootOf })));

    // Tool gate: per-call permission for every tool that is not a self-asserting built-in.
    // A user rejection is made unmistakable to the model and binds the whole session tree (so a
    // subagent cannot redo it) until the user's next prompt; see denials.ts.
    const carry = createApprovalCarry();
    const denials = createDenials();
    const replies = createReplyTracker();
    // OpenCode cancels every other pending request when the user rejects one; the events tell the
    // user's own answer from those cancellations (denials.ts).
    let stopped = false;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["permission.asked", "permission.replied"] })) {
          if (stopped) break;
          const e = event as unknown as { type: string; data?: never };
          if (e.type === "permission.asked") replies.asked(e.data as never);
          else if (e.type === "permission.replied") replies.replied(e.data as never);
        }
      } catch {
        // Stream failed. Without it rejections are reported as unconfirmed and not recorded (denials.ts).
      }
    })();
    disposers.push(async () => {
      stopped = true;
    });
    await track(ctx.permission.hook("evaluate", (event) => carry.hook(event as never)));
    await track(
      ctx.tool.hook("execute.before", async (event) => {
        if (!needsGate(event.tool)) return;
        // Fail closed: a rejection recorded for the tree cannot be checked if the tree is unknown.
        const root = await rootOf(event.sessionID).catch(() => undefined);
        if (!root) throw new Error(`ARIA could not resolve this session's tree to check earlier permission decisions, so ${event.tool} did not run. Try again.`);
        const earlier = denials.find(root, event.tool);
        if (earlier) throw new Error(repeatMessage(earlier));
        try {
          await ctx.permission.assert({
            sessionID: event.sessionID,
            agent: event.agent,
            action: event.tool,
            resources: ["*"],
            source: { type: "tool", messageID: event.messageID, id: event.id },
          });
        } catch (error) {
          const rejection = classify(error);
          if (!rejection) throw error;
          const verdict = await settle(() => replies.verdict(event.sessionID, event.id, event.tool));
          if (verdict !== "explicit") throw new Error(cancelledMessage(event.tool, verdict));
          denials.record(root, event.tool, rejection.kind === "corrected" ? rejection.feedback : undefined);
          throw new Error(rejectionMessage(event.tool, rejection));
        }
        carry.record(event.sessionID, event.id, event.tool);
      }),
    );
    // A prompt into a ROOT session is the user speaking again (subagent reports do not pass through
    // this hook); a child's launch prompt must not lift a rejection. If the lookup fails, keep the block.
    await track(
      ctx.session.hook("prompt", async (event) => {
        const info = await ctx.session.get({ sessionID: event.sessionID as never }).catch(() => undefined);
        if (info && !info.parentID) denials.clear(event.sessionID as string);
      }),
    );

    // ---------------------------------------------------------------- review state
    // Observed facts only (tool calls and the reviewer's own structured verdict); never parsed from text.
    const reviews = new Map<string, ReviewState>();
    const writes = new Map<string, Promise<void>>();
    const loadReview = async (root: string): Promise<ReviewState> => {
      const cached = reviews.get(root);
      if (cached) return cached;
      const info = await ctx.session.get({ sessionID: root as never }).catch(() => undefined);
      const state = fromMetadata((info as { metadata?: unknown } | undefined)?.metadata, root);
      reviews.set(root, state);
      return state;
    };
    const updateReview = (root: string, change: (s: ReviewState) => ReviewState): Promise<void> => {
      const run = (writes.get(root) ?? Promise.resolve()).then(async () => {
        const next = change(await loadReview(root));
        reviews.set(root, next);
        const info = await ctx.session.get({ sessionID: root as never }).catch(() => undefined);
        const metadata = { ...(((info as { metadata?: Record<string, unknown> } | undefined)?.metadata) ?? {}), [META_KEY]: next };
        await ctx.session.update({ sessionID: root as never, metadata: metadata as never }).catch(() => undefined);
      });
      writes.set(root, run.catch(() => undefined));
      return run;
    };
    await track(
      ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || event.agent === "reviewer") return;
        const root = await rootOf(event.sessionID).catch(() => undefined);
        if (!root) return;
        const input = (event.input ?? {}) as { path?: unknown; agent?: unknown; sessionID?: unknown };
        if (event.tool === "edit" || event.tool === "write") {
          if (typeof input.path === "string") await updateReview(root, (s) => onEdit(s, input.path as string));
        } else if (event.tool === "patch") {
          await updateReview(root, (s) => onEdit(s, "(patch)"));
        } else if (event.tool === "shell") {
          await updateReview(root, onShell);
        } else if (event.tool === "subagent" && input.agent === "reviewer") {
          const out = (event.result as { output?: { sessionID?: unknown } }).output;
          const child = typeof out?.sessionID === "string" ? out.sessionID : typeof input.sessionID === "string" ? input.sessionID : undefined;
          if (child) await updateReview(root, (s) => onRequest(s, child, event.agent));
        }
      }),
    );

    await track(
      ctx.tool.transform((editor) => {
        editor.add({
          name: "aria_git",
          description:
            "Read-only repository state: status, diff (working tree, staged, or against a revision), log, and show. Use it to see what changed. Credential files are excluded from patches.",
          input: GIT_INPUT_SCHEMA,
          execute: async (input, context) => {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "aria_git",
              resources: ["*"],
              source: { type: "tool", messageID: context.messageID, id: context.id },
            });
            return { content: await runGit(directory, input as GitInput) };
          },
        });

        editor.add({
          name: "aria_review_verdict",
          description:
            "Reviewer only: record the outcome of this independent review (PASS, FAIL with blocking findings, or INSUFFICIENT_EVIDENCE with what is missing). Call once, after you have examined the real diff and files, before your final report.",
          input: VERDICT_SCHEMA,
          execute: async (input, context) => {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "aria_review_verdict",
              resources: ["*"],
              source: { type: "tool", messageID: context.messageID, id: context.id },
            });
            if (context.agent !== "reviewer") throw new Error("only the reviewer agent can record a review verdict");
            const verdict = parseVerdict(input);
            const root = await rootOf(context.sessionID);
            if (root === context.sessionID) throw new Error("a review verdict must come from a reviewer launched by an implementing session");
            await updateReview(root, (s) => onVerdict(s, context.sessionID, verdict));
            return { content: `Recorded ${verdict.outcome} for this review (${verdict.blocking.length} blocking).` };
          },
        });

        editor.add({
          name: "aria_status",
          description:
            "Report the ARIA roles as the running OpenCode server resolved them (mode, effective model, availability), plans and any ARIA state problems. Use it instead of guessing configuration.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_input, context) => ({ content: await statusReport(context.sessionID) }),
        });
      }),
    );

    async function statusReport(sessionID: string): Promise<string> {
      const agents = (await ctx.agent.list()).data;
      const known = new Set<string>(ROLE_IDS);
      let available: Set<string> | undefined;
      try {
        available = new Set((await ctx.model.list()).data.map((m) => `${m.providerID}/${m.id}`));
      } catch {
        available = undefined;
      }
      const lines = [`ARIA ${packageVersion()} on OpenCode ${ctx.app.version} — ${directory}`, ""];
      const seen = new Set<string>();
      for (const agent of agents.filter((a) => known.has(a.id))) {
        seen.add(agent.id);
        const m = agent.model;
        const effective = m ? `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}` : "no model set: uses the selected/launching session's model";
        const ok = !m || available === undefined ? "" : available.has(`${m.providerID}/${m.id}`) ? "" : "  ** MODEL NOT AVAILABLE **";
        lines.push(`${agent.id.padEnd(11)} ${agent.mode.padEnd(8)} ${effective}${ok}`);
      }
      const missing = ROLE_IDS.filter((id) => !seen.has(id));
      if (missing.length) lines.push(`NOT REGISTERED: ${missing.join(", ")}`);
      if (available === undefined) lines.push("", "(model availability could not be queried)");
      const root = await rootOf(sessionID).catch(() => undefined);
      const { plans, problems } = loadPlans(directory);
      const { own, other } = partitionPlans(plans, root);
      lines.push("", own.length ? "Plans owned by this session:" : "No plan owned by this session.", ...own.map((p) => `  ${describePlan(p)}`));
      if (other.length) lines.push("Other active plans (not this session's):", ...other.map((p) => `  ${describePlan(p)}`));
      if (problems.length) lines.push("Plan problems:", ...problems.map((p) => `  ${p}`));
      if (root) {
        const review = summarize(await loadReview(root));
        lines.push("", `Review: ${review.line}`);
        for (const f of review.disposition === "failed" ? (review.latest?.blocking ?? []) : []) lines.push(`  BLOCKING: ${f.summary}${f.location ? ` (${f.location})` : ""}`);
      }
      lines.push("", `Zotero MCP server name: ${zoteroServer}`, "Overrides: agents.<id>.model in opencode.jsonc (project beats global). Values above are post-merge.");
      return lines.join("\n");
    }

    // Scratch is provisioned on every model request (idempotent and cheap), so a directory removed
    // mid-session (cleanup, manual delete) is recreated before the model is told to use it.
    type Provision = { ok: true; dir: string; root: string } | { ok: false; reason: string };
    const provision = async (sessionID: string): Promise<Provision> => {
      try {
        const root = await rootOf(sessionID);
        if (!validSessionID(root) || !validSessionID(sessionID)) throw new Error("session id could not be resolved");
        ensureScratch(directory, root, sessionID);
        // Shown with the project path OpenCode itself uses (it matches paths lexically), not the real path.
        return { ok: true, dir: join(directory, SCRATCH_DIR, root, sessionID), root };
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
    };

    await track(
      ctx.session.hook("context", async (event) => {
        const notes: string[] = [];
        let root: string | undefined;
        try {
          root = await rootOf(event.sessionID);
        } catch {
          root = undefined;
        }
        if (SCRATCH_ROLES.has(event.agent)) {
          const scratch = await provision(event.sessionID);
          if (scratch.ok) {
            notes.push(
              `ARIA scratch for this session: ${scratch.dir}/ (Git-ignored, yours alone, already created; do not guess other session ids). Put ALL temporary files there: scripts, logs, terminal captures, intermediate output, disposable fixtures and any temporary HOME or config directory. Do not use /tmp, bare mktemp or any other directory outside the project unless the user asks. Single files can go directly in it. To keep several related files together, make one activity directory, \`mkdir -- ${shellQuote(scratch.dir)}/"$(date +%Y%m%d-%H%M%S)-short-kebab-description"\` (plain mkdir fails if the name exists; then add a suffix such as -2). TMPDIR is not set to your scratch (the host's value applies): when a tool picks its own temporary location, run it as \`TMPDIR=${shellQuote(scratch.dir)} command\`, or use \`mktemp -d -p ${shellQuote(scratch.dir)}\`. This is a convention, not a sandbox. Deliverables and intentional edits go in their proper place, not here. The edit and write tools are denied in other sessions' scratch (a shell is not restricted). Subagents get their own scratch and cannot write yours: to hand them a file, put it here and give them its path (they can read it).${scratch.root === event.sessionID ? ` When the task is complete and verified, create ${SCRATCH_DIR}/${scratch.root}/DONE so \`aria scratch clean\` can remove it; continuing to work afterwards is fine, cleanup then keeps the scratch.` : ""}`,
            );
          } else {
            notes.push(`ARIA scratch is unavailable: ${scratch.reason}. Do not create temporary files in the repository or in /tmp; keep intermediate output in memory or ask.`);
          }
        }
        if (root && (event.agent === "aria" || event.agent === "scientist")) {
          const review = summarize(await loadReview(root));
          if (review.disposition !== "none" || review.changedSince > 0) {
            notes.push(
              `Recorded review state (observed by ARIA, not self-reported): ${review.line}.${review.disposition === "failed" ? ` Blocking: ${(review.latest?.blocking ?? []).map((f) => f.summary).join(" | ")}.` : ""} Report exactly this state; never describe a review as passed unless it says PASS for the current changes.`,
            );
          }
        }
        if (PLAN_ROLES.has(event.agent)) {
          const { plans, problems } = loadPlans(directory);
          const { own, other } = partitionPlans(plans, root);
          if (root) notes.push(`This session tree's plan owner id is ${root}. A plan you create or take over records it as \`session: ${root}\`.`);
          if (own.length) {
            notes.push(
              `Plan owned by this session (resume it; checkboxes are plan state, "verified:" lines are recorded evidence, not proof):\n${own.slice(0, 3).map((p) => `- ${describePlan(p)}`).join("\n")}`,
            );
          }
          if (other.length) {
            notes.push(
              `Other active plans exist in .aria/plans/ and belong to other sessions: ${other.slice(0, 5).map((p) => `${p.file} (${p.title})`).join("; ")}. They are NOT your task. Resume one only if the user asks or explicitly refers to that work; then set its \`session:\` to ${root ?? "this session's id"}.`,
            );
          }
          if (problems.length) notes.push(`Some plan files were skipped: ${problems.slice(0, 3).join("; ")}.`);
        }
        if (notes.length) event.system.push({ type: "text", text: notes.join("\n\n") });
      }),
    );

    return async () => {
      for (const dispose of disposers.reverse()) await dispose();
    };
  },
});
