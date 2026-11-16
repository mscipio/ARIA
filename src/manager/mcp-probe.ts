import { spawn } from "node:child_process";

/**
 * Minimal MCP stdio client: start the server, `initialize`, `tools/list`, stop. Used to confirm a
 * local server's identity (serverInfo) and its real tool inventory, so ARIA's permission rules can
 * be checked against registered names instead of assumed ones. It calls a tool only when asked for
 * a readiness check, and only the read-only tool the manifest names for that purpose.
 */

export interface ProbeResult {
  readonly ok: boolean;
  readonly server?: { name?: string; version?: string };
  readonly tools: readonly string[];
  readonly error?: string;
  /** Result of the optional readiness call. */
  readonly call?: { readonly ok: boolean; readonly detail: string };
}

export function probeTools(command: string, args: readonly string[], env: Record<string, string> = {}, timeoutMs = 30_000, call?: { tool: string; args: Record<string, unknown> }): Promise<ProbeResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let buffer = "";
    let stderr = "";
    let server: ProbeResult["server"];
    const tools: string[] = [];
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      done(r);
    };
    const timer = setTimeout(() => finish({ ok: false, tools, error: `no answer within ${timeoutMs / 1000}s${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}` }), timeoutMs);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    const listPage = (cursor?: string) => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
    child.on("error", (error) => finish({ ok: false, tools, error: error.message }));
    child.on("close", (code) => finish({ ok: false, tools, error: `server exited (${code})${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}` }));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buffer += d;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 3) {
          const result = msg.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
          const text = (result?.content ?? []).map((c) => c.text ?? "").join(" ").trim().slice(0, 300);
          // Some servers (zotero-mcp) report failures as plain text instead of isError.
          const failed = Boolean(result?.isError) || /^error\b/i.test(text);
          return finish({ ok: true, server, tools, call: msg.error ? { ok: false, detail: msg.error.message ?? "error" } : { ok: !failed, detail: text || "(empty result)" } });
        }
        if (msg.error) return finish({ ok: false, server, tools, error: msg.error.message ?? "MCP error" });
        if (msg.id === 1) {
          server = msg.result?.serverInfo as ProbeResult["server"];
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          listPage();
        } else if (msg.id === 2) {
          for (const t of (msg.result?.tools as { name?: string }[] | undefined) ?? []) if (t.name) tools.push(t.name);
          const next = msg.result?.nextCursor as string | undefined;
          if (next) listPage(next);
          else if (call && tools.includes(call.tool)) send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: call.tool, arguments: call.args } });
          else finish({ ok: true, server, tools, ...(call ? { call: { ok: false, detail: `${call.tool} is not offered by the server` } } : {}) });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "aria-manager", version: "1" } },
    });
  });
}

// ------------------------------------------------------------------ remote (streamable HTTP)

/**
 * MCP protocol versions the integration supports: the list in the MCP SDK bundled with OpenCode
 * 2.3.0 (SUPPORTED_PROTOCOL_VERSIONS). ARIA asks for the newest and accepts any of these.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;
const REQUESTED = SUPPORTED_PROTOCOL_VERSIONS[0];
const MAX_BODY = 1024 * 1024;

/**
 * What a remote `initialize` established, from weakest to strongest:
 *   unreachable / timeout   no HTTP answer
 *   reachable               HTTP answered, but not with a usable MCP response (e.g. 404, 500)
 *   auth                    401/403: authentication required or rejected
 *   incompatible            an answer, but not a valid MCP initialize result (bad JSON, wrong id,
 *                           missing serverInfo, unsupported protocol, wrong content type, redirect)
 *   rejected                a valid JSON-RPC error response to initialize
 *   initialized             a valid initialize result with a supported protocol version
 * `initialized` is not operational readiness: a remote server's own backend is not exercised.
 */
export type RemoteClass = "unreachable" | "timeout" | "reachable" | "auth" | "incompatible" | "rejected" | "initialized";

export interface RemoteProbe {
  readonly ok: boolean;
  readonly class: RemoteClass;
  readonly detail: string;
  readonly status?: number;
  readonly protocolVersion?: string;
  readonly server?: { name?: string; version?: string };
  readonly session?: string;
}

class Incompatible extends Error {}

/** Validate a JSON-RPC response to our initialize request. */
function judge(msg: unknown, id: string): Omit<RemoteProbe, "status" | "session"> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, class: "incompatible", detail: "response is not a JSON-RPC object" };
  const m = msg as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (m.jsonrpc !== "2.0") return { ok: false, class: "incompatible", detail: `jsonrpc is ${JSON.stringify(m.jsonrpc)}, not "2.0"` };
  if (m.id !== id) return { ok: false, class: "incompatible", detail: `response id ${JSON.stringify(m.id)} does not match the request id` };
  if (m.error !== undefined) {
    const code = typeof m.error === "object" && m.error ? m.error.code : undefined;
    const text = typeof m.error === "object" && m.error && typeof m.error.message === "string" ? m.error.message : "no message";
    return { ok: false, class: "rejected", detail: `initialize rejected (JSON-RPC error${typeof code === "number" ? ` ${code}` : ""}: ${text.slice(0, 200)})` };
  }
  const r = m.result as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown }; capabilities?: unknown } | undefined;
  if (!r || typeof r !== "object") return { ok: false, class: "incompatible", detail: "no initialize result" };
  if (typeof r.protocolVersion !== "string") return { ok: false, class: "incompatible", detail: "initialize result has no protocolVersion" };
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(r.protocolVersion)) return { ok: false, class: "incompatible", detail: `server negotiated protocol ${r.protocolVersion}, which OpenCode 2.3.0 does not support (${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})` };
  if (!r.serverInfo || typeof r.serverInfo !== "object" || typeof r.serverInfo.name !== "string") return { ok: false, class: "incompatible", detail: "initialize result has no serverInfo.name" };
  if (!r.capabilities || typeof r.capabilities !== "object") return { ok: false, class: "incompatible", detail: "initialize result has no capabilities object" };
  const server = { name: r.serverInfo.name, ...(typeof r.serverInfo.version === "string" ? { version: r.serverInfo.version } : {}) };
  return { ok: true, class: "initialized", detail: `MCP initialized: ${server.name} ${server.version ?? ""} (protocol ${r.protocolVersion})`.replace(/\s+\(/, " ("), protocolVersion: r.protocolVersion, server };
}

/**
 * Read an SSE body incrementally until the event that answers `id`. Lines may end in CRLF, LF or
 * CR; a CR at the end of a chunk is held back because the next chunk may start with its LF.
 * Server requests and notifications on the stream are skipped. Malformed event data is an error.
 */
async function readSse(body: ReadableStream<Uint8Array>, id: string): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let data: string[] = [];
  let event = "message";
  const dispatch = (): unknown => {
    if (!data.length) return undefined;
    const text = data.join("\n");
    const kind = event;
    data = [];
    event = "message";
    if (kind !== "message") return undefined;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Incompatible(`malformed SSE event data: ${JSON.stringify(text.slice(0, 80))}`);
    }
    const m = msg as { id?: unknown; method?: unknown };
    if (m && typeof m === "object" && m.method !== undefined) return undefined; // request or notification
    if (m && typeof m === "object" && m.id !== undefined && m.id !== id) throw new Incompatible(`response id ${JSON.stringify(m.id)} does not match the request id`);
    return msg;
  };
  const line = (l: string): unknown => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return undefined;
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    return undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      total += value.byteLength;
      if (total > MAX_BODY) throw new Incompatible("SSE stream exceeded 1 MiB without an initialize response");
      buffer += decoder.decode(value, { stream: true });
      let held = "";
      if (buffer.endsWith("\r")) {
        held = "\r";
        buffer = buffer.slice(0, -1);
      }
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = (parts.pop() as string) + held;
      for (const p of parts) {
        const msg = line(p);
        if (msg !== undefined) return msg;
      }
    }
    for (const p of buffer.split(/\r\n|\r|\n/)) {
      const msg = line(p);
      if (msg !== undefined) return msg;
    }
    const last = dispatch();
    if (last !== undefined) return last;
    throw new Incompatible("SSE stream ended without an initialize response");
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BODY) throw new Incompatible("response body larger than 1 MiB");
  const text = new TextDecoder().decode(buf);
  try {
    return JSON.parse(text);
  } catch {
    throw new Incompatible(`response is not valid JSON: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

/**
 * Remote MCP readiness: a real `initialize` over streamable HTTP, validated, followed by
 * `notifications/initialized`; a session the server opened is closed with DELETE (also after a
 * rejected or invalid initialize). Uses the URL and headers of the actual config entry.
 * Redirects are not followed (they are reported as incompatible). Needs the network.
 */
export async function probeRemote(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<RemoteProbe> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const id = `aria-init-${Math.random().toString(36).slice(2, 10)}`;
  const base = { ...(opts.headers ?? {}) };
  let session: string | undefined;
  let status: number | undefined;
  let result: RemoteProbe;
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { ...base, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: REQUESTED, capabilities: {}, clientInfo: { name: "aria-manager", version: "1" } } }),
      signal,
    });
    status = res.status;
    session = res.headers.get("mcp-session-id") ?? undefined;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (res.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      result = { ok: false, class: "incompatible", detail: `HTTP ${status} redirect${res.headers.get("location") ? ` to ${res.headers.get("location")}` : ""}; ARIA does not follow redirects for MCP endpoints (configure the final URL)` };
    } else if (status === 401 || status === 403) {
      result = { ok: false, class: "auth", detail: `HTTP ${status}: authentication ${status === 401 ? "required" : "refused"}${res.headers.get("www-authenticate") ? ` (${res.headers.get("www-authenticate")?.slice(0, 120)})` : ""}` };
    } else if (!res.ok) {
      // A JSON-RPC error body on a 4xx is still a rejection worth naming.
      let detail = `HTTP ${status}`;
      if (type === "application/json") {
        try {
          const j = judge(await readJsonBody(res), id);
          if (j.class === "rejected") detail += `; ${j.detail}`;
        } catch {
          /* the HTTP status says enough */
        }
      }
      result = { ok: false, class: "reachable", detail: `${detail}: the endpoint answered but did not initialize an MCP session` };
    } else if (type === "application/json") {
      result = judge(await readJsonBody(res), id);
    } else if (type === "text/event-stream") {
      if (!res.body) throw new Incompatible("empty SSE response");
      result = judge(await readSse(res.body, id), id);
    } else {
      result = { ok: false, class: "incompatible", detail: `unexpected content type ${JSON.stringify(type || "(none)")} (MCP uses application/json or text/event-stream)` };
    }
  } catch (error) {
    const e = error as Error;
    if (error instanceof Incompatible) result = { ok: false, class: "incompatible", detail: e.message };
    else if (signal.aborted || e.name === "TimeoutError" || e.name === "AbortError") result = { ok: false, class: "timeout", detail: `no complete answer within ${timeoutMs / 1000}s` };
    else {
      const cause = (e as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } }).cause;
      result = { ok: false, class: "unreachable", detail: `unreachable: ${cause?.code ?? cause?.errors?.find((x) => x.code)?.code ?? cause?.message ?? e.message}` };
    }
  }
  const followUp = { ...base, ...(session ? { "mcp-session-id": session } : {}), ...(result.protocolVersion ? { "mcp-protocol-version": result.protocolVersion } : {}) };
  const quick = () => AbortSignal.timeout(Math.min(5000, timeoutMs));
  if (result.ok) {
    try {
      const r = await fetch(url, { method: "POST", redirect: "manual", headers: { ...followUp, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: quick() });
      await r.body?.cancel().catch(() => undefined);
    } catch {
      /* the notification is a courtesy; initialize already succeeded */
    }
  }
  if (session) {
    try {
      const r = await fetch(url, { method: "DELETE", redirect: "manual", headers: followUp, signal: quick() });
      await r.body?.cancel().catch(() => undefined);
    } catch {
      /* a server may not support DELETE (405) or may be gone; nothing to clean up on our side */
    }
  }
  return { ...result, ...(status !== undefined ? { status } : {}), ...(session ? { session } : {}) };
}
