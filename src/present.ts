import type { SharedPlan } from "./plans.js";

const TASK_MARKERS: Record<string, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
  blocked: "!",
};

export function planToolTitle(args: {
  action: string;
  title?: string;
  taskID?: string;
  status?: string;
}): string {
  switch (args.action) {
    case "get":
      return "Check active plan";
    case "create":
      return args.title ? `Create plan · ${args.title}` : "Create plan";
    case "replace":
      return args.title ? `Replace plan · ${args.title}` : "Replace plan";
    case "close":
      return "Archive plan";
    case "add":
      return "Add plan tasks";
    case "remediate":
      return "Add remediation tasks";
    case "approve":
      return "Approve plan";
    case "update":
      if (args.taskID && args.status) return `Mark ${args.taskID} ${args.status.replaceAll("_", " ")}`;
      return "Update plan task";
    default:
      return "Update plan";
  }
}

export function formatToolError(message: string): { title: string; output: string } {
  return { title: "Error", output: message };
}

export function formatPlanOutput(plan: SharedPlan | null): string {
  if (!plan) return "No active plan.";
  const tasks = plan.tasks.map((task) => {
    const marker = TASK_MARKERS[task.status] ?? " ";
    const evidence = task.evidence ? `\n  evidence: ${task.evidence}` : "";
    return `- [${marker}] ${task.id} ${task.text}${evidence}`;
  });
  return [
    `Plan: ${plan.title}`,
    `Plan ID: ${plan.id}`,
    `Status: ${plan.status} · Approval: ${plan.approval} · Revision: ${plan.revision}`,
    "",
    "Tasks:",
    ...tasks,
  ].join("\n");
}

export function formatClosedPlanOutput(plan: SharedPlan, archived: string): string {
  return [
    formatPlanOutput(plan),
    "",
    `Archived to ${archived}`,
  ].join("\n");
}
