import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Release archives, read and written without the system `tar`.
 *
 * Reading validates the WHOLE archive before anything is written: only regular files and
 * directories are accepted; symlinks, hard links, devices, FIFOs and unknown entry types are
 * rejected; every member path must be relative, use `/`, contain no `.`/`..`/empty components,
 * no NUL, no backslash, no drive letter, and stay under the expected `package/` root. Sizes and
 * counts are bounded. Extraction then creates each file exclusively (O_EXCL | O_NOFOLLOW) under a
 * fresh staging directory.
 *
 * Writing produces a deterministic ustar + gzip stream (sorted paths, fixed mtime/uid/gid/mode),
 * so the same package content always has the same sha256.
 */

/** Versions ARIA accepts as directory names: semver with optional prerelease/build, at most 64 chars. */
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
export const validVersion = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && VERSION.test(v);

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

export interface Member {
  readonly path: string; // relative to the package root, posix
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly data?: Buffer;
}

function field(buf: Buffer, offset: number, length: number): string {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(buf: Buffer, offset: number, length: number): number {
  const text = field(buf, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError("corrupt archive header (numeric field)");
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = Number(data.subarray(i, space).toString());
    if (!Number.isFinite(length) || length <= 0) throw new ArchiveError("corrupt pax header");
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/** Validate a member path and strip the package root. Returns undefined for the root itself. */
export function memberPath(raw: string): string | undefined {
  if (raw.includes("\0") || raw.includes("\\")) throw new ArchiveError(`unsafe member name ${JSON.stringify(raw)}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new ArchiveError(`absolute member path ${JSON.stringify(raw)}`);
  let p = raw.replace(/\/+$/, "");
  if (p.startsWith("./")) p = p.slice(2);
  const parts = p.split("/");
  if (parts.some((c) => c === "" || c === "." || c === "..")) throw new ArchiveError(`unsafe member path ${JSON.stringify(raw)}`);
  if (parts[0] !== "package") throw new ArchiveError(`member outside package/: ${JSON.stringify(raw)}`);
  const rest = parts.slice(1).join("/");
  return rest === "" ? undefined : rest;
}

/** Parse and validate every member of a .tgz. Throws ArchiveError on the first problem. */
export function readArchive(file: string): Member[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(file), { maxOutputLength: MAX_TOTAL + 1024 * 1024 });
  } catch (error) {
    throw new ArchiveError(`not a readable gzip archive (${(error as Error).message})`);
  }
  const members: Member[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) throw new ArchiveError("corrupt archive header (checksum)");
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] as number);
    const magic = field(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(header, 345, 155) : "";
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (data.length !== size) throw new ArchiveError("truncated archive");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue; // global pax header: no per-member meaning ARIA uses
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    pax = {};
    longName = undefined;
    if (type !== "0" && type !== "\0" && type !== "5") {
      const kind = { "1": "hard link", "2": "symbolic link", "3": "character device", "4": "block device", "6": "FIFO", "7": "contiguous file" }[type] ?? `entry type ${JSON.stringify(type)}`;
      throw new ArchiveError(`${kind} not allowed: ${JSON.stringify(name)}`);
    }
    const path = memberPath(name);
    if (path === undefined) continue;
    if (seen.has(path)) throw new ArchiveError(`duplicate member ${path}`);
    seen.add(path);
    if (members.length >= MAX_ENTRIES) throw new ArchiveError("too many members");
    if (type === "5") members.push({ path, type: "directory", mode: 0o755 });
    else {
      if (size > MAX_FILE) throw new ArchiveError(`member too large: ${path}`);
      total += size;
      if (total > MAX_TOTAL) throw new ArchiveError("archive too large");
      const mode = octal(header, 100, 8) & 0o111 ? 0o755 : 0o644;
      members.push({ path, type: "file", mode, data: Buffer.from(data) });
    }
  }
  // A file must not be used as a directory by another member.
  const files = new Set(members.filter((m) => m.type === "file").map((m) => m.path));
  for (const m of members) {
    const parts = m.path.split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/"))) throw new ArchiveError(`member ${m.path} nests under a file`);
  }
  return members;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Write validated members under `target` (an empty directory ARIA just created). */
export function extractMembers(members: readonly Member[], target: string): void {
  const root = resolve(target);
  const inside = (p: string) => {
    const rel = relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..");
  };
  for (const m of members) {
    const dest = resolve(root, ...m.path.split("/"));
    if (!inside(dest)) throw new ArchiveError(`member escapes staging: ${m.path}`);
    // Every existing ancestor must be a real directory created by this extraction (no links).
    for (let dir = dirname(dest); dir !== root; dir = dirname(dir)) {
      if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new ArchiveError(`unexpected entry at ${relative(root, dir)}`);
    }
    if (m.type === "directory") {
      mkdirSync(dest, { recursive: true, mode: 0o755 });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, m.mode);
    try {
      writeSync(fd, m.data as Buffer);
    } finally {
      closeSync(fd);
    }
  }
}

// ----------------------------------------------------------------- writing

function header(name: string, size: number, type: "0" | "5", mode: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) => h.write(text, offset, length, "utf8");
  const num = (value: number, offset: number, length: number) => put(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  let n = name;
  let prefix = "";
  if (Buffer.byteLength(n) > 100) {
    const cut = n.lastIndexOf("/", 154);
    if (cut <= 0 || Buffer.byteLength(n.slice(cut + 1)) > 100) throw new ArchiveError(`path too long for ustar: ${name}`);
    prefix = n.slice(0, cut);
    n = n.slice(cut + 1);
  }
  put(n, 0, 100);
  num(mode, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(size, 124, 12);
  num(0, 136, 12);
  h.fill(0x20, 148, 156);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** Deterministic package/ tarball written from the exact bytes an inventory hashed. */
export function writeArchive(inv: { readonly files: readonly { rel: string; exec: boolean; data: Buffer }[]; readonly dirs: readonly string[] }): Buffer {
  const chunks: Buffer[] = [header("package/", 0, "5", 0o755)];
  const entries = [...inv.dirs.map((d) => ({ rel: `${d}/`, dir: true as const })), ...inv.files.map((f) => ({ rel: f.rel, dir: false as const, f }))].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const e of entries) {
    if (e.dir) {
      chunks.push(header(posix.join("package", e.rel) + "/", 0, "5", 0o755));
      continue;
    }
    const data = e.f.data;
    chunks.push(header(posix.join("package", e.rel), data.length, "0", e.f.exec ? 0o755 : 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Walk regular files under `root` (symlinks and special files are errors). Legacy digest only. */
function collect(root: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      if (skip(rel)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new ArchiveError(`symbolic link in package: ${rel}`);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(rel);
      else throw new ArchiveError(`unsupported file type in package: ${rel}`);
    }
  };
  walk(root);
  return out;
}

/**
 * LEGACY (alpha.4 and earlier) content digest: every file in the directory except node_modules and
 * the staging marker, no execute bit. Kept only to check release records written before the shared
 * inventory existed (their `digest` has no `identityAlgorithm`). New records use inventory.ts.
 */
export function legacyContentDigest(root: string): string {
  const files = collect(root, (r) => r === ".aria-staging" || r === "node_modules" || r.startsWith("node_modules/"));
  return digestLines(files.map((rel) => [rel, readFileSync(join(root, ...rel.split("/")))]));
}

function digestLines(files: [string, Buffer][]): string {
  const h = createHash("sha256");
  for (const [rel, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) h.update(`${rel}\0${createHash("sha256").update(data).digest("hex")}\n`);
  return h.digest("hex");
}
