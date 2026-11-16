/**
 * User rejections of gated tool calls.
 *
 * What OpenCode v2.3.0 does when the user answers a permission prompt with Reject (verified with a
 * real server; see the comment in tool-gate.ts for the gate that uses this):
 *
 * - A plain Reject fails the assertion with `Permission.DeclinedError`, which has NO message.
 *   Reject with a typed reason fails it with `Permission.CorrectedError` (the reason is the message).
 *   The plugin `permission.assert` wrapper maps the second to a `Tool.Error` carrying the reason and
 *   leaves the first raw.
 * - Inside Code Mode (`execute`, where MCP tools live) the failed call becomes the program's result
 *   and the model's turn CONTINUES. The model is shown only the error's message or tag: "Tool.Error"
 *   when the gate's raw `DeclinedError` escapes the hook, "Permission.DeclinedError" when OpenCode's
 *   own MCP check raises it. Neither says "the user said no", so a model treats it as a transient
 *   failure and retries with a reworded query.
 * - OpenCode keeps no memory of the rejection, and a role that is allowed the same tool (for example
 *   `researcher` for Zotero reads) is never asked, so delegating the call bypasses the decision.
 *
 * This module is the small piece of state that fixes that: it classifies the failure, words an
 * unmistakable message, and remembers the rejection per (session tree, tool) until the user's next
 * prompt. The tool name is the unit because it is exactly what the user was asked about (the gate
 * asserts `action = tool name, resource = *`); a changed query never changes it, and no other tool is
 * affected. A new prompt from the user clears the tree's rejections: the user may have changed their
 * mind, and a hard block must never leave them unable to approve what they now want.
 *
 * Collateral cancellations: when the user rejects ONE pending request, OpenCode 2.3.0 fails every
 * other request pending in the same session with the same error (and the same reason). Those
 * siblings may be other tools the user never decided on, so only the request the user actually
 * answered counts. `createReplyTracker` tells them apart from the `permission.asked` and
 * `permission.replied` events: the reply published first in a burst is the user's, the rest are
 * cancellations. If that cannot be established the call is reported as cancelled and nothing is recorded.
 */

export type Rejection = { readonly kind: "declined" } | { readonly kind: "corrected"; readonly feedback: string };

export interface Denial {
  readonly tool: string;
  readonly feedback?: string | undefined;
}

type Tagged = { _tag?: unknown; message?: unknown; error?: { _tag?: unknown; feedback?: unknown } | undefined };

/** Recognise a USER rejection. Deny rules, missing sessions and every other failure return undefined and pass through unchanged. */
export function classify(error: unknown): Rejection | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Tagged;
  if (e._tag === "Permission.DeclinedError") return { kind: "declined" };
  if (e.error?._tag === "Permission.CorrectedError") {
    const feedback = typeof e.error.feedback === "string" ? e.error.feedback : typeof e.message === "string" ? e.message : "";
    return { kind: "corrected", feedback: feedback.trim() };
  }
  return undefined;
}

const RULE =
  "This is the user's decision, not a failure. Do not call it again in this request, with any arguments or reworded input, and do not ask another agent to do it. " +
  "Continue with work that does not need it, or tell the user plainly what you could not do and why. Only a new message typed by the user lifts this; if you need it, say what and why, then stop asking.";

/** The message the model sees when the user has just rejected `tool`. */
export function rejectionMessage(tool: string, rejection: Rejection): string {
  const reason = rejection.kind === "corrected" && rejection.feedback ? ` Their reason: "${rejection.feedback}".` : "";
  return `The user rejected permission to run ${tool}.${reason} ${RULE}`;
}

/** The message the model sees when it calls a tool the user already rejected in this request. ARIA does not prompt again. */
export function repeatMessage(denial: Denial): string {
  const reason = denial.feedback ? ` Their reason: "${denial.feedback}".` : "";
  return `The user already rejected permission to run ${denial.tool} in this request, so ARIA did not ask again.${reason} ${RULE}`;
}

/**
 * The message the model sees when its call failed with a rejection that was NOT established as the
 * user's own answer. `sibling`: OpenCode cancelled it because the user rejected a different request.
 * Unknown (events missing or late): nothing is claimed either way, and nothing is recorded.
 */
export function cancelledMessage(tool: string, verdict: "sibling" | undefined): string {
  return verdict === "sibling"
    ? `Your call to ${tool} did not run: the user rejected a different permission request pending in this session at the same moment, and OpenCode cancelled this one too. The user has not decided on ${tool} itself. Call it again only if you still need it.`
    : `Your call to ${tool} did not run: its permission request was rejected or cancelled, and ARIA could not confirm whether the user rejected this tool itself. Treat that as a possible refusal: do not retry it with reworded input; if you still need ${tool}, tell the user what for and why.`;
}

/** Rejections per session tree (root session id). In memory only: a restart forgets them, which only ever means being asked again. */
export function createDenials() {
  const byRoot = new Map<string, Map<string, Denial>>();
  return {
    record(root: string, tool: string, feedback?: string): void {
      const tree = byRoot.get(root) ?? new Map<string, Denial>();
      tree.set(tool, { tool, feedback: feedback || undefined });
      byRoot.set(root, tree);
    },
    find(root: string, tool: string): Denial | undefined {
      return byRoot.get(root)?.get(tool);
    },
    /** The user spoke to this session tree again: earlier rejections no longer bind. */
    clear(root: string): void {
      byRoot.delete(root);
    },
  };
}

export type Verdict = "explicit" | "sibling";

interface Request {
  readonly key: string;
  readonly session: string;
  status: "open" | Verdict | "closed";
}

const key = (session: string, callID: string, action: string) => `${session}\u0000${callID}\u0000${action}`;

/**
 * Follows permission requests through OpenCode's events. A request is "explicit" when it was the
 * first reject reply of its session while open, "sibling" when OpenCode cancelled it alongside.
 * Requests asked before the plugin subscribed are unknown, which callers must treat as undecided.
 */
export function createReplyTracker(limit = 500) {
  const requests = new Map<string, Request>();
  const prune = () => {
    while (requests.size > limit) requests.delete(requests.keys().next().value as string);
  };
  return {
    asked(data: { id: string; sessionID: string; action: string; source?: { id?: string } | undefined }): void {
      requests.set(data.id, { key: key(data.sessionID, data.source?.id ?? "", data.action), session: data.sessionID, status: "open" });
      prune();
    },
    replied(data: { requestID: string; sessionID: string; reply: string }): void {
      const request = requests.get(data.requestID);
      if (!request || request.status !== "open") return;
      if (data.reply !== "reject") {
        request.status = "closed";
        return;
      }
      request.status = "explicit";
      for (const other of requests.values()) if (other !== request && other.session === data.sessionID && other.status === "open") other.status = "sibling";
    },
    /** What happened to the request(s) behind this call, if the events have said so yet. */
    verdict(session: string, callID: string, action: string): Verdict | undefined {
      let sibling = false;
      for (const request of requests.values()) {
        if (request.key !== key(session, callID, action)) continue;
        if (request.status === "explicit") return "explicit";
        if (request.status === "sibling") sibling = true;
      }
      return sibling ? "sibling" : undefined;
    },
  };
}

/** Wait for the events to settle a call's verdict (they trail the rejection by a moment). */
export async function settle(read: () => Verdict | undefined, timeoutMs = 2000, stepMs = 10): Promise<Verdict | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v || Date.now() >= end) return v;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
