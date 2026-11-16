import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPath, readConfig } from "./config.ts";
import { packageRoot, parseVersion, satisfies } from "./env.ts";
import { MANIFEST, dependency } from "./manifest.ts";
import { opencodeVersion } from "./opencode.ts";
import { readState } from "./state.ts";

/**
 * Upgrade reconciliation, run by a STAGED release against the current environment before it is
 * activated (`aria reconcile --json`). It uses this package's own manifest, so a new release judges
 * the environment by its own requirements, not by the running release's.
 *
 * Blocking: the new release cannot work here (Node or OpenCode outside its supported range).
 * Advisory: things that still work but differ from what the new release expects (a tool pin moved,
 * an ARIA-owned MCP entry for an integration the release no longer knows, a model pin for a role
 * the release no longer defines). Nothing here changes anything.
 */

export interface Reconciliation {
  readonly blocking: string[];
  readonly advisory: string[];
}

const ROLES = ["aria", "scout", "reviewer", "planner", "scientist", "writer", "researcher", "visualizer"];

export async function reconcile(project: string): Promise<Reconciliation> {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { engines?: { node?: string } };
  const node = parseVersion(process.versions.node);
  if (pkg.engines?.node && node && !satisfies(node, pkg.engines.node)) blocking.push(`Node ${process.versions.node} does not satisfy ${pkg.engines.node}`);

  const oc = dependency("opencode");
  const v = await opencodeVersion(project);
  if (!v.ok || !v.value?.version) advisory.push(`OpenCode version could not be read (${v.error ?? "no version"}); compatibility with ${oc?.range} unchecked`);
  else if (oc?.range && !satisfies(v.value.version, oc.range)) blocking.push(`OpenCode ${v.value.version.join(".")} is outside the supported range ${oc.range}`);

  const { state } = readState();
  for (const [id, tool] of Object.entries(state.tools)) {
    const dep = dependency(id);
    if (!dep) advisory.push(`ARIA-managed tool ${id} is not in this release's manifest; it stays installed but is no longer managed`);
    else if (dep.install?.pin && tool.version && tool.version !== dep.install.pin) advisory.push(`${dep.name}: installed ${tool.version}, this release pins ${dep.install.pin} (run \`aria deps update ${id}\` after updating)`);
    if (!existsSync(tool.executable)) advisory.push(`${id}: recorded executable ${tool.executable} is missing`);
  }
  const servers = new Set(MANIFEST.map((d) => d.mcp?.server).filter(Boolean));
  for (const owned of state.owned.filter((o) => o.kind === "mcp")) {
    const server = String(owned.path[2]);
    if (!servers.has(server)) advisory.push(`ARIA-owned MCP entry ${server} in ${owned.file} is not an integration this release manages; it is left as is`);
  }
  const roles = new Set(state.models.filter((m) => m.next !== null).map((m) => m.role));
  for (const role of roles) {
    if (role === "default" || ROLES.includes(role)) continue;
    const change = state.models.findLast((m) => m.role === role);
    if (change && getPath(readConfig(change.file).value, ["agents", role, "model"]) !== undefined) advisory.push(`model pin for agents.${role} in ${change.file}: this release defines no role ${role}`);
  }
  return { blocking, advisory };
}
