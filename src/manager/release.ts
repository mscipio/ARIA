import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { removeOwnedDirectory } from "../safe-fs.ts";
import { closeSync, constants as fsc, openSync, readdirSync, writeSync } from "node:fs";
import { extractMembers, legacyContentDigest, readArchive, validVersion, type Member } from "./archive.ts";
import { IDENTITY_ALGORITHM, extras, fromDirectory, fromMembers, type Inventory } from "./inventory.ts";
import { ariaHome, isWindows, releasesDir, run, toolsDir, which } from "./env.ts";
import { readState, writeAtomic, writeState } from "./state.ts";
import type { Progress } from "./types.ts";

/**
 * Release staging, verification and launchers. Deliberately free of third-party imports so that
 * the first-install bootstrap can run from an unpacked package before ARIA's own npm packages
 * exist (see bootstrap.ts).
 *
 * Rules:
 * - every release path is `releases/<version>` for a validated version, and must be a real
 *   (non-symlink) directory whose real path is inside the real releases directory;
 * - every staging directory is created exclusively, carries a `.aria-staging` marker with a random
 *   nonce, and is recorded in state.json BEFORE anything is written into it; repair removes a
 *   staging directory only when marker and record agree;
 * - tarballs need a sha256 (sidecar `<file>.sha256` or explicit) and are validated member by
 *   member before extraction; a version that is already installed with different content is
 *   rejected (same-version conflict);
 * - release content and identity come from ONE inventory definition (inventory.ts), whatever the
 *   source: checkout, tarball, staging directory or installed release;
 * - CLI packages are always installed with `npm ci --omit=dev --ignore-scripts` from the package's
 *   lockfile into an empty node_modules, then checked package by package against that lockfile.
 *
 * Trust boundary: a sha256 (sidecar or --sha256) proves the archive is the one whose checksum you
 * hold. It does NOT prove who published it: a `.sha256` file fetched next to an untrusted archive
 * can be replaced together with it. Releases are local files you built (`aria pack`) or received
 * through a channel you trust; ARIA has no signing infrastructure.
 */

export const REQUIRED_FILES = [
  "package.json", "package-lock.json", "src/index.ts", "src/tui.tsx", "bin/aria.mjs",
  ...["aria", "scout", "reviewer", "planner", "scientist", "writer", "researcher", "visualizer"].map((r) => `prompts/${r}.md`),
];

export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
}

const MARKER = ".aria-staging";

function realDir(path: string): string {
  mkdirSync(path, { recursive: true });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ReleaseError(`${path} must be a real directory`);
  return realpathSync.native(path);
}

const within = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..") && !rel.includes(":");
};

/** `releases/<version>` for a validated version, confined to the real releases directory. */
export function releasePath(version: string): string {
  if (!validVersion(version)) throw new ReleaseError(`invalid release version ${JSON.stringify(version)}`);
  const base = realDir(releasesDir());
  const path = join(base, version);
  if (!within(base, path) || basename(path) !== version) throw new ReleaseError(`release path escapes ${base}`);
  return path;
}

/** Is `path` an installed ARIA release directory (real dir, not a link, directly under releases/)? */
export function ownedReleaseDir(path: string): string | undefined {
  try {
    const base = realDir(releasesDir());
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    const real = realpathSync.native(path);
    if (dirname(real) !== base || !validVersion(basename(real))) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- staging

export interface Staging {
  readonly path: string;
  readonly nonce: string;
}

/**
 * Create an exclusive, marked, recorded staging directory under releases/ or tools/. With
 * `inPlace`, the directory gets its final name (`<label>-<nonce>`), for installs that cannot be
 * moved afterwards (Python venvs); it stays recorded as staging until the install succeeds.
 */
export function createStaging(kind: "releases" | "tools", label: string, inPlace = false): Staging {
  const base = realDir(kind === "releases" ? releasesDir() : toolsDir());
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const nonce = randomBytes(12).toString("hex");
  const path = join(base, inPlace ? `${safe}-${nonce}` : `.staging-${safe}-${nonce}`);
  mkdirSync(path, { mode: 0o700 }); // fails if it exists: never reuse
  const { state } = readState();
  state.stagings = [...(state.stagings ?? []), { path, nonce, createdAt: new Date().toISOString() }];
  writeState(state);
  writeAtomic(join(path, MARKER), JSON.stringify({ nonce, pid: process.pid }) + "\n");
  return { path, nonce };
}

/** Forget a staging record (after it became a release or was removed). */
export function forgetStaging(path: string): void {
  const { state } = readState();
  state.stagings = (state.stagings ?? []).filter((s) => s.path !== path);
  writeState(state);
}

/** Can ARIA prove it owns this staging directory? Marker nonce must match the state record. */
export function stagingOwned(path: string): { owned: boolean; reason: string } {
  const record = (readState().state.stagings ?? []).find((s) => s.path === path);
  if (!record) return { owned: false, reason: "not recorded in state.json" };
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return { owned: false, reason: "not a real directory" };
    const base = realpathSync.native(dirname(path));
    if (![realpathSync.native(releasesDir()), existsSync(toolsDir()) ? realpathSync.native(toolsDir()) : ""].includes(base)) return { owned: false, reason: "outside ARIA_HOME" };
    const markerPath = join(path, MARKER);
    const m = lstatSync(markerPath);
    if (m.isSymbolicLink() || !m.isFile()) return { owned: false, reason: "marker is not a regular file" };
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { nonce?: string };
    return marker.nonce === record.nonce ? { owned: true, reason: "marker matches record" } : { owned: false, reason: "marker does not match record" };
  } catch (error) {
    return { owned: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "marker missing" : (error as Error).message };
  }
}

/** Remove a staging directory only when ownership is established; never follows links. */
export function removeStaging(path: string): void {
  const check = stagingOwned(path);
  if (!check.owned) {
    if (!existsSync(path)) forgetStaging(path);
    throw new ReleaseError(`not removing ${path}: ${check.reason}`);
  }
  const st = lstatSync(path);
  removeOwnedDirectory(dirname(path), basename(path), { dev: st.dev, ino: st.ino });
  forgetStaging(path);
}

// ----------------------------------------------------------------- sources

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export interface Source {
  readonly kind: "tarball" | "directory";
  readonly path: string;
  readonly version: string;
  readonly sha256?: string;
  readonly integrity: string;
  /** Release identity (inventory.ts), the same for a directory and its packed tarball. */
  readonly digest: string;
  /** Number of files in the inventory. */
  readonly files: number;
  /** For a directory source: the exact bytes hashed, which staging writes. */
  readonly inventory?: Inventory;
  /** For a tarball: the validated members. */
  readonly members?: readonly Member[];
}

function ariaVersion(inv: Inventory, where: string): string {
  if (inv.name !== "aria") throw new ReleaseError(`${where} is not an ARIA package (name ${JSON.stringify(inv.name)})`);
  if (!validVersion(inv.version)) throw new ReleaseError(`${where}: invalid version ${JSON.stringify(inv.version)}`);
  return inv.version;
}

const wrap = <T>(fn: () => T, where: string): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    const msg = (error as Error).message;
    throw new ReleaseError(msg.startsWith(where) ? msg : `${where}: ${msg}`);
  }
};

/**
 * Inspect a release source without installing it. A tarball must match a sha256 (explicit or
 * `<file>.sha256`); its members are validated completely here and must all belong to the
 * inventory. A directory is a local source you already have; its inventory is read (and kept, so
 * staging writes exactly the bytes that were hashed).
 */
export function inspect(from: string, expectedSha?: string): Source {
  const path = resolve(from);
  if (!existsSync(path)) throw new ReleaseError(`${path} does not exist`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new ReleaseError(`${path} is a symbolic link; give the real path`);
  if (st.isDirectory()) {
    const inv = wrap(() => fromDirectory(path), path);
    const version = ariaVersion(inv, path);
    return { kind: "directory", path, version, integrity: "local directory (identity computed from its release inventory)", digest: inv.identity, files: inv.files.length, inventory: inv };
  }
  if (!st.isFile()) throw new ReleaseError(`${path} is not a regular file`);
  const digest = sha256File(path);
  const sidecar = existsSync(`${path}.sha256`) ? readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0] : undefined;
  const want = (expectedSha ?? sidecar)?.toLowerCase();
  if (!want) throw new ReleaseError(`${path}: no sha256 given (use --sha256 or ${basename(path)}.sha256); refusing an unverified archive`);
  if (!/^[0-9a-f]{64}$/.test(want)) throw new ReleaseError("sha256 must be 64 hex characters");
  if (want !== digest) throw new ReleaseError(`${path}: sha256 mismatch (expected ${want.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
  const members = wrap(() => readArchive(path), path);
  const inv = wrap(() => fromMembers(members, path), path);
  const version = ariaVersion(inv, path);
  return {
    kind: "tarball", path, version, sha256: digest, files: inv.files.length, members,
    integrity: expectedSha ? "sha256 matches the value you gave" : "sha256 matches the sidecar file (integrity only: the sidecar does not authenticate the publisher)",
    digest: inv.identity,
  };
}

/** Release identity of a package directory (the shared inventory; node_modules excluded). */
export const packageDigest = (dir: string) => wrap(() => fromDirectory(dir).identity, dir);

/**
 * Integrity of an installed release against its record: identity unchanged and nothing added
 * outside the inventory. Records from before the shared inventory are checked with the legacy
 * digest they were written with.
 */
/** Installed dependencies vs the release's lockfile; undefined when they match. */
export function dependencyProblems(dir: string): string | undefined {
  if (!existsSync(join(dir, "node_modules"))) return "node_modules is missing";
  try {
    const p = verifyDependencies(dir);
    return p.length ? `${p.slice(0, 4).join("; ")}${p.length > 4 ? "; …" : ""}` : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export function verifyInstalled(dir: string, record: { digest?: string; identityAlgorithm?: string }): { ok: boolean; detail: string } {
  if (!record.digest) return { ok: false, detail: "no content identity recorded for this release" };
  const deps = dependencyProblems(dir);
  if (deps) return { ok: false, detail: `dependencies do not match the lockfile: ${deps}` };
  if (record.identityAlgorithm !== IDENTITY_ALGORITHM) {
    const legacy = legacyContentDigest(dir);
    return legacy === record.digest ? { ok: true, detail: "legacy digest matches" } : { ok: false, detail: "content differs from the legacy digest recorded at install time" };
  }
  try {
    const inv = fromDirectory(dir);
    const extra = extras(dir, inv);
    if (inv.identity !== record.digest) return { ok: false, detail: `identity ${inv.identity.slice(0, 12)}… differs from the recorded ${record.digest.slice(0, 12)}…` };
    if (extra.length) return { ok: false, detail: `unexpected content outside the release inventory: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""}` };
    return { ok: true, detail: "identity matches and nothing was added" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export interface Staged {
  readonly staging: Staging;
  readonly version: string;
  readonly digest: string;
}

/**
 * If releases/<version> already exists: identical content → reuse it (no staging, no network);
 * different content → same-version conflict. Returns undefined when the version is not installed.
 */
export function existingRelease(source: Source): string | undefined {
  const final = releasePath(source.version);
  if (!existsSync(final)) return undefined;
  if (!ownedReleaseDir(final)) throw new ReleaseError(`${final} exists but is not a real release directory; not touching it`);
  let existing: string;
  try {
    const inv = fromDirectory(final);
    const extra = extras(final, inv);
    if (extra.length) throw new ReleaseError(`installed release ${source.version} has content outside its inventory (${extra.slice(0, 3).join(", ")}); not reusing it`);
    existing = inv.identity;
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError(`installed release ${source.version} cannot be verified (${(error as Error).message}); not reusing it. Bump the version instead.`);
  }
  if (existing !== source.digest) throw new ReleaseError(`conflicting package: version ${source.version} is already installed with different content (identity ${existing.slice(0, 12)}… vs ${source.digest.slice(0, 12)}…). Bump the version instead of reusing it.`);
  const deps = dependencyProblems(final);
  if (deps) throw new ReleaseError(`installed release ${source.version} has the right content but its dependencies do not match its lockfile (${deps}); not reusing it. Remove ${final} after checking it, then install again.`);
  return final;
}

const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;

/** Write inventory files (the bytes that were hashed) into an empty staging directory. */
function writeInventory(inv: Inventory, target: string): void {
  for (const d of inv.dirs) mkdirSync(join(target, ...d.split("/")), { recursive: true, mode: 0o755 });
  for (const f of inv.files) {
    const dest = join(target, ...f.rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    const fd = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW, f.exec ? 0o755 : 0o644);
    try {
      writeSync(fd, f.data);
    } finally {
      closeSync(fd);
    }
    chmodSync(dest, f.exec ? 0o755 : 0o644); // umask must not change the execute bit
  }
}

/** Copy or extract the source into a fresh staging directory and verify it against the source identity. */
export function stage(source: Source, progress: Progress): Staged {
  const staging = createStaging("releases", source.version);
  try {
    if (source.kind === "tarball") {
      progress(`extracting ${basename(source.path)} (validated members only)`);
      extractMembers(source.members ?? readArchive(source.path), staging.path);
    } else {
      progress(`copying the ${source.files} inventory files of ${source.path}`);
      writeInventory(source.inventory ?? fromDirectory(source.path), staging.path);
    }
    const inv = wrap(() => fromDirectory(staging.path), "staged release");
    const extra = extras(staging.path, inv);
    if (extra.length) throw new ReleaseError(`staged release has content outside its inventory: ${extra.join(", ")}`);
    const missing = REQUIRED_FILES.filter((f) => !existsSync(join(staging.path, f)));
    if (missing.length) throw new ReleaseError(`release is incomplete, missing: ${missing.join(", ")}`);
    const version = ariaVersion(inv, "staged package");
    if (version !== source.version) throw new ReleaseError(`staged version ${version} differs from source version ${source.version}`);
    if (inv.identity !== source.digest) throw new ReleaseError(`staged content identity ${inv.identity.slice(0, 12)}… differs from the source ${source.digest.slice(0, 12)}…`);
    return { staging, version, digest: inv.identity };
  } catch (error) {
    try {
      removeStaging(staging.path);
    } catch {
      /* reported by repair */
    }
    throw error;
  }
}

interface LockEntry {
  readonly version?: string;
  readonly name?: string;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly link?: boolean;
}

/** Package directories (`node_modules/x`, `node_modules/@s/x`, nested) actually installed under `dir`. */
function installedPackages(dir: string): string[] {
  const out: string[] = [];
  const scan = (rel: string) => {
    const abs = join(dir, ...rel.split("/"));
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue; // .bin, .package-lock.json
      if (name.startsWith("@")) {
        for (const sub of readdirSync(join(abs, name)).sort()) visit(`${rel}/${name}/${sub}`);
      } else visit(`${rel}/${name}`);
    }
  };
  const visit = (rel: string) => {
    const st = lstatSync(join(dir, ...rel.split("/")));
    if (st.isSymbolicLink()) throw new ReleaseError(`installed dependency ${rel} is a symbolic link`);
    if (!st.isDirectory()) return;
    out.push(rel);
    scan(`${rel}/node_modules`);
  };
  scan("node_modules");
  return out;
}

/**
 * Compare the installed tree with the lockfile: every non-dev locked package present at its locked
 * version (optional ones may be absent), and nothing installed that the lockfile does not list.
 */
export function verifyDependencies(dir: string): string[] {
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages?: Record<string, LockEntry> };
  const problems: string[] = [];
  const wanted = new Map(Object.entries(lock.packages ?? {}).filter(([k, v]) => k.startsWith("node_modules/") && !v.dev && !v.link));
  const present = new Set(installedPackages(dir));
  for (const [key, entry] of wanted) {
    if (!present.has(key)) {
      if (!entry.optional && !entry.devOptional) problems.push(`${key} missing`);
      continue;
    }
    let pkg: { name?: string; version?: string };
    try {
      pkg = JSON.parse(readFileSync(join(dir, ...key.split("/"), "package.json"), "utf8"));
    } catch {
      problems.push(`${key}: no readable package.json`);
      continue;
    }
    const expectName = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (pkg.name !== expectName) problems.push(`${key}: name ${pkg.name} (lockfile ${expectName})`);
    if (pkg.version !== entry.version) problems.push(`${key}: version ${pkg.version} (lockfile ${entry.version})`);
  }
  for (const key of present) if (!wanted.has(key)) problems.push(`${key} installed but not in the lockfile`);
  return problems;
}

/**
 * Install CLI packages reproducibly: always `npm ci --omit=dev --ignore-scripts` into a release
 * without node_modules (a release never ships them), then check the result against the lockfile.
 */
export async function installPackages(dir: string, progress: Progress, signal?: AbortSignal): Promise<void> {
  if (existsSync(join(dir, "node_modules"))) throw new ReleaseError("the release already contains node_modules; releases never ship dependencies, they are installed from the lockfile");
  if (!existsSync(join(dir, "package-lock.json"))) throw new ReleaseError("package-lock.json missing: refusing a non-reproducible dependency install");
  const npm = which(isWindows ? "npm.cmd" : "npm");
  if (!npm) throw new ReleaseError("npm not found; it is needed once to install ARIA's CLI packages");
  progress("npm ci --omit=dev --ignore-scripts (network)");
  const r = await run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 600_000, onLine: progress, ...(signal ? { signal } : {}) });
  if (!r.ok) throw new ReleaseError(`npm ci failed: ${(r.error ?? r.stderr.trim()).slice(-400)}`);
  const problems = verifyDependencies(dir);
  if (problems.length) throw new ReleaseError(`installed dependencies do not match package-lock.json: ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? "; …" : ""}`);
  progress(`dependencies match package-lock.json`);
}

/** Run the staged CLI once; it must report the expected version. */
export async function smokeTest(dir: string, version: string): Promise<void> {
  const r = await run(process.execPath, [join(dir, "bin", "aria.mjs"), "version"], { timeoutMs: 30_000, env: { ...process.env, ARIA_NO_UI: "1" } });
  if (!r.ok || r.stdout.trim() !== version) throw new ReleaseError(`staged release does not run: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}

/**
 * Turn a verified staging directory into releases/<version>. An existing release of the same
 * version is reused only if its content digest is identical; otherwise this is a conflict.
 */
export function finalize(staged: Staged, progress: Progress): string {
  const final = releasePath(staged.version);
  if (existsSync(final)) {
    if (!ownedReleaseDir(final)) throw new ReleaseError(`${final} exists but is not a real release directory; not touching it`);
    removeStaging(staged.staging.path);
    existingRelease({ kind: "directory", path: final, version: staged.version, integrity: "", digest: staged.digest, files: 0 }); // throws on a conflict
    progress(`release ${staged.version} already installed with identical content; reusing it`);
    return final;
  }
  // The marker stays out of the release: rename, then drop the marker file.
  renameSync(staged.staging.path, final);
  forgetStaging(staged.staging.path);
  try {
    removeMarker(final);
  } catch {
    /* harmless */
  }
  return final;
}

export function removeMarker(dir: string) {
  const p = join(dir, MARKER);
  if (existsSync(p) && lstatSync(p).isFile()) unlinkSync(p);
}

// ----------------------------------------------------------------- launcher

/**
 * `ARIA_HOME/current` names the active package; `ARIA_HOME/bin/aria` (and `aria.cmd`) run it.
 * Activation rewrites `current` atomically, so the launcher always follows the active release.
 */
export function writeCurrent(packageDir: string): void {
  writeAtomic(join(ariaHome(), "current"), `${packageDir}\n`);
}

export function readCurrent(): string | undefined {
  try {
    return readFileSync(join(ariaHome(), "current"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeLaunchers(): string[] {
  const bin = join(ariaHome(), "bin");
  mkdirSync(bin, { recursive: true });
  const sh = join(bin, "aria");
  writeAtomic(
    sh,
    `#!/bin/sh
# ARIA launcher: runs the active ARIA package named in ../current (written by aria setup/update/rollback).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARIA_HOME="\${ARIA_HOME:-$(dirname -- "$here")}"
export ARIA_HOME
current=$(cat "$ARIA_HOME/current" 2>/dev/null)
if [ -z "$current" ] || [ ! -f "$current/bin/aria.mjs" ]; then
  echo "aria: no active ARIA installation (missing $ARIA_HOME/current). Run the bootstrap again." >&2
  exit 2
fi
exec node "$current/bin/aria.mjs" "$@"
`,
  );
  chmodSync(sh, 0o755);
  const cmd = join(bin, "aria.cmd");
  writeAtomic(
    cmd,
    `@echo off\r\nrem ARIA launcher: runs the active ARIA package named in ..\\current.\r\nif "%ARIA_HOME%"=="" set "ARIA_HOME=%~dp0.."\r\nset /p ARIA_CURRENT=<"%ARIA_HOME%\\current"\r\nif not exist "%ARIA_CURRENT%\\bin\\aria.mjs" (echo aria: no active ARIA installation 1>&2 & exit /b 2)\r\nnode "%ARIA_CURRENT%\\bin\\aria.mjs" %*\r\n`,
  );
  return [sh, cmd];
}
