import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPlanTasks,
  approvePlan,
  closePlan,
  createPlan,
  readActivePlan,
  remediatePlanTasks,
  renderPlan,
  replacePlan,
  updatePlanTask,
  type SharedPlan,
} from "../src/plans";
import { withFileLock } from "../src/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-driven-code-plans-"));
  tempDirs.push(root);
  return root;
}

async function approveAndCompleteAll(root: string, plan: SharedPlan): Promise<SharedPlan> {
  let current = await approvePlan(root, plan.id, plan.revision);
  for (const task of current.tasks) {
    current = await updatePlanTask(root, current.id, current.revision, task.id, "completed", "verified");
  }
  return current;
}

describe("shared Markdown plan", () => {
  it("creates a version 3 plan with approval pending", async () => {
    const root = await project();
    const plan = await createPlan(root, "Feature", ["Implement behavior", "Run tests"]);
    expect(plan.version).toBe(3);
    expect(plan.revision).toBe(1);
    expect(plan.status).toBe("active");
    expect(plan.approval).toBe("pending");
    expect(plan.tasks.map((task) => task.id)).toEqual(["T001", "T002"]);

    const active = await readActivePlan(root);
    expect(active?.markdown).toContain("# Plan: Feature");
    expect(active?.markdown).toContain("- [ ] **T001** Implement behavior");
    expect(active?.markdown).toContain("Approval: **pending**");
    expect(active?.markdown).toContain("Revision: **1**");
  });

  it("newly created plans require approval before update", async () => {
    const root = await project();
    const plan = await createPlan(root, "Blocked", ["Task"]);
    await expect(updatePlanTask(root, plan.id, plan.revision, "T001", "in_progress"))
      .rejects.toThrow(/must be approved/);
  });

  it("approved plan allows update", async () => {
    const root = await project();
    const plan = await createPlan(root, "Approved", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    expect(approved.approval).toBe("approved");
    expect(approved.revision).toBe(2);
    const updated = await updatePlanTask(root, approved.id, approved.revision, "T001", "in_progress");
    expect(updated.tasks[0]?.status).toBe("in_progress");
  });

  it("approve requires pending status", async () => {
    const root = await project();
    const plan = await createPlan(root, "Double", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    await expect(approvePlan(root, approved.id, approved.revision))
      .rejects.toThrow(/already approved/);
  });

  it("approve uses CAS and bumps revision", async () => {
    const root = await project();
    const plan = await createPlan(root, "CAS", ["Task"]);
    const stale = plan.revision;
    const approved = await approvePlan(root, plan.id, plan.revision);
    expect(approved.revision).toBe(stale + 1);
    await expect(approvePlan(root, plan.id, stale))
      .rejects.toThrow(/revision conflict/);
  });

  it("replace invalidates approval", async () => {
    const root = await project();
    const plan = await createPlan(root, "Original", ["A", "B"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    expect(approved.approval).toBe("approved");

    const replaced = await replacePlan(root, approved.id, approved.revision, "Replaced", ["X", "Y"]);
    expect(replaced.approval).toBe("pending");

    await expect(updatePlanTask(root, replaced.id, replaced.revision, "T001", "in_progress"))
      .rejects.toThrow(/must be approved/);
  });

  it("close requires approval", async () => {
    const root = await project();
    const plan = await createPlan(root, "Close", ["Task"]);
    await expect(closePlan(root, plan.id, plan.revision))
      .rejects.toThrow(/must be approved/);
  });

  it("close requires approval and all tasks completed", async () => {
    const root = await project();
    const plan = await createPlan(root, "Close", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    await expect(closePlan(root, approved.id, approved.revision))
      .rejects.toThrow(/Every task/);
  });

  it("close succeeds when approved and all completed", async () => {
    const root = await project();
    const plan = await createPlan(root, "Close", ["Task"]);
    const completed = await approveAndCompleteAll(root, plan);
    const closed = await closePlan(root, completed.id, completed.revision);
    expect(closed.plan.status).toBe("closed");
    expect(await readActivePlan(root)).toBeNull();
  });

  it("adds tasks using expectedPlanID and expectedRevision", async () => {
    const root = await project();
    const created = await createPlan(root, "Plan", ["Task"]);
    const added = await addPlanTasks(root, created.id, created.revision, ["New"]);
    expect(added.tasks.map((task) => task.id)).toEqual(["T001", "T002"]);
    expect(added.revision).toBe(created.revision + 1);
    await expect(addPlanTasks(root, created.id, created.revision, ["Stale"])).rejects.toThrow(/revision conflict/);
  });

  it("add resets approval to pending", async () => {
    const root = await project();
    const plan = await createPlan(root, "Add", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    expect(approved.approval).toBe("approved");

    const added = await addPlanTasks(root, approved.id, approved.revision, ["New scope"]);
    expect(added.approval).toBe("pending");

    await expect(updatePlanTask(root, added.id, added.revision, "T001", "in_progress"))
      .rejects.toThrow(/must be approved/);
  });

  it("work on newly added scope cannot begin until re-approved", async () => {
    const root = await project();
    const plan = await createPlan(root, "Add gate", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    const added = await addPlanTasks(root, approved.id, approved.revision, ["New scope"]);
    await expect(updatePlanTask(root, added.id, added.revision, "T002", "in_progress"))
      .rejects.toThrow(/must be approved/);

    const reApproved = await approvePlan(root, added.id, added.revision);
    expect(reApproved.approval).toBe("approved");
    const updated = await updatePlanTask(root, reApproved.id, reApproved.revision, "T002", "in_progress");
    expect(updated.tasks[1]?.status).toBe("in_progress");
  });

  it("remediate preserves approved state", async () => {
    const root = await project();
    const plan = await createPlan(root, "Remediate", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    const completed = await updatePlanTask(root, approved.id, approved.revision, "T001", "completed", "verified");

    const remediated = await remediatePlanTasks(root, completed.id, completed.revision, ["Fix bug"]);
    expect(remediated.approval).toBe("approved");
    expect(remediated.tasks).toHaveLength(2);
    expect(remediated.tasks[1]?.text).toBe("Fix bug");
  });

  it("remediate rejects an unapproved plan", async () => {
    const root = await project();
    const plan = await createPlan(root, "Remediate unapproved", ["Task"]);
    await expect(remediatePlanTasks(root, plan.id, plan.revision, ["Fix"]))
      .rejects.toThrow(/must be approved/);
  });

  it("remediate rejects while existing tasks are incomplete", async () => {
    const root = await project();
    const plan = await createPlan(root, "Remediate incomplete", ["A", "B"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    await expect(remediatePlanTasks(root, approved.id, approved.revision, ["Fix"]))
      .rejects.toThrow(/All existing tasks must be completed/);
  });

  it("remediate appends tasks and keeps approval", async () => {
    const root = await project();
    const plan = await createPlan(root, "Remediate loop", ["Task"]);
    const approved = await approvePlan(root, plan.id, plan.revision);
    const completed = await updatePlanTask(root, approved.id, approved.revision, "T001", "completed", "verified");

    let current = completed;
    for (let i = 0; i < 3; i++) {
      current = await remediatePlanTasks(root, current.id, current.revision, [`Remediation ${i + 1}`]);
      expect(current.approval).toBe("approved");
      current = await updatePlanTask(root, current.id, current.revision, `T00${i + 2}`, "completed", `fix ${i + 1}`);
    }
    expect(current.tasks).toHaveLength(4);
    expect(current.approval).toBe("approved");
  });

  it("serializes concurrent updates so only one wins", async () => {
    const root = await project();
    const created = await createPlan(root, "Concurrent", ["First", "Second"]);
    const approved = await approvePlan(root, created.id, created.revision);
    const results = await Promise.allSettled([
      updatePlanTask(root, approved.id, approved.revision, "T001", "completed", "done"),
      updatePlanTask(root, approved.id, approved.revision, "T002", "completed", "done"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = await readActivePlan(root);
    expect(active?.plan.revision).toBe(approved.revision + 1);
  });

  it("replace preserves id/createdAt, changes title/tasks, renumbers T001 and bumps revision", async () => {
    const root = await project();
    const created = await createPlan(root, "Original", ["A", "B"]);
    const replaced = await replacePlan(root, created.id, created.revision, "Rewritten", ["Only task"]);
    expect(replaced.id).toBe(created.id);
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.title).toBe("Rewritten");
    expect(replaced.tasks).toHaveLength(1);
    const [onlyTask] = replaced.tasks;
    expect(onlyTask?.id).toBe("T001");
    expect(onlyTask?.text).toBe("Only task");
    expect(onlyTask?.status).toBe("pending");
    expect(replaced.revision).toBe(created.revision + 1);
    const active = await readActivePlan(root);
    expect(active?.plan).toEqual(replaced);
  });

  it("replace rejects an obsolete plan id or revision", async () => {
    const root = await project();
    const created = await createPlan(root, "Plan", ["Task"]);
    const replaced = await replacePlan(root, created.id, created.revision, "New", ["Task"]);
    expect(replaced.revision).toBe(created.revision + 1);
    await expect(replacePlan(root, created.id, created.revision, "Stale", ["Task"]))
      .rejects.toThrow(/revision conflict/);
    const otherID = "00000000-0000-1000-8000-000000000000";
    await expect(replacePlan(root, otherID, replaced.revision, "Bad", ["Task"]))
      .rejects.toThrow(/plan id conflict/);
  });

  it("replace rejects once a task has been started", async () => {
    const root = await project();
    const created = await createPlan(root, "Started", ["Task"]);
    const approved = await approvePlan(root, created.id, created.revision);
    const started = await updatePlanTask(root, approved.id, approved.revision, "T001", "in_progress");
    await expect(replacePlan(root, started.id, started.revision, "After start", ["Task"]))
      .rejects.toThrow(/only be replaced/);
  });

  it("rejects an ABA operation that reuses the previous plan id after close and create", async () => {
    const root = await project();
    const a = await createPlan(root, "Plan A", ["Task"]);
    const completed = await approveAndCompleteAll(root, a);
    await closePlan(root, completed.id, completed.revision);
    const b = await createPlan(root, "Plan B", ["Task"]);
    // The stale id from plan A must be rejected even though B's current revision matches.
    await expect(updatePlanTask(root, a.id, b.revision, "T001", "completed", "x"))
      .rejects.toThrow(/plan id conflict/);
    await expect(replacePlan(root, a.id, b.revision, "Hijack", ["Task"]))
      .rejects.toThrow(/plan id conflict/);
  });

  it("does not follow a symlinked .code-ensemble directory", async () => {
    const root = await project();
    const outside = await project();
    try {
      await symlink(outside, join(root, ".code-ensemble"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(createPlan(root, "Unsafe", ["Task"])).rejects.toThrow(/safe directory/);
  });

  it("rejects creating a second active plan", async () => {
    const root = await project();
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    await createPlan(root, "First", ["Task"]);
    await expect(createPlan(root, "Second", ["Task"])).rejects.toThrow(/already exists/);
  });

  it("rejects manipulated task identifiers", async () => {
    const root = await project();
    await createPlan(root, "Tampered", ["Task"]);
    const file = join(root, ".code-ensemble", "TASKS.md");
    const markdown = await readFile(file, "utf8");
    await writeFile(file, markdown.replace('"id":"T001"', '"id":"T099"'), "utf8");
    await expect(readActivePlan(root)).rejects.toThrow(/invalid task/);
  });

  it("keeps the active plan unchanged when its archive already exists", async () => {
    const root = await project();
    const created = await createPlan(root, "Collision", ["Task"]);
    const completed = await approveAndCompleteAll(root, created);
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), "existing archive", "utf8");

    await expect(closePlan(root, completed.id, completed.revision)).rejects.toThrow(/different archive/);
    const active = await readActivePlan(root);
    expect(active?.plan).toMatchObject({ status: "active", id: created.id, revision: completed.revision });
  });

  it("finishes a close interrupted after writing its archive", async () => {
    const root = await project();
    const created = await createPlan(root, "Interrupted close", ["Task"]);
    const completed = await approveAndCompleteAll(root, created);
    const archivedPlan: SharedPlan = {
      ...completed,
      status: "closed",
      revision: completed.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), renderPlan(archivedPlan), "utf8");

    const closed = await closePlan(root, completed.id, completed.revision);
    expect(closed.plan).toEqual(archivedPlan);
    expect(await readActivePlan(root)).toBeNull();
  });

  it("rejects interrupted-close recovery when archive approval differs", async () => {
    const root = await project();
    const created = await createPlan(root, "Mismatched approval", ["Task"]);
    const completed = await approveAndCompleteAll(root, created);
    // Build an archive that has everything matching EXCEPT approval is wrong.
    const mismatchedApproval: SharedPlan = {
      ...completed,
      status: "closed",
      revision: completed.revision + 1,
      approval: "pending", // wrong — should be "approved"
      updatedAt: new Date().toISOString(),
    };
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), renderPlan(mismatchedApproval), "utf8");

    await expect(closePlan(root, completed.id, completed.revision))
      .rejects.toThrow(/different archive/);
    // Active plan remains — close was not consumed.
    const active = await readActivePlan(root);
    expect(active?.plan).toMatchObject({ status: "active", id: created.id, revision: completed.revision });
  });

  it("cancels a mutation while it waits for the plan lock", async () => {
    const root = await project();
    const created = await createPlan(root, "Cancellation", ["Task"]);
    const approved = await approvePlan(root, created.id, created.revision);
    const file = join(root, ".code-ensemble", "TASKS.md");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(file, async () => {
      acquired();
      await gate;
    });
    await acquiredLock;

    const controller = new AbortController();
    const mutation = updatePlanTask(
      root,
      approved.id,
      approved.revision,
      "T001",
      "completed",
      undefined,
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(mutation).rejects.toThrow("cancelled");
    release();
    await holder;
    expect((await readActivePlan(root))?.plan).toMatchObject({ id: created.id, approval: "approved", revision: approved.revision });
  });

  it("allows only one writer to reclaim a stale lock", async () => {
    const root = await project();
    const stateDirectory = join(root, ".code-ensemble");
    await mkdir(stateDirectory);
    const lock = join(stateDirectory, "TASKS.md.lock");
    await mkdir(lock);
    const stale = new Date(Date.now() - 10_000);
    await utimes(lock, stale, stale);

    const results = await Promise.allSettled([
      createPlan(root, "First", ["Task"]),
      createPlan(root, "Second", ["Task"]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects schema v2 plans", async () => {
    const root = await project();
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    const v2Plan = {
      version: 2,
      id: "7e3f1a92-0000-4000-8000-000000000000",
      revision: 1,
      status: "active",
      title: "Old Plan",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
      tasks: [{ id: "T001", text: "Task", status: "pending" }],
    };
    const metadata = `<!-- code-ensemble-plan\n${JSON.stringify(v2Plan)}\n-->\n`;
    const markdown = `${metadata}\n# Plan: Old Plan\n\nStatus: **active**\nRevision: **1**\n\n## Tasks\n\n- [ ] **T001** Task\n`;
    await writeFile(join(root, ".code-ensemble", "TASKS.md"), markdown, "utf8");
    await expect(readActivePlan(root)).rejects.toThrow(/invalid plan data/);
  });

  it("rejects a closed plan whose approval is not approved", async () => {
    const root = await project();
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    const closedPlan: SharedPlan = {
      version: 3,
      id: "7e3f1a92-0000-4000-8000-000000000000",
      revision: 2,
      status: "closed",
      approval: "pending",
      title: "Closed but pending",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:05:00.000Z",
      tasks: [{ id: "T001", text: "Task", status: "completed" }],
    };
    const metadata = `<!-- code-ensemble-plan\n${JSON.stringify(closedPlan)}\n-->\n`;
    const markdown = `${metadata}\n# Plan: Closed but pending\n\nStatus: **closed**\nApproval: **pending**\nRevision: **2**\n\n## Tasks\n\n- [x] **T001** Task\n`;
    await writeFile(join(root, ".code-ensemble", "TASKS.md"), markdown, "utf8");
    await expect(readActivePlan(root)).rejects.toThrow(/invalid plan data/);
  });
});
