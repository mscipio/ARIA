import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { globalConfigDir, run } from "./env.ts";
import type { Dependency } from "./manifest.ts";
import { getPath, readConfig, staticLayers } from "./config.ts";
import { readState, writeState } from "./state.ts";

/**
 * The OpenCode plugin file of an integration (`Dependency.plugin`), e.g. Engram's. Kept apart from
 * deps.ts so the ownership rules are in one place:
 *
 * - a file ARIA wrote is recorded in state (`owned`, kind `file`) with the SHA-256 of its content;
 *   it counts as ARIA's only while it still hashes to that value;
 * - a file that is there but not recorded is the user's (or another tool's). It is reused if it
 *   carries the integration's marker text, never rewritten and never removed;
 * - ARIA never writes a second copy: if the plugin exists in either scope, nothing is added.
 */

export type PluginScope = "global" | "project";

export interface PluginCopy {
  readonly scope: PluginScope;
  readonly file: string;
  /** file: a file in a plugins directory. array: an entry in a config file's plugin list (always the user's). */
  readonly via?: "file" | "array";
  /** ours: ARIA wrote it and it is unchanged. modified: ARIA wrote it, someone changed it. reused: not ARIA's but the genuine plugin. foreign: a file of that name that is not the plugin. */
  readonly state: "ours" | "modified" | "reused" | "foreign";
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function pluginPaths(dep: Dependency, project: string): { scope: PluginScope; file: string }[] {
  if (!dep.plugin) return [];
  return [
    { scope: "project", file: join(resolve(project), ".opencode", "plugins", dep.plugin.file) },
    { scope: "global", file: join(globalConfigDir(), "plugins", dep.plugin.file) },
  ];
}

const head = (file: string, bytes = 4096): string => {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

/**
 * Every way the integration's plugin is loaded: the canonical file in either scope, any other file
 * in a plugins directory that carries its marker (an alternate name), and any entry of a config
 * file's `plugin`/`plugins` list that names it. Anything beyond the canonical file is the user's.
 */
export function inspectPlugin(dep: Dependency, project: string): PluginCopy[] {
  const out = inspectCanonical(dep, project);
  if (!dep.plugin) return out;
  const known = new Set(out.map((c) => c.file));
  for (const { scope, file } of pluginPaths(dep, project)) {
    const dir = dirname(file);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const other = join(dir, name);
      if (known.has(other) || !/\.(ts|js|mjs|cjs)$/.test(name)) continue;
      if (dep.plugin.markers.every((m) => head(other).includes(m))) {
        out.push({ scope, file: other, state: "reused", via: "file" });
        known.add(other);
      }
    }
  }
  // The spec's package or file name must be the integration itself (`engram`, `@x/engram-opencode@1`, `/p/engram.ts`), not any path or package that merely contains the word.
  const named = new RegExp(`^${dep.id.toLowerCase()}([-_.]?(opencode|plugin|adapter))?$`);
  const nameOf = (spec: string) => (spec.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "").toLowerCase().replace(/@[^@]*$/, "").replace(/\.(ts|js|mjs|cjs)$/, "");
  const seen = new Set<string>();
  for (const layer of staticLayers(project)) {
    let value: unknown;
    try {
      value = readConfig(layer.path).value;
    } catch {
      continue; // an unreadable config file is reported elsewhere; it cannot show a registration here
    }
    for (const key of ["plugin", "plugins"]) {
      const list = getPath(value, [key]);
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const raw = Array.isArray(entry) ? entry[0] : entry;
        const spec = typeof raw === "string" ? raw : raw && typeof raw === "object" ? String((raw as { package?: unknown; path?: unknown; name?: unknown }).package ?? (raw as { path?: unknown }).path ?? (raw as { name?: unknown }).name ?? "") : "";
        const id = `${layer.path}|${key}|${spec}`;
        if (!spec || seen.has(id) || !named.test(nameOf(spec))) continue;
        seen.add(id);
        out.push({ scope: layer.kind === "global" || layer.kind === "system" ? "global" : "project", file: `${layer.path} (${key}: ${spec})`, state: "reused", via: "array" });
      }
    }
  }
  return out;
}

function inspectCanonical(dep: Dependency, project: string): PluginCopy[] {
  const out: PluginCopy[] = [];
  const { state } = readState();
  for (const { scope, file } of pluginPaths(dep, project)) {
    let info;
    try {
      info = lstatSync(file);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      out.push({ scope, file, state: "foreign" });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      out.push({ scope, file, state: "foreign" });
      continue;
    }
    const owned = state.owned.find((o) => o.kind === "file" && o.file === file);
    if (owned) out.push({ scope, file, state: owned.fingerprint === sha(text) ? "ours" : "modified" });
    else out.push({ scope, file, state: dep.plugin?.markers.every((m) => text.includes(m)) ? "reused" : "foreign" });
  }
  return out;
}

/**
 * The plugin file content for an executable, produced by the executable itself in a throw-away HOME
 * so nothing outside it is written (the same command run for real would also edit OpenCode's
 * configuration). Throws a readable error when it does not produce the file.
 */
export async function generatePlugin(dep: Dependency, exe: string): Promise<string> {
  if (!dep.plugin) throw new Error(`${dep.id} has no plugin file`);
  const home = mkdtempSync(join(tmpdir(), "aria-plugin-gen-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state") };
    // Engram's data directory does not follow HOME: pin it (and its server address) into the throw-away directory.
    env.ENGRAM_DATA_DIR = join(home, "engram-data");
    delete env.ENGRAM_URL;
    delete env.ENGRAM_PORT;
    delete env.ENGRAM_BIN;
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    const r = await run(exe, [...dep.plugin.generate], { timeoutMs: 60_000, env });
    const out = join(home, ".config", "opencode", "plugins", dep.plugin.file);
    if (!r.ok || !existsSync(out)) throw new Error(`\`${dep.executable} ${dep.plugin.generate.join(" ")}\` did not produce ${dep.plugin.file}: ${(r.error ?? r.stderr.trim()).slice(-200) || "no file written"}`);
    const text = readFileSync(out, "utf8");
    if (!dep.plugin.markers.every((m) => text.includes(m))) throw new Error(`the generated ${dep.plugin.file} is not the expected plugin`);
    return text;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Can the plugin be written into this scope? Checked before anything else is changed, so a
 * symlinked configuration directory (common with dotfile setups) is reported up front instead of
 * leaving an MCP entry without its plugin. Returns an error message, or undefined when it is fine.
 */
export function pluginWriteProblem(dep: Dependency, scope: PluginScope, project: string): string | undefined {
  const target = pluginPaths(dep, project).find((p) => p.scope === scope)?.file;
  if (!target) return undefined;
  const dir = dirname(target);
  for (const d of [dirname(dir), dir]) {
    try {
      if (lstatSync(d).isSymbolicLink()) return `${d} is a symbolic link; ARIA will not write ${dep.plugin?.file} through it. Put the plugin there yourself, or use the other scope (--scope ${scope === "global" ? "project" : "global"}); nothing was changed`;
    } catch {
      /* does not exist yet */
    }
  }
  return undefined;
}

/** Write the plugin into one scope (creating `plugins/`), refusing to replace anything. Caller holds the lock. */
export function writePlugin(dep: Dependency, scope: PluginScope, project: string, content: string): string {
  const target = pluginPaths(dep, project).find((p) => p.scope === scope)?.file;
  if (!target) throw new Error(`${dep.id} has no plugin file`);
  const dir = dirname(target);
  const parent = dirname(dir);
  for (const d of [parent, dir]) {
    if (existsSync(d) && lstatSync(d).isSymbolicLink()) throw new Error(`${d} is a symbolic link; ARIA will not write through it`);
  }
  mkdirSync(dir, { recursive: true });
  if (existsSync(target)) throw new Error(`${target} already exists; ARIA does not replace it`);
  const tmp = join(dir, `.${dep.plugin?.file}.aria-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, content, { flag: "wx", mode: 0o644 });
  try {
    renameSync(tmp, target); // a plain rename could replace a file created meanwhile; the existence check above makes that window tiny
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  chmodSync(target, 0o644);
  const s = readState().state;
  s.owned = s.owned.filter((o) => !(o.kind === "file" && o.file === target));
  s.owned.push({ file: target, path: [], kind: "file", fingerprint: sha(content) });
  writeState(s);
  return target;
}

/** Remove a plugin file ARIA wrote and nobody changed. Caller holds the lock. */
export function removePlugin(dep: Dependency, project: string): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const c of inspectPlugin(dep, project)) {
    if (c.state === "ours") {
      rmSync(c.file, { force: true });
      const s = readState().state;
      s.owned = s.owned.filter((o) => !(o.kind === "file" && o.file === c.file));
      writeState(s);
      removed.push(c.file);
    } else skipped.push(`${c.file} (${c.state === "modified" ? "changed since ARIA wrote it" : "not written by ARIA"})`);
  }
  return { removed, skipped };
}

/** Plan adapter changes without writing: callers include them in the operation's journal. */
export function planPluginSync(dep: Dependency, content: string): { edits: { file: string; before: string; after: string; fingerprint: string }[]; notes: string[] } {
  const edits: { file: string; before: string; after: string; fingerprint: string }[] = [];
  const notes: string[] = [];
  const { state } = readState();
  for (const o of state.owned.filter((x) => x.kind === "file" && dep.plugin && basename(x.file) === dep.plugin.file)) {
    try {
      for (const path of [dirname(dirname(o.file)), dirname(o.file), o.file]) {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || (path === o.file && !info.isFile())) throw new Error(`${path} is not a regular, non-symlink plugin path`);
      }
      const before = readFileSync(o.file, "utf8");
      if (sha(before) !== o.fingerprint) throw new Error("changed since ARIA wrote it");
      if (before !== content) edits.push({ file: o.file, before, after: content, fingerprint: sha(content) });
    } catch (error) {
      notes.push(`${o.file}: ${(error as Error).message}; not regenerated for ${dep.name}`);
    }
  }
  return { edits, notes };
}
