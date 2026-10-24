import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import aria from "../src/index.js";
import {
  createPlanPremiseRecoveryTool,
  PLAN_PREMISE_RECOVERY_ROLES,
  PLAN_PREMISE_RECOVERY_TOOL_NAME,
  type PlanPremiseRecoverySessionApi,
} from "../src/plan-premise-recovery-tool.js";
import { addPlanTasks, approvePlan, createPlan, readActivePlan, updatePlanTask, type SharedPlan } from "../src/plans.js";
import { createUniqueScratchDir } from "../src/scratch.js";
import { effectiveRolePermissions } from "../src/register.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed: string[] = [];

afterEach(async () => {
  await Promise.all(managed.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await createUniqueScratchDir(REPO_ROOT, "tests/plan-premise-recovery", name);
  managed.push(root);
  return root;
}

async function approvedPlan(root: string, tasks: string[]): Promise<SharedPlan> {
  const created = await createPlan(root, "Plan premise recovery fixture", tasks);
  return approvePlan(root, created.id, created.revision);
}

function recoveryInput(plan: SharedPlan, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedPlanID: plan.id,
    expectedRevision: plan.revision,
    taskID: "T001",
    stalePremise: "The source contains the obsolete figure 12.",
    correctedPremise: "The source confirms the figure is 24.",
    evidence: "Primary source: report section 4, table 2.",
    ...overrides,
  };
}

function mockSessions(options: {
  onPrompt?: (text: string) => Promise<void> | void;
  messages?: readonly unknown[];
  child?: { id: string; parentID: string; agent: string };
} = {}): PlanPremiseRecoverySessionApi & {
  create: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  context: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async (input: { parentID: string; agent: "coder"; title: string }) => options.child ?? ({
      id: "child-session",
      parentID: input.parentID,
      agent: input.agent,
    })),
    prompt: vi.fn(async (input: { sessionID: string; text: string }) => options.onPrompt?.(input.text)),
    wait: vi.fn(async (_input: { sessionID: string }) => undefined),
    context: vi.fn(async (_input: { sessionID: string }) => options.messages ?? [{
      type: "assistant",
      agent: "coder",
      content: [{ type: "text", text: "Recorded the factual correction with the supplied evidence." }],
    }]),
  };
}

function recoveryContext(agent = "implementer", sessionID = "parent-session") {
  return { agent, sessionID };
}

describe("one-shot plan premise recovery tool", () => {
  it("verifies a real correction and preserves plan identity, history, and completed tasks", async () => {
    const root = await fixtureRoot("verified-update");
    const initial = await approvedPlan(root, [
      "Investigate whether The source contains the obsolete figure 12.",
      "Archive the signed baseline after approval.",
    ]);
    const withCompletedHistory = await updatePlanTask(
      root,
      initial.id,
      initial.revision,
      "T002",
      "completed",
      "Baseline signed before recovery.",
    );
    const sessions = mockSessions({
      onPrompt: async () => {
        await updatePlanTask(
          root,
          withCompletedHistory.id,
          withCompletedHistory.revision,
          "T001",
          "blocked",
          "The source confirms the figure is 24. Primary source: report section 4, table 2.",
        );
      },
    });
    const tool = createPlanPremiseRecoveryTool(root, sessions);
    const result = await tool.execute(recoveryInput(withCompletedHistory), recoveryContext());
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    const after = (await readActivePlan(root))?.plan;

    expect(result.metadata.title).toBe("Recovered plan premise");
    expect(payload).toMatchObject({
      correctionHappened: true,
      recoverySucceeded: true,
      samePlanID: true,
      planID: withCompletedHistory.id,
      revision: withCompletedHistory.revision + 1,
      status: "active",
      approval: "approved",
      childSessionID: "child-session",
      childResponse: "Recorded the factual correction with the supplied evidence.",
    });
    expect(after?.id).toBe(withCompletedHistory.id);
    expect(after?.tasks[0]).toMatchObject({
      id: "T001",
      text: withCompletedHistory.tasks[0]?.text,
      status: "blocked",
      evidence: expect.stringContaining("The source confirms the figure is 24."),
    });
    expect(after?.tasks[1]).toEqual(withCompletedHistory.tasks[1]);
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.create).toHaveBeenCalledWith({
      parentID: "parent-session",
      agent: "coder",
      title: "Plan premise recovery · T001",
    });
    expect(sessions.prompt).toHaveBeenCalledTimes(1);
    expect(sessions.prompt.mock.calls[0]?.[0].text).toContain("Use exactly that ID and revision");
    expect(sessions.prompt.mock.calls[0]?.[0].text).toContain("The source confirms the figure is 24.");
    expect(sessions.wait).toHaveBeenCalledTimes(1);
    expect(sessions.context).toHaveBeenCalledTimes(1);
  });

  it("fails before handoff for stale revisions, unmatched premises, and unauthorized roles", async () => {
    const root = await fixtureRoot("preflight-denials");
    const plan = await approvedPlan(root, ["Investigate whether The source contains the obsolete figure 12."]);
    const sessions = mockSessions();
    const tool = createPlanPremiseRecoveryTool(root, sessions);

    const stale = await tool.execute(
      recoveryInput(plan, { expectedRevision: plan.revision - 1 }),
      recoveryContext(),
    );
    const unmatched = await tool.execute(
      recoveryInput(plan, { stalePremise: "A sentence that is not in this task." }),
      recoveryContext(),
    );
    const wrongPlan = await tool.execute(
      recoveryInput(plan, { expectedPlanID: "another-plan-id" }),
      recoveryContext(),
    );
    const unauthorized = await tool.execute(recoveryInput(plan), recoveryContext("coder"));
    const missingParent = await tool.execute(recoveryInput(plan), recoveryContext("implementer", ""));

    expect(stale.metadata.title).toBe("Error");
    expect(stale.content).toContain("revision conflict");
    expect(unmatched.content).toContain("exact stale premise does not occur");
    expect(wrongPlan.content).toContain("Plan ID conflict");
    expect(unauthorized.content).toContain("may not request plan premise recovery");
    expect(missingParent.content).toContain("parent sessionID is required");
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.prompt).not.toHaveBeenCalled();

    const mismatchedChild = mockSessions({ child: { id: "child-session", parentID: "another-parent", agent: "coder" } });
    const childMismatch = await createPlanPremiseRecoveryTool(root, mismatchedChild)
      .execute(recoveryInput(plan), recoveryContext());
    expect(childMismatch.content).toContain("parent or authorized agent did not match");
    expect(mismatchedChild.create).toHaveBeenCalledTimes(1);
    expect(mismatchedChild.prompt).not.toHaveBeenCalled();
  });

  it("makes one handoff, does not retry a stale CAS, and fails without a successful state change", async () => {
    const root = await fixtureRoot("cas-no-retry");
    const plan = await approvedPlan(root, ["Investigate whether The source contains the obsolete figure 12."]);
    const sessions = mockSessions({ messages: [{
      type: "assistant",
      agent: "coder",
      content: [{ type: "text", text: "CAS conflict: the active plan revision changed; no mutation was made." }],
    }] });
    const tool = createPlanPremiseRecoveryTool(root, sessions);
    const result = await tool.execute(recoveryInput(plan), recoveryContext());
    const payload = JSON.parse(result.content) as Record<string, unknown>;

    expect(payload).toMatchObject({
      correctionHappened: false,
      samePlanID: true,
      planID: plan.id,
      revision: plan.revision,
      status: "active",
      approval: "approved",
      childResponse: "CAS conflict: the active plan revision changed; no mutation was made.",
    });
    expect(result.metadata.title).toBe("Plan premise recovery failed");
    expect(payload.error).toContain("exactly one CAS-protected state change");
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.prompt).toHaveBeenCalledTimes(1);
    expect(sessions.wait).toHaveBeenCalledTimes(1);
    expect(sessions.context).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the coder child returns no assistant response", async () => {
    const root = await fixtureRoot("missing-response");
    const plan = await approvedPlan(root, ["Investigate whether The source contains the obsolete figure 12."]);
    const sessions = mockSessions({ messages: [] });
    const tool = createPlanPremiseRecoveryTool(root, sessions);
    const result = await tool.execute(recoveryInput(plan), recoveryContext());
    const payload = JSON.parse(result.content) as Record<string, unknown>;

    expect(payload).toMatchObject({ correctionHappened: false, revision: plan.revision, childResponse: null });
    expect(payload.error).toContain("no assistant response");
    expect(sessions.prompt).toHaveBeenCalledTimes(1);
    expect(sessions.wait).toHaveBeenCalledTimes(1);
    expect(sessions.context).toHaveBeenCalledTimes(1);
  });

  it("recognizes material-scope add, approval reset, and completed-task preservation", async () => {
    const root = await fixtureRoot("approval-reset");
    const initial = await approvedPlan(root, ["The source contains the obsolete figure 12."]);
    const completed = await updatePlanTask(
      root,
      initial.id,
      initial.revision,
      "T001",
      "completed",
      "Prior conclusion recorded; preserve this completed history.",
    );
    const sessions = mockSessions({
      onPrompt: async () => {
        const request = recoveryInput(completed);
        await addPlanTasks(
          root,
          completed.id,
          completed.revision,
          [`${request.correctedPremise} ${request.evidence}`],
        );
      },
      messages: [{
        type: "assistant",
        agent: "coder",
        content: [{ type: "text", text: "Added one material-scope task; renewed approval is required." }],
      }],
    });
    const tool = createPlanPremiseRecoveryTool(root, sessions);
    const result = await tool.execute(
      recoveryInput(completed, { taskID: "T001" }),
      recoveryContext("reviewer"),
    );
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    const after = (await readActivePlan(root))?.plan;

    expect(payload).toMatchObject({
      correctionHappened: true,
      samePlanID: true,
      planID: completed.id,
      revision: completed.revision + 1,
      status: "active",
      approval: "pending",
      renewedApprovalRequired: true,
      childResponse: "Added one material-scope task; renewed approval is required.",
    });
    expect(after?.tasks).toHaveLength(2);
    expect(after?.tasks[0]).toEqual(completed.tasks[0]);
    expect(after?.tasks[1]?.text).toContain("The source confirms the figure is 24.");
  });

  it("registers the captured native session tool only for roles without plan mutation authority", async () => {
    const root = await fixtureRoot("native-registration");
    const plan = await approvedPlan(root, ["Investigate whether The source contains the obsolete figure 12."]);
    const sessions = mockSessions({
      onPrompt: async () => {
        await updatePlanTask(
          root,
          plan.id,
          plan.revision,
          "T001",
          "blocked",
          "The source confirms the figure is 24. Primary source: report section 4, table 2.",
        );
      },
    });
    const added = new Map<string, { name: string }>();
    const transform = vi.fn(async (callback: (editor: { add: (tool: never) => void }) => void) => {
      callback({ add: (tool) => {
        const nativeTool = tool as { name: string };
        added.set(nativeTool.name, nativeTool);
      } });
    });
    const cleanup = await (aria.setup as (context: unknown) => Promise<unknown>)({
      location: { project: { directory: root } },
      session: sessions,
      tool: { transform },
    } as never);
    await (cleanup as (() => Promise<void> | void) | undefined)?.();
    const permissions = effectiveRolePermissions();

    expect(added.has(PLAN_PREMISE_RECOVERY_TOOL_NAME)).toBe(true);
    const recoveryTool = added.get(PLAN_PREMISE_RECOVERY_TOOL_NAME) as unknown as {
      execute: (input: unknown, context: { agent: string; sessionID: string }) => Promise<{
        content: string;
        metadata: { title: string };
      }>;
    };
    const result = await recoveryTool.execute(recoveryInput(plan), recoveryContext("reviewer"));
    expect(result.metadata.title).toBe("Recovered plan premise");
    expect(sessions.create).toHaveBeenCalledTimes(1);
    for (const role of PLAN_PREMISE_RECOVERY_ROLES) {
      expect(permissions[role][PLAN_PREMISE_RECOVERY_TOOL_NAME]).toBe("allow");
    }
    for (const role of ["coder", "planner", "architect"] as const) {
      expect(permissions[role][PLAN_PREMISE_RECOVERY_TOOL_NAME]).toBe("deny");
    }
    expect(permissions.coder.plan).toBe("allow");
  });
});
