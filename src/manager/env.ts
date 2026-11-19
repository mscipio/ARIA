import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Environment facts for the manager. Every path the manager touches is derived here, and every
 * one can be redirected with an environment variable, so a disposable environment never reaches
 * the user's real configuration:
 *
 *   ARIA_HOME        ARIA's own data: releases, managed tools, state  (default: XDG data dir / %LOCALAPPDATA%)
 *   XDG_CONFIG_HOME  OpenCode's global config directory parent         (OpenCode's own rule)
 *   OPENCODE_BIN     the opencode executable to use                    (default: found on PATH)
 */

export const isWindows = process.platform === "win32";

/** The ARIA package this code is running from (a development checkout or an installed release). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function ariaHome(): string {
  if (process.env.ARIA_HOME) return resolve(process.env.ARIA_HOME);
  if (isWindows) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "aria");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "aria");
}

export const releasesDir = () => join(ariaHome(), "releases");
export const toolsDir = () => join(ariaHome(), "tools");
export const statePath = () => join(ariaHome(), "state.json");
export const journalDir = () => join(ariaHome(), "journal");

/** OpenCode v2.3.0 global config directory (util/global: XDG config home / opencode). */
export function globalConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

/** Find an executable on PATH (and PATHEXT on Windows) without running a shell. */
export function which(name: string, extraDirs: readonly string[] = []): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

export interface RunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Streamed output lines, for progress display. */
  readonly onLine?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly input?: string;
}

/** Run a program with an argument array (never through a shell), with a timeout. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult) => {
      if (!settled) {
        settled = true;
        done(r);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, error: (error as Error).message, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs ?? 30_000);
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    const lines = (chunk: string) => {
      if (!options.onLine) return;
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) options.onLine(line);
    };
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      lines(d);
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      lines(d);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, ...(timedOut ? { error: "timed out" } : {}) });
    });
  });
}

/** First x.y.z in a string. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** `>=x.y.z <a.b.c` style range check, enough for the manifest. */
export function satisfies(version: readonly number[], range: string): boolean {
  return range.split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(part);
    if (!m) return false;
    const cmp = compareVersions(version, [Number(m[2]), Number(m[3]), Number(m[4])]);
    switch (m[1]) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">": return cmp > 0;
      case "<": return cmp < 0;
      default: return cmp === 0;
    }
  });
}

/** Candidate bin directories of existing Python environments (conda/mamba/uv/pipx), for discovery only. */
export function pythonEnvBinDirs(): string[] {
  const home = homedir();
  const out: string[] = [];
  const bin = isWindows ? "Scripts" : "bin";
  if (process.env.CONDA_PREFIX) out.push(join(process.env.CONDA_PREFIX, bin));
  for (const base of ["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", ".conda"]) {
    const envs = join(home, base, "envs");
    if (!existsSync(envs)) continue;
    try {
      for (const name of readdirSync(envs)) out.push(join(envs, name, bin));
    } catch {
      /* unreadable */
    }
    out.push(join(home, base, bin));
  }
  out.push(join(home, ".local", "bin"));
  return out;
}
