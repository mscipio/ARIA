import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { globalConfigDir, parseVersion, satisfies } from "./env.ts";
import type { Dependency, SkillPin } from "./manifest.ts";
import { interruptedResult, withLock } from "./state.ts";
import type { Change, OperationResult, Progress, Step } from "./types.ts";

/**
 * The `skill-archive` install method: a pinned upstream skill (see `SkillPin` in manifest.ts)
 * installed into an OpenCode skills directory, `<config root>/skills/<name>`, so OpenCode finds it
 * natively. This is the common lifecycle for such dependencies, not a per-skill installer.
 *
 * Safety model (all fail closed; nothing is written until both artifacts are verified):
 * - downloads are HTTPS only (bounded redirects, timeout, size cap) and must match the manifest's
 *   SHA-256 pins; the archive is parsed in memory (no tar binary), every member path is validated,
 *   hook artifacts and links are never installed;
 * - the installed tree carries `.aria-<name>.json`: owner, version, commit and a SHA-256 for every
 *   file. ARIA updates, repairs or removes a tree only when that marker is valid, no file was
 *   modified and nothing unknown is inside; a tree without the marker is somebody else's and is
 *   reused (if compatible) but never changed;
 * - publication is an atomic rename of a staged directory; repair only adds missing files and never
 *   replaces an existing entry; an update swaps the whole tree and restores the old one if the
 *   swap fails.
 */

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 300_000;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export type SkillScope = "global" | "project";
/** Test seam only: bytes served for a URL. Production uses HTTPS. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

const markerName = (pin: SkillPin) => `.aria-${pin.name}.json`;
const hostPlatform = () => `${process.platform}-${process.arch}`;
const engineFor = (pin: SkillPin) => (pin.engine && pin.engine.platform === hostPlatform() ? pin.engine : undefined);

export function skillDirs(pin: SkillPin, project: string): { scope: SkillScope; dir: string }[] {
  return [
    { scope: "project", dir: join(resolve(project), ".opencode", "skills", pin.name) },
    { scope: "global", dir: join(globalConfigDir(), "skills", pin.name) },
  ];
}

export interface SkillCopy {
  readonly scope: SkillScope;
  readonly dir: string;
  /** aria: carries a valid ARIA marker. user: anything else that is there. */
  readonly owner: "aria" | "user";
  readonly version?: string;
  readonly commit?: string;
  readonly missing: readonly string[];
  readonly modified: readonly string[];
  readonly unknown: readonly string[];
  /** Why ARIA cannot treat it as a clean copy (symlink, bad marker, unreadable). */
  readonly problems: readonly string[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function frontmatterVersion(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^version:\s*["']?([0-9][^"'\s#]*)/m.exec(fm)?.[1];
}

async function walk(root: string, skip: string): Promise<{ files: Set<string>; dirs: Set<string>; bad: string[] }> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const bad: string[] = [];
  const visit = async (dir: string, prefix: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!prefix && e.name === skip) continue;
      if (e.isDirectory()) {
        dirs.add(rel);
        await visit(join(dir, e.name), rel);
      } else if (e.isFile()) files.add(rel);
      else bad.push(rel);
    }
  };
  await visit(root, "");
  return { files, dirs, bad };
}

/** Inspect one skill directory. Read-only. Returns undefined when nothing is there. */
export async function inspectCopy(pin: SkillPin, scope: SkillScope, dir: string): Promise<SkillCopy | undefined> {
  const info = await lstatOrNull(dir);
  if (!info) return undefined;
  const base = { scope, dir, missing: [] as string[], modified: [] as string[], unknown: [] as string[] };
  if (info.isSymbolicLink()) return { ...base, owner: "user", problems: ["is a symbolic link; ARIA does not follow or replace it"] };
  if (!info.isDirectory()) return { ...base, owner: "user", problems: ["exists and is not a directory"] };
  const markerPath = join(dir, markerName(pin));
  const mInfo = await lstatOrNull(markerPath);
  if (!mInfo) {
    let version: string | undefined;
    try {
      version = frontmatterVersion(await readFile(join(dir, "SKILL.md"), "utf8"));
    } catch {
      /* no readable SKILL.md */
    }
    return { ...base, owner: "user", ...(version ? { version } : {}), problems: [] };
  }
  const bad = (why: string): SkillCopy => ({ ...base, owner: "user", problems: [`ownership marker is invalid (${why}); treated as not ARIA's`] });
  if (mInfo.isSymbolicLink() || !mInfo.isFile()) return bad("not a regular file");
  let marker: { owner?: unknown; skill?: unknown; version?: unknown; commit?: unknown; files?: unknown };
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return bad("unreadable JSON");
  }
  if (marker.owner !== "aria" || marker.skill !== pin.name || typeof marker.version !== "string" || typeof marker.commit !== "string" || typeof marker.files !== "object" || marker.files === null || Array.isArray(marker.files)) return bad("owner, skill or fields do not match");
  const files = marker.files as Record<string, unknown>;
  for (const [rel, h] of Object.entries(files)) {
    if (rel === markerName(pin) || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..") || typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return bad(`unsafe entry ${JSON.stringify(rel)}`);
  }
  const tree = await walk(dir, markerName(pin));
  const problems = tree.bad.map((b) => `${b} is a link or special file`);
  const unknown = [...tree.files].filter((f) => !(f in files));
  for (const d of tree.dirs) if (!Object.keys(files).some((f) => f.startsWith(`${d}/`))) unknown.push(`${d}/`);
  const missing: string[] = [];
  const modified: string[] = [];
  for (const [rel, h] of Object.entries(files)) {
    if (!tree.files.has(rel)) {
      missing.push(rel);
      continue;
    }
    const abs = join(dir, ...rel.split("/"));
    if (sha256(await readFile(abs)) !== h) modified.push(rel);
    else if (rel === pin.engine?.relative && ((await stat(abs)).mode & 0o111) === 0) modified.push(`${rel} (not executable)`);
  }
  return { ...base, owner: "aria", version: marker.version, commit: marker.commit, missing: missing.sort(), modified: modified.sort(), unknown: unknown.sort(), problems };
}

export async function inspectSkill(dep: Dependency, project: string): Promise<SkillCopy[]> {
  const pin = dep.skill;
  if (!pin) return [];
  const out: SkillCopy[] = [];
  for (const { scope, dir } of skillDirs(pin, project)) {
    try {
      const c = await inspectCopy(pin, scope, dir);
      if (c) out.push(c);
    } catch (error) {
      out.push({ scope, dir, owner: "user", missing: [], modified: [], unknown: [], problems: [(error as Error).message] });
    }
  }
  return out;
}

/** Version/compatibility of a user-owned copy against the manifest range. */
export function compatible(dep: Dependency, copy: SkillCopy): boolean {
  const v = copy.version ? parseVersion(copy.version) : undefined;
  return Boolean(v && dep.range && satisfies(v, dep.range));
}

export const isCurrent = (pin: SkillPin, c: SkillCopy) => c.owner === "aria" && c.version === pin.version && c.commit === pin.commit;
export const isClean = (c: SkillCopy) => c.missing.length + c.modified.length + c.unknown.length + c.problems.length === 0;

// ---------------------------------------------------------------------------------------------
// Download and extraction
// ---------------------------------------------------------------------------------------------

export async function fetchHttps(url: string): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!current.startsWith("https://")) throw new Error(`refusing non-HTTPS URL ${current}`);
    const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new Error(`HTTP ${res.status} without Location from ${current}`);
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`);
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${current}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`download from ${url} exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    return bytes;
  }
}

export async function fetchVerified(fetcher: Fetcher, url: string, expected: string, progress: Progress): Promise<Buffer> {
  progress(`downloading ${url}`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await fetcher(url));
  } catch (error) {
    throw new Error(`download failed: ${url}: ${(error as Error).message}`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: got ${actual}, pinned ${expected}. Refusing to use it; nothing was written`);
  return bytes;
}

const octal = (field: Buffer): number => {
  if ((field[0] ?? 0) & 0x80) throw new Error("base-256 tar fields are not supported");
  const t = field.toString("ascii").replace(/\0[\s\S]*$/, "").trim();
  if (t === "") return 0;
  if (!/^[0-7]+$/.test(t)) throw new Error("invalid tar number");
  return Number.parseInt(t, 8);
};

export function readTar(buf: Buffer): { name: string; type: string; data: Buffer }[] {
  const members: { name: string; type: string; data: Buffer }[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  const cstr = (b: Buffer) => {
    const e = b.indexOf(0);
    return (e === -1 ? b : b.subarray(0, e)).toString("utf8");
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const stored = octal(h.subarray(148, 156));
    const size = octal(h.subarray(124, 136));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    if (sum !== stored) throw new Error("tar header checksum mismatch");
    const start = off + 512;
    if (start + size > buf.length) throw new Error("truncated tar member");
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    const t = h[156] ?? 0;
    const type = t === 0 ? "0" : String.fromCharCode(t);
    if (type === "x") {
      pax = {};
      let pos = 0;
      while (pos < data.length) {
        const sp = data.indexOf(0x20, pos);
        const len = sp === -1 ? Number.NaN : Number.parseInt(data.subarray(pos, sp).toString("ascii"), 10);
        if (!Number.isFinite(len) || len <= 0 || pos + len > data.length) throw new Error("malformed pax header");
        const rec = data.subarray(sp + 1, pos + len - 1).toString("utf8");
        const eq = rec.indexOf("=");
        if (eq > 0) pax[rec.slice(0, eq)] = rec.slice(eq + 1);
        pos += len;
      }
      continue;
    }
    if (type === "g" || type === "K") continue;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const ustar = h.subarray(257, 262).toString("ascii") === "ustar";
    const prefix = ustar ? cstr(h.subarray(345, 500)) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    pax = {};
    longName = undefined;
    members.push({ name, type, data });
  }
  return members;
}

const isHook = (seg: string) => seg === "hooks" || /^hooks\.(json|jsonc|js|mjs|cjs|ts|sh|py)$/.test(seg);

function safeRel(rel: string): boolean {
  return rel !== "" && !rel.startsWith("/") && !rel.includes("\\") && !rel.includes("\0") && !/^[A-Za-z]:/.test(rel) && !rel.split("/").some((s) => s === "" || s === "." || s === "..");
}

interface Payload {
  readonly files: Map<string, { data: Buffer; mode: number }>;
  readonly notes: string[];
}

async function buildPayload(pin: SkillPin, fetcher: Fetcher, progress: Progress): Promise<Payload> {
  const archive = await fetchVerified(fetcher, pin.archiveUrl, pin.archiveSha256, progress);
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error(`archive is not valid gzip: ${(error as Error).message}`);
  }
  const files = new Map<string, { data: Buffer; mode: number }>();
  for (const m of readTar(tar)) {
    if (m.name === "" || m.name.startsWith("/") || m.name.includes("\\") || m.name.includes("\0") || /^[A-Za-z]:/.test(m.name)) throw new Error(`unsafe archive member ${JSON.stringify(m.name)}`);
    const segs = m.name.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.includes("..")) throw new Error(`unsafe archive member ${JSON.stringify(m.name)}`);
    const rel = segs.slice(1).join("/");
    const dest = rel === "LICENSE" ? "LICENSE" : rel.startsWith(pin.sourcePrefix) ? rel.slice(pin.sourcePrefix.length) : undefined;
    if (!dest || dest.split("/").some(isHook)) continue;
    if (m.type === "5") continue;
    if (m.type !== "0" && m.type !== "7") throw new Error(`archive member ${JSON.stringify(m.name)} is a link or special file`);
    if (!safeRel(dest) || dest === markerName(pin)) throw new Error(`unsafe destination ${JSON.stringify(dest)}`);
    if (files.has(dest)) throw new Error(`duplicate archive member ${JSON.stringify(m.name)}`);
    files.set(dest, { data: m.data, mode: 0o644 });
  }
  const skill = files.get("SKILL.md");
  if (!skill) throw new Error(`archive has no ${pin.sourcePrefix}SKILL.md`);
  const declared = frontmatterVersion(skill.data.toString("utf8"));
  if (declared !== pin.version) throw new Error(`SKILL.md declares version ${declared ?? "(none)"}, expected ${pin.version}`);
  const lic = files.get("LICENSE")?.data.toString("utf8");
  if (!lic || !pin.licenseMarkers.every((s) => lic.includes(s))) throw new Error("the archive's LICENSE is not the expected licence");
  const notes: string[] = [];
  const engine = engineFor(pin);
  if (pin.engine && !engine) notes.push(`the pinned native helper supports ${pin.engine.platform} only (this host is ${hostPlatform()}); the skill is installed without it`);
  if (engine) {
    if (files.has(engine.relative)) throw new Error(`archive contains the reserved path ${engine.relative}`);
    files.set(engine.relative, { data: await fetchVerified(fetcher, engine.url, engine.sha256, progress), mode: 0o755 });
  }
  return { files, notes };
}

function markerText(pin: SkillPin, payload: Payload): string {
  const hashes: Record<string, string> = {};
  for (const rel of [...payload.files.keys()].sort()) hashes[rel] = sha256((payload.files.get(rel) as { data: Buffer }).data);
  return `${JSON.stringify({ owner: "aria", skill: pin.name, version: pin.version, commit: pin.commit, files: hashes }, null, 2)}\n`;
}

async function stage(pin: SkillPin, skillsDir: string, payload: Payload): Promise<string> {
  await mkdir(skillsDir, { recursive: true });
  const dir = await mkdtemp(join(skillsDir, `.${pin.name}-stage-`));
  try {
    for (const [rel, f] of payload.files) {
      const target = join(dir, ...rel.split("/"));
      if (!target.startsWith(`${resolve(dir)}${sep}`)) throw new Error(`path escapes staging: ${rel}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.data, { flag: "wx", mode: f.mode });
      await chmod(target, f.mode);
    }
    await writeFile(join(dir, markerName(pin)), markerText(pin, payload), { flag: "wx", mode: 0o644 });
    await chmod(dir, 0o755);
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export type Intent = "install" | "update" | "repair";

export interface SkillOpts {
  readonly scope: SkillScope;
  readonly project: string;
  readonly dryRun: boolean;
  readonly intent: Intent;
  readonly progress?: Progress;
  readonly fetcher?: Fetcher;
}

const blocked = (dryRun: boolean, why: string, messages: string[] = []): OperationResult => ({ ok: false, dryRun, outcome: "blocked", changes: [], messages, errors: [], blocked: why });
const failed = (dryRun: boolean, error: string): OperationResult => ({ ok: false, dryRun, outcome: "failed", changes: [], messages: [], errors: [error] });

/**
 * Install, update or repair the pinned skill in one scope. Decides from what is actually on disk:
 * absent → install; ARIA-owned and current → unchanged; ARIA-owned with missing files → restore
 * them; ARIA-owned older version → swap (update only); modified, unknown or foreign content →
 * blocked, never overwritten.
 */
export async function installSkill(dep: Dependency, opts: SkillOpts): Promise<OperationResult> {
  const gate = interruptedResult(opts.dryRun);
  if (gate) return gate;
  const pin = dep.skill;
  if (!pin) return failed(opts.dryRun, `${dep.id} has no skill pin`);
  const progress = opts.progress ?? (() => undefined);
  const target = skillDirs(pin, opts.project).find((d) => d.scope === opts.scope) as { scope: SkillScope; dir: string };
  let copy: SkillCopy | undefined;
  try {
    copy = await inspectCopy(pin, target.scope, target.dir);
  } catch (error) {
    return failed(opts.dryRun, `${target.dir}: ${(error as Error).message}`);
  }
  const skillsDir = dirname(target.dir);
  const sk = await lstatOrNull(skillsDir);
  if (sk && (sk.isSymbolicLink() || !sk.isDirectory())) return blocked(opts.dryRun, `${skillsDir} is a symbolic link or not a directory; ARIA will not install through it`);

  const messages: string[] = [];
  let mode: "install" | "restore" | "swap";
  if (!copy) mode = "install";
  else if (copy.owner === "user") {
    const why = copy.problems.length ? copy.problems.join("; ") : `an existing ${pin.name}${copy.version ? ` ${copy.version}` : ""} that ARIA did not install`;
    return blocked(opts.dryRun, `${target.dir}: ${why}. ARIA reuses a compatible copy but never overwrites it; move it aside manually if you want ARIA's pinned copy`);
  } else if (copy.modified.length || copy.unknown.length || copy.problems.length) {
    return blocked(opts.dryRun, `${target.dir}: ARIA-owned copy was changed (${[...copy.modified.map((m) => `modified ${m}`), ...copy.unknown.map((u) => `unknown ${u}`), ...copy.problems].join("; ")}). ARIA will not overwrite it; restore the files or move the directory aside`);
  } else if (!isCurrent(pin, copy)) {
    if (opts.intent !== "update") return blocked(opts.dryRun, `${target.dir} is ARIA's ${pin.name} ${copy.version}; the pinned version is ${pin.version}. Run \`aria deps update ${dep.id}\``);
    mode = "swap";
  } else if (copy.missing.length) mode = "restore";
  else return { ok: true, dryRun: opts.dryRun, outcome: "unchanged", changes: [], messages: [`${pin.name} ${pin.version} is installed and intact at ${target.dir}`], errors: [] };

  const engine = engineFor(pin);
  const changes: Change[] = [{
    kind: "install",
    target: target.dir,
    summary: mode === "restore" ? `restore ${copy?.missing.length} missing file(s) of ${pin.name} ${pin.version} in ${target.dir}` : `${mode === "swap" ? `replace ${pin.name} ${copy?.version} with` : "install"} ${pin.name} ${pin.version} (commit ${pin.commit.slice(0, 7)}, SHA-256 verified) in ${target.dir}`,
    detail: [`source: ${pin.archiveUrl}`, ...(engine ? [`helper: ${engine.url}`] : []), `ownership marker: ${markerName(pin)}`],
    network: true,
  }];
  if (opts.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages: ["Downloads two verified artifacts; nothing is written until both match their pinned SHA-256."], errors: [] };

  return withLock(async () => {
    const steps: Step[] = [];
    try {
      const payload = await buildPayload(pin, opts.fetcher ?? fetchHttps, progress);
      steps.push({ name: "download and verify", status: "done", detail: `${payload.files.size} files` });
      messages.push(...payload.notes);
      if (mode === "restore" && copy) {
        // The fresh payload must agree with the recorded hashes, or the copy is not what the marker says.
        const marker = JSON.parse(await readFile(join(target.dir, markerName(pin)), "utf8")) as { files: Record<string, string> };
        for (const rel of copy.missing) {
          const f = payload.files.get(rel);
          if (!f || sha256(f.data) !== marker.files[rel]) throw new Error(`the verified payload does not match the recorded hash for ${rel}; nothing was repaired`);
        }
        for (const rel of copy.missing) {
          const f = payload.files.get(rel) as { data: Buffer; mode: number };
          const dest = join(target.dir, ...rel.split("/"));
          await mkdir(dirname(dest), { recursive: true });
          const tmp = join(dirname(dest), `.aria-tmp-${randomBytes(6).toString("hex")}`);
          await writeFile(tmp, f.data, { flag: "wx", mode: f.mode });
          await chmod(tmp, f.mode);
          try {
            await link(tmp, dest); // refuses to replace an existing entry
          } finally {
            await unlink(tmp).catch(() => undefined);
          }
        }
        steps.push({ name: "restore missing files", status: "done", detail: copy.missing.join(", ") });
        return { ok: true, dryRun: false, outcome: "success" as const, steps, changes, messages: [...messages, `restored ${copy.missing.length} file(s) in ${target.dir}`], errors: [] };
      }
      const staged = await stage(pin, skillsDir, payload);
      try {
        if (mode === "install") {
          if (await lstatOrNull(target.dir)) throw new Error(`${target.dir} appeared while installing; nothing was changed`);
          await rename(staged, target.dir);
        } else {
          const aside = join(skillsDir, `.${pin.name}.aria-old-${randomBytes(4).toString("hex")}`);
          // Re-check ownership immediately before the swap: it must still be exactly what was inspected.
          const again = await inspectCopy(pin, target.scope, target.dir);
          if (!again || again.owner !== "aria" || again.modified.length || again.unknown.length || again.version !== copy?.version) throw new Error(`${target.dir} changed while updating; nothing was replaced`);
          await rename(target.dir, aside);
          try {
            await rename(staged, target.dir);
          } catch (error) {
            await rename(aside, target.dir).catch(() => undefined);
            throw error;
          }
          await rm(aside, { recursive: true, force: true }).catch(() => messages.push(`could not remove the previous copy ${aside}`));
        }
      } catch (error) {
        await rm(staged, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      steps.push({ name: mode === "swap" ? "replace skill tree" : "install skill tree", status: "done", detail: target.dir });
      return { ok: true, dryRun: false, outcome: "success" as const, steps, changes, messages: [...messages, `${pin.name} ${pin.version} installed at ${target.dir}`, "OpenCode picks up skills for new sessions."], errors: [] };
    } catch (error) {
      steps.push({ name: "install", status: "failed", detail: (error as Error).message });
      return { ok: false, dryRun: false, outcome: "failed" as const, steps, changes: [], messages, errors: [(error as Error).message] };
    }
  });
}

/** Remove an ARIA-owned, unmodified copy. Anything else is left alone. */
export async function removeSkill(dep: Dependency, opts: { scope: SkillScope; project: string; dryRun: boolean }): Promise<OperationResult> {
  const gate = interruptedResult(opts.dryRun);
  if (gate) return gate;
  const pin = dep.skill;
  if (!pin) return failed(opts.dryRun, `${dep.id} has no skill pin`);
  const target = skillDirs(pin, opts.project).find((d) => d.scope === opts.scope) as { scope: SkillScope; dir: string };
  const copy = await inspectCopy(pin, target.scope, target.dir).catch(() => undefined);
  if (!copy) return { ok: true, dryRun: opts.dryRun, outcome: "unchanged", changes: [], messages: [`${pin.name} is not installed at ${target.dir}`], errors: [] };
  if (copy.owner !== "aria") return blocked(opts.dryRun, `${target.dir} was not installed by ARIA; ARIA does not remove it`);
  if (copy.modified.length || copy.unknown.length || copy.problems.length) return blocked(opts.dryRun, `${target.dir} contains changes ARIA did not make (${[...copy.modified, ...copy.unknown, ...copy.problems].join("; ")}); ARIA does not delete it`);
  const changes: Change[] = [{ kind: "cleanup", target: target.dir, summary: `remove ARIA's ${pin.name} ${copy.version}` }];
  if (opts.dryRun) return { ok: true, dryRun: true, outcome: "preview", changes, messages: [], errors: [] };
  return withLock(async () => {
    const aside = join(dirname(target.dir), `.${pin.name}.aria-removed-${randomBytes(4).toString("hex")}`);
    try {
      await rename(target.dir, aside);
      await rm(aside, { recursive: true, force: true });
      return { ok: true, dryRun: false, outcome: "success" as const, changes, messages: [`removed ${target.dir}`], errors: [] };
    } catch (error) {
      return { ok: false, dryRun: false, outcome: "failed" as const, changes: [], messages: [], errors: [(error as Error).message] };
    }
  });
}
