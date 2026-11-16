import { execFile } from "node:child_process";
import { isAbsolute, normalize } from "node:path";

/**
 * `aria_git`: repository state for read-only roles.
 *
 * Why it exists: scout and reviewer have no shell (a command allowlist is not a read-only
 * guarantee: `git diff --output=f` writes, configured external diff/textconv programs execute).
 * Without this they could not see what changed. This tool runs a FIXED set of git subcommands
 * with `execFile` (no shell, no user-controlled flags), neutralises the known executing/writing
 * features, and excludes credential files from patches.
 *
 * It is a convenience with a small attack surface, not a sandbox: `git` still reads repository
 * configuration, and the process runs as the host user.
 */

export type GitOp = "status" | "diff" | "log" | "show";

export interface GitInput {
  readonly op: GitOp;
  readonly revision?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly staged?: boolean | undefined;
  readonly stat?: boolean | undefined;
  readonly max?: number | undefined;
}

export const GIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["status", "diff", "log", "show"], description: "Which read-only view to produce." },
    revision: { type: "string", description: "diff/log/show: a revision or range such as HEAD~3, main..HEAD, or a commit id." },
    paths: { type: "array", items: { type: "string" }, description: "Limit to these project-relative paths." },
    staged: { type: "boolean", description: "diff: compare the index with HEAD instead of the working tree." },
    stat: { type: "boolean", description: "diff: summary of changed files only." },
    max: { type: "integer", description: "log: number of commits (default 20, at most 50)." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

// No ":" – `rev:path` would read a blob and bypass the credential-file exclusion below.
const REVISION = /^[A-Za-z0-9._/@{}^~-]{1,200}$/;
const MAX_OUTPUT = 60_000;

/** Pathspecs that keep credential files out of patch output. */
const EXCLUDES = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.p12", "**/*.pfx", "**/*id_rsa*", "**/*id_ed25519*", "**/*id_ecdsa*",
  "**/.netrc", "**/.git-credentials", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**",
].map((p) => `:(exclude,glob)${p}`);

export function buildArgs(input: GitInput): string[] {
  const rev = input.revision;
  if (rev !== undefined && (!REVISION.test(rev) || rev.startsWith("-"))) throw new Error(`Rejected revision: ${rev}`);
  const paths = (input.paths ?? []).map((p) => {
    const n = normalize(p);
    if (isAbsolute(n) || n.startsWith("..") || n.startsWith("-") || n.includes("\0")) throw new Error(`Rejected path: ${p}`);
    return n.replaceAll("\\", "/");
  });
  const safe = [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", "core.quotepath=false",
    "-c", "log.showSignature=false",
    "-c", "diff.submodule=short",
    "-c", "status.submoduleSummary=false",
  ];
  const patchOptions = ["--no-ext-diff", "--no-textconv", "--no-color"];
  const limit = ["--", ...paths, ...EXCLUDES];
  switch (input.op) {
    case "status":
      return [...safe, "status", "--porcelain=v1", "--branch", "--untracked-files=normal", "--ignore-submodules=all"];
    case "diff":
      return [
        ...safe, "diff", ...patchOptions, "--ignore-submodules=all",
        ...(input.stat ? ["--stat"] : []),
        ...(input.staged ? ["--cached"] : []),
        ...(rev ? [rev] : []),
        ...limit,
      ];
    case "log": {
      const n = Math.min(Math.max(Math.trunc(input.max ?? 20), 1), 50);
      return [...safe, "log", ...patchOptions, `-n${n}`, "--date=short", "--format=%h %ad %an  %s", ...(rev ? [rev] : []), ...limit];
    }
    case "show":
      if (!rev) throw new Error("show requires a revision");
      return [...safe, "show", ...patchOptions, "--stat", "--patch", "--format=%H%n%an %ad%n%n%B", rev, ...limit];
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

/** Run git with a fixed argument list (no shell) and a bounded runtime. */
function git(directory: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: directory, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: gitEnv() },
      (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? ((error as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

/**
 * Repository configuration can attach programs to read operations through attribute filters
 * (`filter.<driver>.clean/.process`): `git status` and `git diff` run them on working-tree files.
 * Reading the configuration executes nothing, so every configured driver is listed first and then
 * overridden with an empty command for this invocation, which disables it.
 */
async function neutralizeFilters(directory: string): Promise<string[]> {
  const listed = await git(directory, ["--no-pager", "config", "--get-regexp", "^filter\\."]);
  const drivers = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    const m = /^filter\.(.+)\.(clean|smudge|process|required)\s/.exec(line);
    if (m?.[1] && !/[\s=]/.test(m[1])) drivers.add(m[1]);
  }
  return [...drivers].flatMap((d) => ["-c", `filter.${d}.clean=`, "-c", `filter.${d}.smudge=`, "-c", `filter.${d}.process=`, "-c", `filter.${d}.required=false`]);
}

export async function runGit(directory: string, input: GitInput): Promise<string> {
  const args = buildArgs(input);
  const overrides = await neutralizeFilters(directory);
  const { stdout, stderr, code } = await git(directory, [...overrides, ...args]);
  if (code !== 0) throw new Error(`git ${input.op} failed: ${stderr.trim() || `exit ${code}`}`);
  const text = stdout.length > MAX_OUTPUT ? `${stdout.slice(0, MAX_OUTPUT)}\n… output truncated at ${MAX_OUTPUT} characters; narrow with paths or a revision.` : stdout;
  return text.trim() === "" ? "(no output: nothing to report)" : text;
}
