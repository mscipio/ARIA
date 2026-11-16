import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArchive, writeArchive } from "./archive.ts";
import { fromDirectory, fromMembers } from "./inventory.ts";
import { packageRoot } from "./env.ts";
import { ReleaseError, sha256File } from "./release.ts";
import { writeAtomic } from "./state.ts";

/**
 * Build a release tarball (`aria-<version>.tgz`) plus its `.sha256` sidecar from the shared
 * release inventory (inventory.ts). The archive is written from the very bytes that were hashed,
 * then read back and checked to have the same identity. Deterministic (sorted, fixed mtimes).
 * `npm pack` cannot be used: it always drops package-lock.json, which releases need for `npm ci`.
 */
export function pack(outDir: string, root: string = packageRoot): { file: string; sha256: string; version: string; identity: string; files: number } {
  const inv = fromDirectory(root); // also rejects symlinks, special files and lockfile disagreement
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const file = join(out, `aria-${inv.version}.tgz`);
  writeAtomic(file, writeArchive(inv));
  const check = fromMembers(readArchive(file), file);
  if (check.identity !== inv.identity) throw new ReleaseError(`packed archive identity ${check.identity.slice(0, 12)}… differs from the source ${inv.identity.slice(0, 12)}…`);
  const sha256 = sha256File(file);
  writeAtomic(`${file}.sha256`, `${sha256}  aria-${inv.version}.tgz\n`);
  return { file, sha256, version: inv.version, identity: inv.identity, files: inv.files.length };
}
