import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalWorktree, ensureSafeDirectory, safeProjectFile, verifySafeParent, withFileLock } from "./paths.js";
const ARIA_RDC_STATE_DIR = ".aria/rdc";
const LEGACY_STATE_DIR = ".code-ensemble";
const ACTIVE_PLAN_PATH = `${ARIA_RDC_STATE_DIR}/TASKS.md`;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_TASKS = 100;
const MAX_LINE_LENGTH = 4_000;
const METADATA_START = "<!-- aria-rdc-plan\n";
const LEGACY_METADATA_START = "<!-- code-ensemble-plan\n";
const METADATA_END = "\n-->\n";
const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function line(value, label) {
    const normalized = value.replace(/[\r\n]+/g, " ").trim();
    if (!normalized)
        throw new Error(`${label} cannot be empty`);
    return normalized.slice(0, MAX_LINE_LENGTH);
}
function taskMarker(status) {
    if (status === "completed")
        return "x";
    if (status === "in_progress")
        return "~";
    if (status === "blocked")
        return "!";
    return " ";
}
export function renderPlan(plan) {
    const metadata = JSON.stringify(plan).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    const tasks = plan.tasks.flatMap((task) => [
        `- [${taskMarker(task.status)}] **${task.id}** ${task.text}`,
        ...(task.evidence ? [`  - Evidence: ${task.evidence}`] : []),
    ]);
    return [
        `${METADATA_START}${metadata}${METADATA_END}`,
        `# Plan: ${plan.title}`,
        "",
        `Status: **${plan.status}**  `,
        `Approval: **${plan.approval}**  `,
        `Revision: **${plan.revision}**`,
        "",
        "## Tasks",
        "",
        ...tasks,
        "",
    ].join("\n");
}
function parsePlan(markdown) {
    const metadataStart = markdown.startsWith(METADATA_START)
        ? METADATA_START
        : (markdown.startsWith(LEGACY_METADATA_START) ? LEGACY_METADATA_START : undefined);
    if (!metadataStart)
        throw new Error("TASKS.md has invalid plan metadata");
    const end = markdown.indexOf(METADATA_END, metadataStart.length);
    if (end < 0)
        throw new Error("TASKS.md has incomplete plan metadata");
    const value = JSON.parse(markdown.slice(metadataStart.length, end));
    if (value.version !== 3 ||
        typeof value.id !== "string" ||
        !PLAN_ID_PATTERN.test(value.id) ||
        typeof value.revision !== "number" ||
        !Number.isInteger(value.revision) ||
        value.revision < 1 ||
        (value.status !== "active" && value.status !== "closed") ||
        (value.approval !== "pending" && value.approval !== "approved") ||
        typeof value.title !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string" ||
        !Array.isArray(value.tasks))
        throw new Error("TASKS.md contains invalid plan data");
    if (value.status === "closed" && value.approval !== "approved") {
        throw new Error("TASKS.md contains invalid plan data");
    }
    const statuses = new Set(["pending", "in_progress", "completed", "blocked"]);
    const tasks = value.tasks.map((task, index) => {
        const expectedID = `T${String(index + 1).padStart(3, "0")}`;
        if (!task ||
            typeof task !== "object" ||
            task.id !== expectedID ||
            typeof task.text !== "string" ||
            !statuses.has(task.status))
            throw new Error(`TASKS.md contains invalid task ${index + 1}`);
        return {
            id: expectedID,
            text: line(task.text, `Task ${task.id}`),
            status: task.status,
            evidence: typeof task.evidence === "string" ? line(task.evidence, `Evidence for ${task.id}`) : undefined,
        };
    });
    if (tasks.length === 0 || tasks.length > MAX_TASKS || new Set(tasks.map((task) => task.id)).size !== tasks.length) {
        throw new Error("TASKS.md must contain between 1 and 100 uniquely identified tasks");
    }
    return { ...value, title: line(value.title, "Plan title"), tasks };
}
async function readBounded(filePath) {
    const before = await lstat(filePath);
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error("TASKS.md is not a safe regular file");
    const handle = await open(filePath, "r");
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error("TASKS.md changed while it was being opened");
        }
        if (opened.size > MAX_PLAN_BYTES)
            throw new Error("TASKS.md exceeds its size limit");
        const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_PLAN_BYTES + 1));
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        if (offset > MAX_PLAN_BYTES)
            throw new Error("TASKS.md exceeds its size limit");
        return buffer.subarray(0, offset).toString("utf8");
    }
    finally {
        await handle.close();
    }
}
async function migrateLegacyState(worktree) {
    const root = await canonicalWorktree(worktree);
    const canonicalDir = resolve(root, ARIA_RDC_STATE_DIR);
    try {
        const info = await lstat(canonicalDir);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`Path is not a safe directory: ${canonicalDir}`);
        }
        return;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const legacyDir = resolve(root, LEGACY_STATE_DIR);
    try {
        const info = await lstat(legacyDir);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`Path is not a safe directory: ${legacyDir}`);
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    await ensureSafeDirectory(root, resolve(root, ".aria"), true);
    try {
        await rename(legacyDir, canonicalDir);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY")
            throw error;
        const current = await lstat(canonicalDir).catch(() => undefined);
        if (!current || current.isSymbolicLink() || !current.isDirectory())
            throw error;
    }
}
async function activePlanFile(worktree) {
    await migrateLegacyState(worktree);
    return safeProjectFile(worktree, ACTIVE_PLAN_PATH, { createParent: true });
}
async function writePlan(root, filePath, plan, signal) {
    const markdown = renderPlan(plan);
    if (Buffer.byteLength(markdown, "utf8") > MAX_PLAN_BYTES)
        throw new Error("TASKS.md exceeds its size limit");
    await verifySafeParent(root, filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, markdown, { encoding: "utf8", flag: "wx" });
        await verifySafeParent(root, temporaryPath);
        if (signal?.aborted)
            throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
        await rename(temporaryPath, filePath);
    }
    catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
async function readUnlocked(filePath) {
    try {
        return parsePlan(await readBounded(filePath));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function requirePlanCas(plan, expectedPlanID, expectedRevision) {
    if (typeof expectedPlanID !== "string" || !PLAN_ID_PATTERN.test(expectedPlanID)) {
        throw new Error("Invalid expected plan id");
    }
    if (plan.id !== expectedPlanID) {
        throw new Error(`TASKS.md plan id conflict: expected ${expectedPlanID}, current ${plan.id}`);
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision !== plan.revision) {
        throw new Error(`TASKS.md revision conflict: expected ${expectedRevision}, current ${plan.revision}`);
    }
}
function requireActive(plan) {
    if (plan.status !== "active")
        throw new Error("TASKS.md is already closed");
}
function requireApproved(plan) {
    if (plan.approval !== "approved")
        throw new Error("TASKS.md must be approved before this operation");
}
function isMatchingClosedArchive(active, archived) {
    return (archived.id === active.id &&
        archived.status === "closed" &&
        archived.revision === active.revision + 1 &&
        archived.title === active.title &&
        archived.approval === active.approval &&
        archived.createdAt === active.createdAt &&
        JSON.stringify(archived.tasks) === JSON.stringify(active.tasks));
}
export async function readActivePlan(worktree) {
    const file = await activePlanFile(worktree);
    const plan = await readUnlocked(file.path);
    return plan ? { plan, markdown: renderPlan(plan) } : null;
}
export async function createPlan(worktree, title, tasks, signal) {
    if (tasks.length === 0 || tasks.length > MAX_TASKS)
        throw new Error("A plan requires between 1 and 100 tasks");
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        if (await readUnlocked(file.path))
            throw new Error("An active TASKS.md already exists; close it before creating another plan");
        const now = new Date().toISOString();
        const plan = {
            version: 3,
            id: randomUUID(),
            revision: 1,
            status: "active",
            approval: "pending",
            title: line(title, "Plan title"),
            createdAt: now,
            updatedAt: now,
            tasks: tasks.map((text, index) => ({
                id: `T${String(index + 1).padStart(3, "0")}`,
                text: line(text, `Task ${index + 1}`),
                status: "pending",
            })),
        };
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function approvePlan(worktree, expectedPlanID, expectedRevision, signal) {
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        if (plan.approval !== "pending")
            throw new Error("Plan is already approved");
        plan.approval = "approved";
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function updatePlanTask(worktree, expectedPlanID, expectedRevision, taskID, status, evidence, signal) {
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        requireApproved(plan);
        const task = plan.tasks.find((candidate) => candidate.id === taskID);
        if (!task)
            throw new Error(`Task ${taskID} was not found in TASKS.md`);
        task.status = status;
        if (evidence !== undefined)
            task.evidence = line(evidence, `Evidence for ${taskID}`);
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function addPlanTasks(worktree, expectedPlanID, expectedRevision, tasks, signal) {
    if (tasks.length === 0)
        throw new Error("At least one task is required");
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        if (plan.tasks.length + tasks.length > MAX_TASKS)
            throw new Error("TASKS.md cannot contain more than 100 tasks");
        const start = plan.tasks.length + 1;
        plan.tasks.push(...tasks.map((text, index) => ({
            id: `T${String(start + index).padStart(3, "0")}`,
            text: line(text, `Task ${start + index}`),
            status: "pending",
        })));
        plan.approval = "pending";
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function remediatePlanTasks(worktree, expectedPlanID, expectedRevision, tasks, signal) {
    if (tasks.length === 0)
        throw new Error("At least one remediation task is required");
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        requireApproved(plan);
        if (plan.tasks.some((task) => task.status !== "completed")) {
            throw new Error("All existing tasks must be completed before adding remediation tasks");
        }
        if (plan.tasks.length + tasks.length > MAX_TASKS)
            throw new Error("TASKS.md cannot contain more than 100 tasks");
        const start = plan.tasks.length + 1;
        plan.tasks.push(...tasks.map((text, index) => ({
            id: `T${String(start + index).padStart(3, "0")}`,
            text: line(text, `Task ${start + index}`),
            status: "pending",
        })));
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function replacePlan(worktree, expectedPlanID, expectedRevision, title, tasks, signal) {
    if (tasks.length === 0 || tasks.length > MAX_TASKS)
        throw new Error("A plan requires between 1 and 100 tasks");
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        if (plan.tasks.some((task) => task.status !== "pending" || task.evidence !== undefined)) {
            throw new Error("TASKS.md can only be replaced when every task is pending and has no evidence");
        }
        plan.title = line(title, "Plan title");
        plan.tasks = tasks.map((text, index) => ({
            id: `T${String(index + 1).padStart(3, "0")}`,
            text: line(text, `Task ${index + 1}`),
            status: "pending",
        }));
        plan.approval = "pending";
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        await writePlan(file.root, file.path, plan, signal);
        return plan;
    }, signal);
}
export async function closePlan(worktree, expectedPlanID, expectedRevision, signal) {
    const file = await activePlanFile(worktree);
    return withFileLock(file.path, async () => {
        const plan = await readUnlocked(file.path);
        if (!plan)
            throw new Error("No active TASKS.md exists");
        requireActive(plan);
        requirePlanCas(plan, expectedPlanID, expectedRevision);
        requireApproved(plan);
        if (plan.tasks.some((task) => task.status !== "completed")) {
            throw new Error("Every task must be completed before closing TASKS.md");
        }
        let closed = {
            ...plan,
            status: "closed",
            revision: plan.revision + 1,
            updatedAt: new Date().toISOString(),
        };
        const markdown = renderPlan(closed);
        const archive = await safeProjectFile(worktree, `${ARIA_RDC_STATE_DIR}/plans/${closed.id}.md`, { createParent: true });
        await verifySafeParent(archive.root, archive.path);
        let archiveHandle;
        let createdArchive = false;
        try {
            archiveHandle = await open(archive.path, "wx");
            createdArchive = true;
            await archiveHandle.writeFile(markdown, "utf8");
            await archiveHandle.sync();
            await archiveHandle.close();
        }
        catch (error) {
            await archiveHandle?.close().catch(() => undefined);
            if (error.code !== "EEXIST") {
                if (createdArchive)
                    await unlink(archive.path).catch(() => undefined);
                throw error;
            }
            const existing = await readUnlocked(archive.path).catch(() => null);
            if (!existing || !isMatchingClosedArchive(plan, existing)) {
                throw new Error(`A different archive already exists for plan ${closed.id}`);
            }
            closed = existing;
        }
        try {
            if (signal?.aborted)
                throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
            await unlink(file.path);
        }
        catch (error) {
            if (createdArchive)
                await unlink(archive.path).catch(() => undefined);
            throw error;
        }
        return { plan: closed, archived: archive.path };
    }, signal);
}
//# sourceMappingURL=plans.js.map