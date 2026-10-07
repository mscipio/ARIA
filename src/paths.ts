import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import properLockfile from "proper-lockfile";

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;

/**
 * Canonical OpenCode global directory: `$XDG_CONFIG_HOME/opencode` when
 * XDG_CONFIG_HOME is set, else `~/.config/opencode`. An explicit non-empty
 * directory wins over both; empty/whitespace values count as unset.
 */
export function openCodeGlobalDir(explicit?: string): string {
  const override = explicit?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
}

function isOutside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`);
}

export function assertContained(root: string, candidate: string, label: string): void {
  if (isOutside(root, candidate)) throw new Error(`${label} escapes the project worktree`);
}

export async function canonicalWorktree(worktree: string): Promise<string> {
  return realpath(worktree);
}

export async function ensureSafeDirectory(root: string, target: string, create: boolean): Promise<string> {
  assertContained(root, target, "Directory path");
  const child = relative(root, target);
  let current = root;

  for (const segment of child.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Path is not a safe directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const created = await lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`Path is not a safe directory: ${current}`);
        }
      }
    }

    const canonical = await realpath(current);
    assertContained(root, canonical, "Directory path");
  }

  return realpath(target);
}

export async function safeProjectFile(
  worktree: string,
  file: string,
  options: { createParent?: boolean; allowMissing?: boolean } = {},
): Promise<{ root: string; path: string }> {
  const root = await canonicalWorktree(worktree);
  const candidate = isAbsolute(file) ? resolve(file) : resolve(root, file);
  assertContained(root, candidate, "File path");
  const parent = await ensureSafeDirectory(root, dirname(candidate), options.createParent ?? false);
  const filePath = resolve(parent, basename(candidate));
  assertContained(root, filePath, "File path");

  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Path is not a safe regular file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.allowMissing === false) throw error;
  }

  return { root, path: filePath };
}

export async function verifySafeParent(root: string, filePath: string): Promise<void> {
  const parent = await realpath(dirname(filePath));
  assertContained(root, parent, "File parent");
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Path is not a safe directory: ${parent}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withFileLock<T>(
  target: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const started = Date.now();
  let release: (() => Promise<void>) | undefined;

  while (!release) {
    if (signal?.aborted) throw abortError(signal);
    try {
      release = await properLockfile.lock(target, {
        realpath: false,
        stale: STALE_LOCK_MS,
        update: 1_000,
        retries: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${target}`);
      await delay(25, signal);
    }
  }

  try {
    if (signal?.aborted) throw abortError(signal);
    return await operation();
  } finally {
    await release().catch(() => undefined);
  }
}
