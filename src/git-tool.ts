import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path, { relative, resolve, sep } from "node:path";

export const GIT_READ_TOOL_NAME = "git_read";

const OPERATIONS = ["status", "diff", "log", "show"] as const;
type GitReadOperation = (typeof OPERATIONS)[number];

export const gitReadToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    operation: { type: "string", enum: [...OPERATIONS] },
    path: { type: "string", description: "Literal project-relative file path (required for diff, log, and show)" },
    revision: { type: "string", description: "Commit or simple revision expression (show only)" },
  },
  required: ["operation"],
  additionalProperties: false,
};

type GitReadResult = { content: string; metadata: { title: string } };

function error(message: string): GitReadResult {
  return { content: message, metadata: { title: "Error" } };
}

function isProtectedPath(file: string): boolean {
  return /(?:^|\/)[^/]*\.env(?:\..*)?$/.test(file)
    && !/(?:^|\/)[^/]*\.env\.example$/.test(file);
}

function literalPath(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) return undefined;
  const value = input.replaceAll("\\", "/");
  if (value.startsWith("/") || value.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return undefined;
  return value;
}

export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Remove environment overrides that redirect Git's repository, index,
  // object store, executable/config injection, SSH/proxy command overrides,
  // pager, or external diff. Keep HOME/XDG, Git config, and SSH-agent access.
  const blocked = new Set([
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM", "GIT_NAMESPACE", "GIT_SUPER_PREFIX", "GIT_SHALLOW_FILE",
    "GIT_OBJECT_DIRECTORY_RELATIVE", "GIT_REPLACE_REF_BASE", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_ASKPASS",
    "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_PAGER", "GIT_TRACE", "GIT_TRACE_SETUP",
    "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE", "GIT_TRACE2", "GIT_TRACE2_EVENT",
    "GIT_TRACE2_PERF", "PAGER",
  ]);
  for (const key of Object.keys(env)) {
    if (blocked.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

function runGit(projectDirectory: string, args: string[]): string {
  return execFileSync("git", [
    "-C", projectDirectory,
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "color.ui=false",
    "--no-pager",
    ...args,
  ], {
    encoding: "utf8",
    env: sanitizedGitEnv(),
    timeout: 10_000,
    maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolve invocation subdirectories to a verified normal or linked worktree root. */
export function resolveGitProjectDirectory(projectDirectory: string): { root: string; gitDir: string; commonDir: string } {
  const invocation = realpathSync(projectDirectory);
  const run = (args: string[]) => runGit(invocation, args).trim();
  const root = realpathSync(run(["rev-parse", "--show-toplevel"]));
  const gitDir = realpathSync(run(["rev-parse", "--absolute-git-dir"]));
  const rawCommon = run(["rev-parse", "--git-common-dir"]);
  const commonDir = realpathSync(path.isAbsolute(rawCommon) ? rawCommon : resolve(invocation, rawCommon));
  const marker = path.join(root, ".git");
  const markerInfo = lstatSync(marker);
  if (markerInfo.isDirectory()) {
    if (realpathSync(marker) !== gitDir || gitDir !== commonDir) {
      throw new Error("Git metadata does not match the normal worktree marker");
    }
  } else if (markerInfo.isFile()) {
    const contents = readFileSync(marker, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(contents);
    if (!match?.[1]) throw new Error("Linked worktree .git marker is malformed");
    const linkedGitDir = realpathSync(resolve(root, match[1]));
    const worktreesDir = resolve(commonDir, "worktrees");
    const link = relative(worktreesDir, gitDir);
    const backlink = readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
    const registeredMarker = realpathSync(resolve(gitDir, backlink));
    const commonMarker = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    const registeredCommon = realpathSync(resolve(gitDir, commonMarker));
    if (linkedGitDir !== gitDir || !link || link === ".." || link.startsWith(`..${sep}`) || path.isAbsolute(link)
      || link.split(sep).length !== 1 || realpathSync(worktreesDir) !== worktreesDir
      || registeredMarker !== marker || registeredCommon !== commonDir) {
      throw new Error("Git metadata does not match the linked worktree marker");
    }
  } else {
    throw new Error("Project root has no normal or linked Git worktree marker");
  }
  return { root, gitDir, commonDir };
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-fA-F]{7,40}|HEAD(?:~[0-9]{1,4})?|[A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/.test(value)
    && !value.includes("..") && !value.endsWith("/");
}

function executeGitRead(raw: unknown, context: unknown, projectDirectory: string | undefined): GitReadResult {
  const invocation = context && typeof context === "object" ? context as Record<string, unknown> : {};
  if (typeof invocation.sessionID !== "string" || invocation.sessionID.length === 0 || invocation.agent !== "coder") {
    return error("git_read is available only to an authorized Coder invocation with a sessionID");
  }
  if (!projectDirectory) return error("git_read requires an OpenCode project location; no cwd fallback is used");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return error("A Git read operation is required");
  const input = raw as Record<string, unknown>;
  const operation = input.operation as GitReadOperation;
  if (!OPERATIONS.includes(operation)) return error("Unsupported Git read operation");
  const args: string[] = [];
  try {
    // Prove that setup's OpenCode project directory is the Git target. Never
    // discover a repository from the ARIA install tree or inherited cwd.
    const { root } = resolveGitProjectDirectory(projectDirectory);
    if (operation === "status") {
      args.push("status", "--short", "--branch", "--untracked-files=normal");
    } else {
      const file = literalPath(input.path);
      if (!file) return error(`${operation} requires one valid literal project-relative path`);
      if (isProtectedPath(file)) return error("Reads of protected .env files are refused");
      try {
        if (lstatSync(path.join(root, ...file.split("/"))).isDirectory()) {
          return error("Git read operations require one file path, not a directory");
        }
      } catch {
        // Deleted paths remain useful for diff/history; Git tree checks below
        // still reject a directory in the relevant committed tree.
      }
      const pathspec = `:(literal)${file}`;
      if (operation === "diff" || operation === "log") {
        const tree = runGit(root, ["ls-tree", "HEAD", "--", pathspec]);
        if (/^040000 tree /m.test(tree)) return error("Git read operations require one file path, not a directory");
      }
      if (operation === "diff") args.push("diff", "--no-ext-diff", "--no-textconv", "--", pathspec);
      if (operation === "log") args.push("log", "--no-decorate", "--oneline", "-20", "--", pathspec);
      if (operation === "show") {
        if (!validRevision(input.revision)) return error("show requires a valid revision");
        const tree = runGit(root, ["ls-tree", input.revision, "--", pathspec]);
        if (/^040000 tree /m.test(tree)) return error("Git read operations require one file path, not a directory");
        args.push("show", "--no-ext-diff", "--no-textconv", `${input.revision}:${file}`);
      }
    }
    return { content: runGit(root, args) || "(no output)", metadata: { title: `Git ${operation}` } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return error(`Git ${operation} failed: ${message.slice(0, 500)}`);
  }
}

/** Create a fixed-command, project-rooted, role-authorized native V2 read tool. */
export function createGitReadTool(projectDirectory: string | undefined): {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown, context: unknown) => Promise<GitReadResult>;
} {
  return {
    name: GIT_READ_TOOL_NAME,
    description: "Read Git status, a literal-path diff, a literal-path history summary, or a literal-path revision from the current OpenCode project repository. No shell or arbitrary Git arguments are accepted.",
    input: gitReadToolInputSchema,
    async execute(input, context) {
      return executeGitRead(input, context, projectDirectory);
    },
  };
}
