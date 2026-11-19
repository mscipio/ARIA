import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Member } from "./archive.ts";

/**
 * The one definition of what a release contains, shared by `aria pack`, `aria inspect`, source
 * inspection (directory or tarball), staging, the same-version check and the rollback integrity
 * check. Node built-ins only (the bootstrap needs it before any npm package exists).
 *
 * Inventory: `package.json`, `package-lock.json`, and every regular file under the `files`
 * entries of package.json, minus `node_modules`, `.git` and OS clutter at any depth.
 *
 * Identity: sha256 over sorted lines `relative-path NUL x|- NUL sha256(content) LF`, so the same
 * packaged bytes give the same identity whether they come from a checkout, a staging directory,
 * an installed release or a tarball, wherever that is on disk. The execute bit is part of it.
 *
 * Rejected, never followed: symlinks (also a symlinked ancestor of a `files` entry), special
 * files, `files` entries that are absolute, contain `..`, backslashes or glob characters, a
 * missing lockfile, and a lockfile whose name/version/dependencies disagree with package.json.
 * In an archive, any file or directory entry outside the inventory is rejected too.
 */

export class InventoryError extends Error {
  override readonly name = "InventoryError";
}

export interface InventoryFile {
  readonly rel: string;
  readonly exec: boolean;
  readonly data: Buffer;
}

export interface Inventory {
  readonly name: string;
  readonly version: string;
  /** Sorted by path. */
  readonly files: readonly InventoryFile[];
  /** Directories that hold inventory files (and empty directories under `files` entries), sorted. */
  readonly dirs: readonly string[];
  readonly identity: string;
}

/** Identity algorithm tag stored with release records (records without it predate alpha.5). */
export const IDENTITY_ALGORITHM = "inventory-v1";

const CLUTTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "ehthumbs.db"]);
// `.opencode` holds per-machine generated files (e.g. an integration plugin with absolute paths); never distributed.
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".opencode"]);
const MARKER = ".aria-staging";

/** Excluded from every inventory at any depth (never distributed, never hashed). */
export function excluded(rel: string): boolean {
  return rel.split("/").some((p) => EXCLUDED_DIRS.has(p)) || clutter(rel) || rel === MARKER;
}

const clutter = (rel: string) => {
  const base = rel.split("/").at(-1) as string;
  return CLUTTER.has(base) || base.startsWith("._");
};

/** Validated, normalised `files` entries. */
export function filesEntries(pkg: { files?: unknown }): string[] {
  if (pkg.files === undefined) throw new InventoryError("package.json has no `files` list; a release must say what it distributes");
  if (!Array.isArray(pkg.files)) throw new InventoryError("package.json `files` is not a list");
  const out: string[] = [];
  for (const raw of pkg.files) {
    if (typeof raw !== "string") throw new InventoryError(`files entry ${JSON.stringify(raw)} is not a string`);
    let e = raw.replace(/\/+$/, "");
    if (e.startsWith("./")) e = e.slice(2);
    if (!e || e.startsWith("/") || /^[A-Za-z]:/.test(e) || e.includes("\\") || e.includes("\0")) throw new InventoryError(`files entry ${JSON.stringify(raw)} is not a plain relative path`);
    if (/[*?[\]{}!]/.test(e)) throw new InventoryError(`files entry ${JSON.stringify(raw)} uses glob syntax; list paths explicitly`);
    if (e.split("/").some((c) => c === "" || c === "." || c === "..")) throw new InventoryError(`files entry ${JSON.stringify(raw)} has an empty, . or .. component`);
    if (excluded(e)) throw new InventoryError(`files entry ${JSON.stringify(raw)} names an excluded path`);
    out.push(e);
  }
  return [...new Set(out)];
}

/** Is a package-relative path part of the inventory defined by these entries? */
export function included(rel: string, entries: readonly string[]): boolean {
  if (excluded(rel)) return false;
  if (rel === "package.json" || rel === "package-lock.json") return true;
  return entries.some((e) => rel === e || rel.startsWith(`${e}/`));
}

/** Is a directory path an ancestor of an inventory entry (allowed as an archive directory entry)? */
const ancestorOf = (rel: string, entries: readonly string[]) => entries.some((e) => e.startsWith(`${rel}/`));

interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly entries: string[];
}

/**
 * package.json and package-lock.json must describe the same package: lockfile v2+, same name and
 * version (top level and `packages[""]`), same dependency specs. A disagreement means `npm ci`
 * would install something other than what the release says, so it is rejected.
 */
export function checkMetadata(pkgText: string, lockText: string | undefined, where: string): PackageInfo {
  let pkg: { name?: unknown; version?: unknown; files?: unknown; dependencies?: unknown; optionalDependencies?: unknown };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    throw new InventoryError(`${where}: package.json is not valid JSON`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new InventoryError(`${where}: package.json needs a name and a version`);
  if (lockText === undefined) throw new InventoryError(`${where}: package-lock.json missing; a release needs it for a reproducible install`);
  let lock: { name?: unknown; version?: unknown; lockfileVersion?: unknown; packages?: Record<string, { version?: unknown; dependencies?: unknown; optionalDependencies?: unknown }> };
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new InventoryError(`${where}: package-lock.json is not valid JSON`);
  }
  const problems: string[] = [];
  if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2) problems.push(`lockfileVersion ${JSON.stringify(lock.lockfileVersion)} (need 2 or 3)`);
  if (lock.name !== pkg.name) problems.push(`name ${JSON.stringify(lock.name)} vs ${JSON.stringify(pkg.name)}`);
  if (lock.version !== pkg.version) problems.push(`version ${JSON.stringify(lock.version)} vs ${JSON.stringify(pkg.version)}`);
  const root = lock.packages?.[""];
  if (!root) problems.push('no packages[""] entry');
  else {
    if (root.version !== pkg.version) problems.push(`packages[""].version ${JSON.stringify(root.version)} vs ${JSON.stringify(pkg.version)}`);
    for (const key of ["dependencies", "optionalDependencies"] as const) {
      const a = JSON.stringify(sortKeys(pkg[key] ?? {}));
      const b = JSON.stringify(sortKeys(root[key] ?? {}));
      if (a !== b) problems.push(`${key} differ (package.json ${a}, lockfile ${b})`);
    }
  }
  if (problems.length) throw new InventoryError(`${where}: package.json and package-lock.json disagree: ${problems.join("; ")}. Run \`npm install --package-lock-only\` after changing package.json.`);
  return { name: pkg.name, version: pkg.version, entries: filesEntries(pkg) };
}

const sortKeys = (v: unknown) => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v);

export function identityOf(files: readonly { rel: string; exec: boolean; data: Buffer }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(`${f.rel}\0${f.exec ? "x" : "-"}\0${createHash("sha256").update(f.data).digest("hex")}\n`);
  }
  return h.digest("hex");
}

function regularFile(abs: string, rel: string): Buffer {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new InventoryError(`symbolic link in release content: ${rel}`);
  if (!st.isFile()) throw new InventoryError(`${rel} is not a regular file`);
  return readFileSync(abs);
}

/**
 * Inventory of a package directory (checkout, staging directory or installed release). Content
 * outside the inventory is ignored here; `extras()` reports it where it matters.
 */
export function fromDirectory(root: string): Inventory {
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InventoryError(`${root} must be a real directory`);
  const pkgText = regularFile(join(root, "package.json"), "package.json").toString("utf8");
  let lockText: string | undefined;
  try {
    lockText = regularFile(join(root, "package-lock.json"), "package-lock.json").toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const info = checkMetadata(pkgText, lockText, root);
  const files = new Map<string, InventoryFile>();
  const dirs = new Set<string>();
  const addFile = (rel: string, abs: string, mode: number) => files.set(rel, { rel, exec: (mode & 0o111) !== 0, data: regularFile(abs, rel) });
  const walk = (rel: string) => {
    const abs = join(root, ...rel.split("/"));
    for (const name of readdirSync(abs).sort()) {
      const childRel = `${rel}/${name}`;
      if (excluded(childRel)) continue;
      const childAbs = join(abs, name);
      const s = lstatSync(childAbs);
      if (s.isSymbolicLink()) throw new InventoryError(`symbolic link in release content: ${childRel}`);
      if (s.isDirectory()) {
        dirs.add(childRel);
        walk(childRel);
      } else if (s.isFile()) addFile(childRel, childAbs, s.mode);
      else throw new InventoryError(`special file in release content: ${childRel}`);
    }
  };
  for (const entry of ["package.json", "package-lock.json", ...info.entries]) {
    // Every ancestor inside the package must be a real directory: a symlinked `src` would
    // otherwise pull in content from anywhere on disk.
    const parts = entry.split("/");
    let present = true;
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      let s;
      try {
        s = lstatSync(join(root, ...parts.slice(0, i)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        present = false; // npm semantics: a missing `files` entry contributes nothing
        break;
      }
      if (s.isSymbolicLink()) throw new InventoryError(`symbolic link in release content: ${rel}${i < parts.length ? ` (ancestor of files entry ${entry})` : ""}`);
      if (i < parts.length && !s.isDirectory()) throw new InventoryError(`files entry ${entry}: ${rel} is not a directory`);
    }
    if (!present) continue;
    const abs = join(root, ...parts);
    const s = lstatSync(abs);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    if (s.isDirectory()) {
      dirs.add(entry);
      walk(entry);
    } else if (s.isFile()) addFile(entry, abs, s.mode);
    else throw new InventoryError(`special file in release content: ${entry}`);
  }
  const list = [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { name: info.name, version: info.version, files: list, dirs: [...dirs].sort(), identity: identityOf(list) };
}

/** Inventory of validated archive members; any member outside the inventory is an error. */
export function fromMembers(members: readonly Member[], where: string): Inventory {
  const byPath = new Map(members.map((m) => [m.path, m]));
  const pkg = byPath.get("package.json");
  if (pkg?.type !== "file" || !pkg.data) throw new InventoryError(`${where}: archive has no package/package.json`);
  const lock = byPath.get("package-lock.json");
  if (lock && lock.type !== "file") throw new InventoryError(`${where}: package-lock.json is not a file`);
  const info = checkMetadata(pkg.data.toString("utf8"), lock?.data?.toString("utf8"), where);
  const files: InventoryFile[] = [];
  const dirs: string[] = [];
  for (const m of members) {
    if (m.type === "directory") {
      if (!included(m.path, info.entries) && !ancestorOf(m.path, info.entries)) throw new InventoryError(`${where}: directory entry outside the release inventory: ${m.path}`);
      dirs.push(m.path);
    } else {
      if (!included(m.path, info.entries)) throw new InventoryError(`${where}: file entry outside the release inventory: ${m.path}`);
      files.push({ rel: m.path, exec: (m.mode & 0o111) !== 0, data: m.data ?? Buffer.alloc(0) });
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { name: info.name, version: info.version, files, dirs: dirs.sort(), identity: identityOf(files) };
}

/**
 * Anything in an installed or staged release directory that the inventory does not account for
 * (node_modules and the staging marker excluded). A release that gained files is not the release
 * that was verified.
 */
export function extras(root: string, inv: Inventory): string[] {
  const known = new Set(inv.files.map((f) => f.rel));
  const knownDirs = new Set(inv.dirs);
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = rel ? join(root, ...rel.split("/")) : root;
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      // Only the top-level node_modules (installed by `npm ci`) and the staging marker belong
      // there; a nested node_modules is reported, since Node would load modules from it.
      if ((!rel && (name === "node_modules" || name === MARKER)) || clutter(r)) continue;
      const s = lstatSync(join(abs, name));
      if (s.isDirectory() && !s.isSymbolicLink()) {
        if (knownDirs.has(r)) walk(r);
        else out.push(`${r}/`);
      } else if (!known.has(r)) out.push(r);
    }
  };
  walk("");
  return out;
}
