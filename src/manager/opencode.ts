import { parseVersion, run, which } from "./env.ts";

/**
 * Runtime facts from OpenCode's own CLI (v2.3.0 packages/cli/src/commands): `--version`,
 * `models`, `debug agents` (resolved agents as JSON), `debug config` (configuration sources as
 * JSON), `mcp list`. These are the only "observed" values the manager shows; it keeps no model
 * registry and no config resolver of its own.
 *
 * Everything except `--version` connects to (or starts) an OpenCode server, may contact providers,
 * and can take seconds, so those probes run only when asked (`--runtime`, or `r` in the TUI).
 */

export const opencodeBin = () => process.env.OPENCODE_BIN || which("opencode");

export interface Probe<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
  readonly command: string;
}

async function call(args: string[], cwd: string, timeoutMs: number): Promise<Probe<string>> {
  const bin = opencodeBin();
  const command = `opencode ${args.join(" ")}`;
  if (!bin) return { ok: false, error: "opencode not found on PATH", command };
  const r = await run(bin, args, { cwd, timeoutMs });
  if (!r.ok) return { ok: false, error: (r.error ?? r.stderr.trim().split("\n").slice(-3).join(" ")) || `exit ${r.code}`, command };
  return { ok: true, value: r.stdout, command };
}

export async function opencodeVersion(cwd: string): Promise<Probe<{ text: string; version?: [number, number, number] }>> {
  const r = await call(["--version"], cwd, 15_000);
  if (!r.ok) return { ...r, value: undefined };
  const text = (r.value ?? "").trim();
  return { ok: true, command: r.command, value: { text, version: parseVersion(text) } };
}

/** `provider/model` ids OpenCode reports as available for this project. */
export async function listModels(cwd: string): Promise<Probe<string[]>> {
  const r = await call(["models"], cwd, 60_000);
  if (!r.ok) return { ...r, value: undefined };
  return { ok: true, command: r.command, value: (r.value ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l)) };
}

export interface RuntimeAgent {
  readonly id: string;
  readonly mode?: string;
  readonly model?: { providerID: string; id: string; variant?: string };
}

/** Agents as the server resolved them (after plugins and user config). */
export async function listAgents(cwd: string): Promise<Probe<RuntimeAgent[]>> {
  const r = await call(["debug", "agents"], cwd, 60_000);
  if (!r.ok) return { ...r, value: undefined };
  try {
    return { ok: true, command: r.command, value: JSON.parse(r.value ?? "[]") as RuntimeAgent[] };
  } catch {
    return { ok: false, command: r.command, error: "unexpected output (not JSON)" };
  }
}

/** Configuration sources as OpenCode loaded them (secrets redacted by OpenCode). */
export async function configSources(cwd: string): Promise<Probe<{ type?: string; path?: string }[]>> {
  const r = await call(["debug", "config"], cwd, 60_000);
  if (!r.ok) return { ...r, value: undefined };
  try {
    const parsed = JSON.parse(r.value ?? "[]") as { type?: string; path?: string }[];
    return { ok: true, command: r.command, value: parsed.map((e) => ({ type: e.type, path: e.path })) };
  } catch {
    return { ok: false, command: r.command, error: "unexpected output (not JSON)" };
  }
}

/** `mcp list` lines: "<icon> <name>  <status>". */
export async function mcpStatus(cwd: string): Promise<Probe<{ name: string; status: string }[]>> {
  const r = await call(["mcp", "list"], cwd, 60_000);
  if (!r.ok) return { ...r, value: undefined };
  const rows = (r.value ?? "")
    .split(/\r?\n/)
    .map((l) => /^\S+\s+(\S+)\s+(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ name: m[1] ?? "", status: (m[2] ?? "").trim() }));
  return { ok: true, command: r.command, value: rows };
}
