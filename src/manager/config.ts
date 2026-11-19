import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as jsonc from "jsonc-parser";
import { globalConfigDir, isWindows } from "./env.ts";
import { writeAtomic } from "./state.ts";

/**
 * Targeted, comment-preserving edits to OpenCode config files, and a static view of the config
 * layers. The static view mirrors OpenCode v2.3.0 discovery (config/discovery.ts) for the purpose
 * of FINDING files; it is not a resolver. When OpenCode is available, `opencode debug config` is the
 * authoritative list (see opencode.ts), and every static result is labelled as such.
 */

export type Scope = "global" | "project";
export type JsonPath = (string | number)[];

const NAMES = ["opencode.jsonc", "opencode.json"] as const;

/** The file ARIA edits for a scope: the existing one (jsonc preferred), else a new opencode.jsonc. */
export function configFile(scope: Scope, project: string): string {
  const dir = scope === "global" ? globalConfigDir() : resolve(project);
  for (const name of NAMES) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return join(dir, "opencode.jsonc");
}

export interface ConfigRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
  readonly value: Record<string, unknown>;
  readonly errors: readonly string[];
}

export function readConfig(path: string): ConfigRead {
  if (!existsSync(path)) return { path, exists: false, text: "", value: {}, errors: [] };
  const text = readFileSync(path, "utf8");
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  const messages = errors.map((e) => `${jsonc.printParseErrorCode(e.error)} at offset ${e.offset}`);
  if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) messages.push("top level is not an object");
  return { path, exists: true, text, value: (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>, errors: messages };
}

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);

export function getPath(value: unknown, path: JsonPath): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export interface Edit {
  readonly path: JsonPath;
  /** undefined removes the key / array element. */
  readonly value: unknown;
}

export interface EditPlan {
  readonly file: string;
  readonly existed: boolean;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
  readonly summary: readonly string[];
}

/** Compute (but do not write) the result of a set of edits. Comments and formatting are kept. */
export function planEdits(file: string, edits: readonly Edit[]): EditPlan {
  const read = readConfig(file);
  if (read.errors.length) throw new Error(`${file} has syntax errors (${read.errors.join("; ")}); fix it before ARIA edits it`);
  let text = read.exists && read.text.trim() ? read.text : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const summary: string[] = [];
  for (const edit of edits) {
    const current = jsonc.parse(text) as unknown;
    const before = getPath(current, edit.path);
    if (JSON.stringify(before) === JSON.stringify(edit.value)) continue;
    const format: jsonc.FormattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
    text = jsonc.applyEdits(text, jsonc.modify(text, edit.path, edit.value, { formattingOptions: format }));
    summary.push(
      edit.value === undefined
        ? `remove ${edit.path.join(".")}`
        : before === undefined
          ? `add ${edit.path.join(".")} = ${JSON.stringify(edit.value)}`
          : `change ${edit.path.join(".")}: ${JSON.stringify(before)} -> ${JSON.stringify(edit.value)}`,
    );
  }
  const errors: jsonc.ParseError[] = [];
  jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`edit of ${file} would produce invalid JSONC; nothing written`);
  return { file, existed: read.exists, before: read.text, after: text, changed: summary.length > 0, summary };
}

/** Write a planned edit, refusing if the file changed since it was planned. */
export function applyEdit(plan: EditPlan): void {
  if (!plan.changed) return;
  const now = existsSync(plan.file) ? readFileSync(plan.file, "utf8") : "";
  if (now !== plan.before) throw new Error(`${plan.file} changed since the preview; nothing written. Preview again.`);
  writeAtomic(plan.file, plan.after);
}

// ---------------------------------------------------------------- plugin entries

export interface PluginEntry {
  readonly file: string;
  readonly index: number;
  readonly raw: unknown;
  readonly spec: string;
  /** Absolute directory for a local entry (absolute, file://, ./ or ../ relative to the file). */
  readonly local: string | undefined;
  readonly options: Record<string, unknown> | undefined;
}

/** OpenCode v2.3.0 local-entry rule (core/src/config/plugin/source.ts). */
export function resolvePluginSpec(spec: string, file: string): string | undefined {
  if (spec.startsWith("file://")) return fileURLToPath(spec);
  if (spec.startsWith("./") || spec.startsWith("../")) return resolve(dirname(file), spec);
  if (isAbsolute(spec) || (isWindows && /^[A-Za-z]:[\\/]/.test(spec))) return resolve(spec);
  return undefined;
}

export function pluginEntries(read: ConfigRead): PluginEntry[] {
  const list = read.value.plugins;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw, index) => {
    const spec = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { package?: unknown }).package === "string" ? (raw as { package: string }).package : undefined;
    if (spec === undefined) return [];
    const options = raw && typeof raw === "object" ? ((raw as { options?: Record<string, unknown> }).options ?? undefined) : undefined;
    return [{ file: read.path, index, raw, spec, local: resolvePluginSpec(spec, read.path), options }];
  });
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
export const samePath = (a: string, b: string) => (isWindows ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

/** Is this directory an ARIA package (any version)? */
export function isAriaPackage(dir: string): { version: string } | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; exports?: Record<string, string> };
    if (pkg.name === "aria" && pkg.exports?.["."] && existsSync(join(dir, "prompts", "aria.md"))) return { version: pkg.version ?? "unknown" };
  } catch {
    /* not a package */
  }
  return undefined;
}

// ---------------------------------------------------------------- static layer discovery

export interface Layer {
  readonly kind: "system" | "global" | "project" | "explicit";
  readonly path: string;
}

/** Config files OpenCode v2.3.0 would consider, lowest to highest priority (managed/MDM sources not covered). */
export function staticLayers(project: string): Layer[] {
  const system = isWindows ? join(process.env.ProgramData || "C:\\ProgramData", "opencode") : process.platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode";
  const up: string[] = [];
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    up.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const out: Layer[] = [];
  for (const n of NAMES) out.push({ kind: "system", path: join(system, n) });
  for (const n of NAMES) out.push({ kind: "global", path: join(globalConfigDir(), n) });
  for (const dir of up) {
    for (const n of NAMES) out.push({ kind: "project", path: join(dir, ".opencode", n) });
    for (const n of NAMES) out.push({ kind: "project", path: join(dir, n) });
  }
  if (process.env.OPENCODE_CONFIG) out.push({ kind: "explicit", path: resolve(process.env.OPENCODE_CONFIG) });
  return out.filter((l) => existsSync(l.path));
}

/** Plugin directories auto-discovered from `plugins/` folders (global config dir and project .opencode). */
export function discoveredPluginDirs(project: string): string[] {
  const roots = [join(globalConfigDir(), "plugins"), join(resolve(project), ".opencode", "plugins")];
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) out.push(p);
      } catch {
        /* dangling link */
      }
    }
  }
  return out;
}
