import { closeSync, constants, fstatSync, lstatSync, lutimesSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";

/**
 * The only filesystem layer ARIA uses for its own state under `.aria/`. Every path is built
 * one validated component at a time from the REAL project root, and every step refuses
 * symlinks. Nothing here follows a link, and every failure is a refusal, never a repair.
 *
 * Residual race (documented, not solved): between the `lstat` of a component and its use,
 * another process running as the same user can swap a directory for a symlink. Node has no
 * portable `openat`/`O_NOFOLLOW` directory walk. Mitigations: files are opened with
 * `O_NOFOLLOW` where the platform has it and re-checked with `fstat`; directories are re-checked
 * with `realpath` immediately before use; deletion first renames the target to a private
 * name and verifies its identity (device + inode) before removing anything. Only processes that
 * already run as the user can win this race, and those can delete the files directly anyway.
 */

export class UnsafePath extends Error {
  override readonly name = "UnsafePath";
}

/** One path component: not empty, not `.`/`..`, no separators, no NUL, no Windows drive or stream syntax. */
const COMPONENT = /^(?!\.{1,2}$)[^/\\:\0]{1,128}$/;

export function validComponent(name: string): boolean {
  return COMPONENT.test(name) && name.trim() === name;
}

/** Realpath of the project directory; throws when it does not exist. */
export function realRoot(directory: string): string {
  return realpathSync.native(directory);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

export type Kind = "missing" | "directory" | "file" | "symlink" | "other";

/** `lstat` classification. Never follows the final component. */
export function kindOf(path: string): Kind {
  try {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) return "symlink";
    if (s.isDirectory()) return "directory";
    if (s.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Resolve `root/<components...>` as a chain of real, non-symlink directories inside `root`.
 * With `create`, missing components are created one at a time (never `recursive: true`).
 * Returns undefined when the chain does not exist and `create` is false. Throws `UnsafePath` when
 * any component is a symlink, not a directory, or resolves outside the root.
 */
export function secureDir(root: string, components: readonly string[], create = false): string | undefined {
  let current = root;
  for (const name of components) {
    if (!validComponent(name)) throw new UnsafePath(`invalid path component: ${JSON.stringify(name)}`);
    const next = join(current, name);
    let kind = kindOf(next);
    if (kind === "missing") {
      if (!create) return undefined;
      try {
        mkdirSync(next, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      kind = kindOf(next);
    }
    if (kind === "symlink") throw new UnsafePath(`${relative(root, next)} is a symbolic link; ARIA does not follow links in its state directories`);
    if (kind !== "directory") throw new UnsafePath(`${relative(root, next)} is not a directory`);
    const real = realpathSync.native(next);
    if (real !== next || !inside(root, real)) throw new UnsafePath(`${relative(root, next)} resolves outside the project (${real})`);
    current = next;
  }
  return current;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Read a regular file that is not a symlink, up to `maxBytes`. */
export function readRegularFile(path: string, maxBytes: number): string {
  if (kindOf(path) !== "file") throw new UnsafePath(`${path} is not a regular file`);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) throw new UnsafePath(`${path} is not a regular file`);
    if (s.size > maxBytes) throw new UnsafePath(`${path} is larger than ${maxBytes} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Create a file exclusively (never overwrites, never follows a link). Returns false if it already exists. */
export function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Mark a real directory as recently active (mtime = now). Refuses links; never follows one. */
export function touchDirectory(path: string): void {
  if (kindOf(path) !== "directory") throw new UnsafePath(`${path} is not a real directory`);
  const now = new Date();
  lutimesSync(path, now, now);
}

/** Directory entries; symlinks and odd entries are reported as such and never followed. */
export function entries(dir: string): { name: string; kind: Kind }[] {
  return readdirSync(dir).map((name) => ({ name, kind: kindOf(join(dir, name)) }));
}

/** Remove a tree without following links: a link is unlinked as a link, its target is untouched. */
function removeTree(dir: string, expectedDev: number, depth = 0): void {
  if (depth > 64) throw new UnsafePath(`refusing to remove ${dir}: nesting deeper than 64`);
  for (const { name, kind } of entries(dir)) {
    const path = join(dir, name);
    if (kind === "directory") {
      const s = lstatSync(path);
      // Never cross onto another filesystem (a mount point inside scratch is not ours to empty).
      if (s.dev !== expectedDev) throw new UnsafePath(`refusing to remove ${path}: different filesystem`);
      if (realpathSync.native(path) !== path) throw new UnsafePath(`refusing to remove ${path}: path changed during removal`);
      removeTree(path, expectedDev, depth + 1);
    } else if (kind !== "missing") {
      unlinkSync(path);
    }
  }
  rmdirSync(dir);
}

/**
 * Remove `parent/name` only if it is still the directory identified by `identity`. The directory is
 * first renamed to a private trash name inside `parent` (atomic on one filesystem), its identity is
 * re-checked, and only then emptied. If anything does not match, nothing is deleted.
 */
export function removeOwnedDirectory(parent: string, name: string, identity: { dev: number; ino: number }): void {
  const source = join(parent, name);
  const trash = join(parent, `.trash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const before = lstatSync(source);
  if (before.isSymbolicLink() || !before.isDirectory() || before.dev !== identity.dev || before.ino !== identity.ino) {
    throw new UnsafePath(`${name} changed since it was inspected; not removed`);
  }
  renameSync(source, trash);
  const after = lstatSync(trash);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== identity.dev || after.ino !== identity.ino) {
    // Something else was swapped in at the last moment. Put it back and refuse.
    try {
      renameSync(trash, source);
    } catch {
      /* leave it under the trash name rather than guess */
    }
    throw new UnsafePath(`${name} changed during removal; not removed`);
  }
  removeTree(trash, identity.dev);
}
