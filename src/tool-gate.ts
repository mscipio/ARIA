/**
 * Tool gate. OpenCode checks permissions per call only inside tools that call
 * `permission.assert`; the tool list is filtered only by rules that deny a tool outright. A tool
 * that never asserts therefore runs whenever it is visible, whatever an `ask` rule says.
 *
 * OpenCode v2.3.0 records no provenance on a registered tool (Tool.Info has only name, namespace,
 * permission and Code Mode options), so a name can never prove that a tool asserts by itself.
 * The gate therefore asserts `action = <tool name>, resource = *` in `tool.execute.before` for
 * EVERY tool except the exact names of OpenCode's built-in tools that assert natively. That
 * includes MCP tools. To avoid asking twice for an MCP tool (which asserts the same action again
 * inside its own execute), `createApprovalCarry` lets that second, identical check through ONLY
 * for the same session, tool call and action, once, within a short window, and only after the
 * gate's check succeeded. Deny is never affected.
 *
 * Residual risk: a third-party plugin that registers a tool under a built-in name (e.g. `read`)
 * replaces the built-in and is not gated. Detecting that would need registry provenance OpenCode
 * does not expose.
 */
export const NATIVE_ASSERTING: ReadonlySet<string> = new Set([
  "read", "edit", "write", "patch", "glob", "grep", "shell", "question", "skill", "subagent", "todowrite",
  "webfetch", "websearch", "execute", "experimental_image_generate",
  "opencode_list_mcp_resources", "opencode_read_mcp_resource", "opencode_watch_mcp_event", "opencode_worktree_remove",
  // ARIA's own tools that assert themselves.
  "aria_git",
  "aria_review_verdict",
]);

export const needsGate = (tool: string): boolean => !NATIVE_ASSERTING.has(tool);

const CARRY_MS = 60_000;

export interface CarryEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly source?: { readonly type: string; readonly id?: string } | undefined;
  effect: "allow" | "ask" | "deny";
}

/** Remembers gate approvals per (session, call, action) and lets exactly one identical follow-up `ask` through. */
export function createApprovalCarry(now: () => number = Date.now) {
  const granted = new Map<string, number>();
  const key = (sessionID: string, callID: string, action: string) => `${sessionID}\u0000${callID}\u0000${action}`;
  const prune = () => {
    const t = now();
    for (const [k, at] of granted) if (t - at > CARRY_MS) granted.delete(k);
  };
  return {
    record(sessionID: string, callID: string, action: string) {
      prune();
      granted.set(key(sessionID, callID, action), now());
    },
    hook(event: CarryEvent) {
      if (event.effect !== "ask" || event.source?.type !== "tool" || !event.source.id) return;
      const k = key(event.sessionID, event.source.id, event.action);
      const at = granted.get(k);
      if (at === undefined) return;
      granted.delete(k);
      if (now() - at <= CARRY_MS) event.effect = "allow";
    },
    size: () => granted.size,
  };
}
