import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export type ExecutorOptions = { cwd?: string };
export type Executor = (command: string, args: string[], options?: ExecutorOptions) => Promise<{ stdout: string; stderr: string }>;

export interface DependencyFileOps {
  readText(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  sha256(path: string): Promise<string>;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const defaultFileOps: DependencyFileOps = {
  readText: (path) => readFile(path, "utf8"),
  realpath,
  sha256: sha256File,
};

// ---------------------------------------------------------------------------
// Cross-platform command resolver (Windows .cmd/.bat shim support)
// ---------------------------------------------------------------------------

export type CommandResolution = { command: string; useComSpec: boolean };

const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat", ".exe"] as const;

function parsePathExt(pathExt?: string): string[] {
  if (!pathExt) return [...WINDOWS_SHIM_EXTENSIONS];
  return pathExt
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

/**
 * Resolve a command name to its executable path and ComSpec requirement.
 *
 * On non-Windows, returns the command as-is with `useComSpec: false`.
 *
 * On Windows:
 * - Commands with an extension (.exe, .cmd, .bat) or path separators are
 *   returned as-is.
 * - Otherwise, PATH directories are scanned for extensions parsed from
 *   `pathExt` (default ".cmd;.bat;.exe") in priority order.
 * - `.cmd`/`.bat` shims require ComSpec; native `.exe` does not.
 * - If nothing is found, the original command is returned to let execFile
 *   fail naturally with ENOENT.
 *
 * @param cmd Command name to resolve.
 * @param pathEnv Semicolon-separated PATH (default `process.env.PATH`).
 * @param pathExt Semicolon-separated extension list (default ".cmd;.bat;.exe").
 * @param platform Override `process.platform` for testing.
 * @param probe File-existence check (default `existsSync`).
 */
export function resolveCommand(
  cmd: string,
  pathEnv?: string,
  pathExt?: string,
  platform?: string,
  probe?: (path: string) => boolean,
): CommandResolution {
  const plat = platform ?? process.platform;

  // On non-Windows, execute directly — no shim resolution needed.
  if (plat !== "win32") {
    return { command: cmd, useComSpec: false };
  }

  // Explicit .cmd/.bat path — needs ComSpec (check before path-separator matching).
  if (/\.cmd$/i.test(cmd) || /\.bat$/i.test(cmd)) {
    return { command: cmd, useComSpec: true };
  }
  // Explicit .exe path or contains path separators — execute directly.
  if (/\.exe$/i.test(cmd) || cmd.includes("\\") || cmd.includes("/")) {
    return { command: cmd, useComSpec: false };
  }

  const extensions = parsePathExt(pathExt);
  const envPath = pathEnv ?? process.env.PATH ?? "";
  const pathDirs = envPath.split(";").filter(Boolean);
  const fileExists = probe ?? existsSync;

  // Scan PATH directories in order, then extensions in priority order within each.
  // Directory order takes precedence (first directory in PATH wins).
  // Within a directory, extension priority ensures .cmd/.bat shims are preferred
  // over native .exe.
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${cmd}${ext}`);
      if (fileExists(candidate)) {
        // .cmd / .bat require ComSpec; .exe can be executed directly.
        return { command: candidate, useComSpec: ext !== ".exe" };
      }
    }
  }

  // Not found — let execFile fail with ENOENT.
  return { command: cmd, useComSpec: false };
}

// ---------------------------------------------------------------------------
// ComSpec argument escaping (Windows cmd.exe metacharacter safety)
// ---------------------------------------------------------------------------

/** Characters that require quoting when passing arguments through cmd /s /c. */
const CMD_METACHAR_RE = /[&|><^%!"\s]/;

/**
 * Escape a single argument for safe use inside a `cmd /s /c` command string.
 *
 * 1. Doubles bare `%` → `%%` and `!` → `!!` to prevent environment variable
 *    expansion (cmd.exe expands these even inside quoted strings).
 * 2. If the resulting string contains CMD metacharacters or whitespace, wraps
 *    it in double quotes and escapes internal double quotes as `""`.
 */
function escapeCmdArg(arg: string): string {
  // Step 1: prevent % and ! variable expansion
  let escaped = arg.replace(/%/g, "%%").replace(/!/g, "!!");

  // Step 2: quote if the argument contains any metacharacter or whitespace
  if (CMD_METACHAR_RE.test(escaped)) {
    escaped = `"${escaped.replace(/"/g, '""')}"`;
  }

  return escaped;
}

/**
 * Build the argument list for `cmd.exe /s /c` that safely passes `command`
 * and `args` through the CMD command-line parser.
 *
 * @returns `["/s", "/c", escapedCommandString]`
 */
export function buildComSpecArgs(command: string, args: string[]): string[] {
  const escapedCommand = escapeCmdArg(command);
  const escapedArgs = args.map(escapeCmdArg);
  const fullCommand = [escapedCommand, ...escapedArgs].join(" ");
  // cmd /s /c strips the outer quotes, leaving the individually-quoted parts
  // for CMD to parse safely.
  return ["/s", "/c", `"${fullCommand}"`];
}

const comSpec = process.env.ComSpec || "cmd.exe";

const defaultExecutor: Executor = async (command, args, options) => {
  const resolved = resolveCommand(command);
  const opts = { timeout: 120_000, cwd: options?.cwd, shell: false };

  if (resolved.useComSpec) {
    const comSpecArgs = buildComSpecArgs(resolved.command, args);
    const { stdout, stderr } = await execFileAsync(comSpec, comSpecArgs, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  }

  const { stdout, stderr } = await execFileAsync(resolved.command, args, opts);
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepsStatus {
  opencode: { version: string | null; found: boolean };
  engram: { version: string | null; found: boolean; connected: boolean };
  context7: { configured: boolean; connected: boolean };
  codegraph: { version: string | null; found: boolean; connected: boolean };
}

export interface SyncResult {
  ok: boolean;
  engram: { action: string; version?: string; error?: string };
  context7: { action: string; error?: string };
  codegraph: { action: string; version?: string; error?: string };
  health?: DepsStatus;
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

async function run(executor: Executor, command: string, ...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await executor(command, args);
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: message };
  }
}

// ---------------------------------------------------------------------------
// OpenCode config path discovery (supports .json and .jsonc)
// ---------------------------------------------------------------------------

function discoverConfigPath(configDir?: string): string | null {
  const base = configDir ?? join(homedir(), ".config", "opencode");
  const jsonPath = join(base, "opencode.json");
  if (existsSync(jsonPath)) return jsonPath;
  const jsoncPath = join(base, "opencode.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  return null;
}

export function opencodeConfigPath(configDir?: string): string {
  const base = configDir ?? join(homedir(), ".config", "opencode");
  return join(base, "opencode.json");
}

/** Normalize JSONC comments and trailing commas without changing quoted strings. */
function stripJsoncComments(raw: string): string {
  let normalized = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        normalized += char;
      } else {
        normalized += " ";
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        normalized += "  ";
        blockComment = false;
        index++;
      } else {
        normalized += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (inString) {
      normalized += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      normalized += char;
    } else if (char === "/" && next === "/") {
      normalized += "  ";
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      normalized += "  ";
      blockComment = true;
      index++;
    } else {
      normalized += char;
    }
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(normalized[nextIndex] ?? "")) nextIndex++;
      if (normalized[nextIndex] === "}" || normalized[nextIndex] === "]") continue;
    }
    result += char;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Version / platform helpers
// ---------------------------------------------------------------------------

function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:[-.]\w+)?)/);
  return match?.[1] ?? null;
}

const SUPPORTED_PLATFORMS: Record<string, Record<string, string>> = {
  linux: { x64: "linux_amd64", arm64: "linux_arm64" },
  darwin: { x64: "darwin_amd64", arm64: "darwin_arm64" },
};

function platformArch(): { os: string; arch: string; assetSuffix: string } | null {
  const nodeOs = process.platform;
  const nodeArch = process.arch;

  const archMap = SUPPORTED_PLATFORMS[nodeOs];
  if (!archMap) return null;
  const assetSuffix = archMap[nodeArch];
  if (!assetSuffix) return null;

  const os = nodeOs === "darwin" ? "darwin" : "linux";
  const arch = nodeArch === "arm64" ? "arm64" : "amd64";
  return { os, arch, assetSuffix };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/[^\x00-\x7F]/g, "");
}

// ---------------------------------------------------------------------------
// Engram -- core semver tag validation
// ---------------------------------------------------------------------------

const CORE_SEMVER_RE = /^v\d+\.\d+\.\d+$/;

function isCoreSemverTag(tag: string): boolean {
  return CORE_SEMVER_RE.test(tag);
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

// ---------------------------------------------------------------------------
// Engram -- installation source detection
// ---------------------------------------------------------------------------

type EngramSource = "homebrew" | "unknown" | "missing";

function isWithinDirectory(path: string, directory: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedDirectory = resolve(directory);
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}${sep}`);
}

async function resolvedPath(path: string, fileOps: DependencyFileOps): Promise<string> {
  try {
    return await fileOps.realpath(path);
  } catch {
    return path;
  }
}

async function detectEngramSource(executor: Executor, fileOps: DependencyFileOps = defaultFileOps): Promise<EngramSource> {
  const detected = await detectEngram(executor);
  if (!detected.found) return "missing";

  // Check if brew manages engram
  const brewList = await run(executor, "brew", "list", "--formula");
  if (!brewList.ok || !brewList.stdout.includes("engram")) return "unknown";

  // Verify the active binary resolves into a Homebrew cellar
  const whichResult = await run(executor, "which", "engram");
  if (!whichResult.ok) return "unknown";

  const binPath = whichResult.stdout.split("\n")[0]?.trim();
  if (!binPath) return "unknown";

  const resolved = await resolvedPath(binPath, fileOps);

  const cellar = await run(executor, "brew", "--cellar");
  if (!cellar.ok) return "unknown";

  const cellarPath = cellar.stdout.split("\n")[0]?.trim();
  if (!cellarPath) return "unknown";
  const resolvedCellar = await resolvedPath(cellarPath, fileOps);

  return isWithinDirectory(resolved, resolvedCellar) ? "homebrew" : "unknown";
}

// ---------------------------------------------------------------------------
// Engram -- detect / sync
// ---------------------------------------------------------------------------

async function detectEngram(executor: Executor): Promise<{ found: boolean; version: string | null }> {
  const result = await run(executor, "engram", "version");
  if (!result.ok) return { found: false, version: null };
  return { found: true, version: extractVersion(result.stdout) };
}

async function syncEngramHomebrew(executor: Executor): Promise<SyncResult["engram"]> {
  const update = await run(executor, "brew", "update");
  if (!update.ok) {
    return { action: "brew-update-failed", error: `brew update failed: ${update.stderr}` };
  }

  const upgrade = await run(executor, "brew", "upgrade", "engram");
  if (!upgrade.ok) {
    return { action: "upgrade-failed", error: `brew upgrade engram failed: ${upgrade.stderr}` };
  }

  const setup = await run(executor, "engram", "setup", "opencode");
  if (!setup.ok) {
    return { action: "setup-failed", error: `engram setup opencode failed: ${setup.stderr}` };
  }

  const verify = await detectEngram(executor);
  if (!verify.found) {
    return { action: "post-install-verify-failed", error: "engram not found after brew upgrade" };
  }
  return { action: "synced (homebrew)", version: verify.version ?? undefined };
}

async function syncEngramGitHub(executor: Executor, fileOps: DependencyFileOps = defaultFileOps): Promise<SyncResult["engram"]> {
  const platform = platformArch();
  if (!platform) {
    return { action: "unsupported-platform", error: `Unsupported platform: ${process.platform}/${process.arch}` };
  }

  // Fetch releases list from GitHub API
  const releasesResult = await run(executor, "curl", "-fsSL", "https://api.github.com/repos/Gentleman-Programming/engram/releases?per_page=100");
  if (!releasesResult.ok) {
    return { action: "fetch-failed", error: `Failed to fetch releases: ${releasesResult.stderr}` };
  }

  let releases: GitHubRelease[];
  try {
    releases = JSON.parse(releasesResult.stdout);
    if (!Array.isArray(releases)) throw new Error("Expected array");
  } catch {
    return { action: "parse-failed", error: "Failed to parse GitHub releases response" };
  }

  // Select the newest stable core release with a matching platform asset
  let selectedRelease: GitHubRelease | null = null;
  let selectedTag: string | null = null;
  let selectedAsset: NonNullable<GitHubRelease["assets"]>[number] | null = null;

  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue;
    const tag = rel.tag_name;
    if (!tag || !isCoreSemverTag(tag)) continue;
    const assetName = `engram_${tag.slice(1)}_${platform.assetSuffix}.tar.gz`;
    const asset = rel.assets?.find((candidate) => candidate.name === assetName);
    if (!asset) continue;
    selectedRelease = rel;
    selectedTag = tag;
    selectedAsset = asset;
    break; // releases are newest-first
  }

  if (!selectedRelease || !selectedTag || !selectedAsset) {
    return { action: "no-asset", error: `No stable release found with a versioned ${platform.assetSuffix} asset` };
  }

  const assetName = selectedAsset.name;

  const current = await detectEngram(executor);
  const selectedVersion = selectedTag.replace(/^v/, "");
  if (current.version && current.version === selectedVersion) {
    // Already on latest -- just run setup
    const setup = await run(executor, "engram", "setup", "opencode");
    if (!setup.ok) {
      return { action: "setup-failed", error: `engram setup opencode failed: ${setup.stderr}` };
    }
    return { action: "already-latest", version: current.version };
  }

  const downloadUrl = selectedAsset.browser_download_url;

  // Use a unique temp directory for all intermediate files
  let tmpDir: string;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "rdc-engram-"));
  } catch (err) {
    return { action: "tmpdir-failed", error: `Could not create temp directory: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const tarball = join(tmpDir, assetName);

    // Download binary
    const dl = await run(executor, "curl", "-fsSL", "-o", tarball, downloadUrl);
    if (!dl.ok) {
      return { action: "download-failed", error: `Download failed: ${dl.stderr}` };
    }

    // Download and verify checksum (fail closed)
    const checksumsUrl = `https://github.com/Gentleman-Programming/engram/releases/download/${selectedTag}/checksums.txt`;
    const checksumFile = join(tmpDir, "checksums.txt");
    const cs = await run(executor, "curl", "-fsSL", "-o", checksumFile, checksumsUrl);
    if (!cs.ok) {
      return { action: "checksum-download-failed", error: `Failed to download checksums.txt: ${cs.stderr}` };
    }

    let csContent: string;
    try {
      csContent = await fileOps.readText(checksumFile);
    } catch (err) {
      return { action: "checksum-read-failed", error: `Failed to read checksums: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Match exact asset name in checksums file
    const csLines = csContent.split("\n");
    const expectedLine = csLines.find((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.length >= 2 && parts[1] === assetName;
    });
    if (!expectedLine) {
      return { action: "checksum-entry-missing", error: `No checksum entry for ${assetName} in checksums.txt` };
    }
    const expected = expectedLine.trim().split(/\s+/)[0];
    if (!expected) {
      return { action: "checksum-entry-missing", error: `Empty checksum entry for ${assetName}` };
    }

    let actual: string;
    try {
      actual = await fileOps.sha256(tarball);
    } catch (err) {
      return { action: "hash-compute-failed", error: `SHA-256 computation failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!actual || actual !== expected) {
      return { action: "checksum-mismatch", error: `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}` };
    }

    // Extract binary
    const extractDir = join(tmpDir, "extract");
    const mkdirResult = await run(executor, "mkdir", "-p", extractDir);
    if (!mkdirResult.ok) {
      return { action: "mkdir-failed", error: `Failed to create extract dir: ${mkdirResult.stderr}` };
    }
    const extract = await run(executor, "tar", "xzf", tarball, "-C", extractDir);
    if (!extract.ok) {
      return { action: "extract-failed", error: `tar extraction failed: ${extract.stderr}` };
    }

    // Find the extracted binary
    const findResult = await run(executor, "find", extractDir, "-name", "engram", "-type", "f");
    if (!findResult.ok || !findResult.stdout) {
      return { action: "find-failed", error: "Could not find engram binary in extracted archive" };
    }
    const extractedBinary = findResult.stdout.split("\n")[0]?.trim();
    if (!extractedBinary) {
      return { action: "find-failed", error: "Could not find engram binary in extracted archive" };
    }

    // Determine install location -- preserve existing location only if writable and not inside Homebrew cellar
    let installDir: string;
    const whichEngram = await run(executor, "which", "engram");
    if (whichEngram.ok) {
      const existingBin = whichEngram.stdout.split("\n")[0]?.trim();
      if (existingBin) {
        const resolved = await resolvedPath(existingBin, fileOps);
        const cellar = await run(executor, "brew", "--cellar");
        const cellarPath = cellar.ok ? cellar.stdout.split("\n")[0]?.trim() : null;
        const resolvedCellar = cellarPath ? await resolvedPath(cellarPath, fileOps) : null;
        if (resolvedCellar && isWithinDirectory(resolved, resolvedCellar)) {
          // Don't overwrite a Homebrew-managed binary
          installDir = join(homedir(), ".local", "bin");
        } else {
          installDir = resolve(existingBin, "..");
        }
      } else {
        installDir = join(homedir(), ".local", "bin");
      }
    } else {
      installDir = join(homedir(), ".local", "bin");
    }

    const mkdirInstall = await run(executor, "mkdir", "-p", installDir);
    if (!mkdirInstall.ok) {
      return { action: "mkdir-failed", error: `Failed to create install dir: ${mkdirInstall.stderr}` };
    }
    const targetPath = join(installDir, "engram");

    // Atomic replace: copy to temp, chmod, then mv
    const tmpBinary = join(tmpDir, "engram-new");
    const cpResult = await run(executor, "cp", extractedBinary, tmpBinary);
    if (!cpResult.ok) {
      return { action: "copy-failed", error: `Failed to copy binary: ${cpResult.stderr}` };
    }
    const chmodResult = await run(executor, "chmod", "755", tmpBinary);
    if (!chmodResult.ok) {
      return { action: "chmod-failed", error: `Failed to chmod binary: ${chmodResult.stderr}` };
    }
    const mvResult = await run(executor, "mv", "-f", tmpBinary, targetPath);
    if (!mvResult.ok) {
      return { action: "replace-failed", error: `Failed to replace binary: ${mvResult.stderr}` };
    }

    // Setup OpenCode integration
    const setup = await run(executor, "engram", "setup", "opencode");
    if (!setup.ok) {
      return { action: "setup-failed", error: `engram setup opencode failed: ${setup.stderr}` };
    }

    // Verify the installed binary works
    const verify = await detectEngram(executor);
    if (!verify.found) {
      return { action: "post-install-verify-failed", error: "engram not found after installation" };
    }
    return { action: "synced (github)", version: verify.version ?? undefined };
  } finally {
    // Always clean up temp directory
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function syncEngram(executor: Executor, fileOps: DependencyFileOps): Promise<SyncResult["engram"]> {
  const detected = await detectEngram(executor);
  if (!detected.found) {
    // Not installed -- try Homebrew first, then GitHub
    const brewPath = await run(executor, "which", "brew");
    if (brewPath.ok && brewPath.stdout) {
      const brewInstall = await run(executor, "brew", "install", "gentleman-programming/tap/engram");
      if (brewInstall.ok) {
        const setup = await run(executor, "engram", "setup", "opencode");
        if (!setup.ok) {
          return { action: "setup-failed", error: `engram setup opencode failed: ${setup.stderr}` };
        }
        const verify = await detectEngram(executor);
        if (!verify.found) {
          return { action: "post-install-verify-failed", error: "engram not found after brew install" };
        }
        return { action: "synced (homebrew)", version: verify.version ?? undefined };
      }
    }
    // Fallback to GitHub release
    return syncEngramGitHub(executor, fileOps);
  }

  const source = await detectEngramSource(executor, fileOps);
  if (source === "homebrew") {
    return syncEngramHomebrew(executor);
  }
  return syncEngramGitHub(executor, fileOps);
}

// ---------------------------------------------------------------------------
// Context7
// ---------------------------------------------------------------------------

const CONTEXT7_REMOTE_URL = "https://mcp.context7.com/mcp";
const CONTEXT7_NAME = "context7";

async function detectContext7(executor: Executor, configDir?: string): Promise<{ configured: boolean; connected: boolean }> {
  const configPath = discoverConfigPath(configDir);
  if (!configPath) return { configured: false, connected: false };

  try {
    const raw = await readFile(configPath, "utf8");
    const stripped = configPath.endsWith(".jsonc") ? stripJsoncComments(raw) : raw;
    const config = JSON.parse(stripped);
    const server = config?.mcp?.[CONTEXT7_NAME];
    if (!server) return { configured: false, connected: false };

    const isRemote = server.type === "remote" && server.url === CONTEXT7_REMOTE_URL;
    const enabled = server.enabled !== false;

    return { configured: isRemote && enabled, connected: isRemote && enabled };
  } catch {
    return { configured: false, connected: false };
  }
}

async function syncContext7(executor: Executor, configDir?: string): Promise<SyncResult["context7"]> {
  const detected = await detectContext7(executor, configDir);
  if (detected.configured) {
    return { action: "already-configured" };
  }

  const result = await run(executor, "opencode", "mcp", "add", CONTEXT7_NAME, "--url", CONTEXT7_REMOTE_URL);
  if (!result.ok) {
    return { action: "add-failed", error: `opencode mcp add context7 failed: ${result.stderr}` };
  }
  return { action: "configured" };
}

// ---------------------------------------------------------------------------
// CodeGraph
// ---------------------------------------------------------------------------

async function detectCodeGraph(executor: Executor): Promise<{ found: boolean; version: string | null }> {
  const result = await run(executor, "codegraph", "--version");
  if (!result.ok) return { found: false, version: null };
  return { found: true, version: extractVersion(result.stdout) };
}

async function syncCodeGraph(executor: Executor): Promise<SyncResult["codegraph"]> {
  const detected = await detectCodeGraph(executor);

  if (!detected.found) {
    const installResult = await run(executor, "npm", "install", "-g", "@colbymchenry/codegraph@latest");
    if (!installResult.ok) {
      return { action: "install-failed", error: `npm install -g @colbymchenry/codegraph failed: ${installResult.stderr}` };
    }
  } else {
    const upgrade = await run(executor, "codegraph", "upgrade");
    if (!upgrade.ok) {
      return { action: "upgrade-failed", error: `codegraph upgrade failed: ${upgrade.stderr}` };
    }
  }

  // Reconcile OpenCode MCP config
  const reconcileResult = await run(executor, "codegraph", "install", "--target", "opencode", "--location", "global", "--yes");
  if (!reconcileResult.ok) {
    return { action: "reconcile-failed", error: `codegraph install --target opencode failed: ${reconcileResult.stderr}` };
  }

  // Verify CodeGraph is available after install/upgrade
  const verify = await detectCodeGraph(executor);
  if (!verify.found) {
    return { action: "post-install-verify-failed", error: "codegraph not found after installation" };
  }
  return { action: "synced", version: verify.version ?? undefined };
}

// ---------------------------------------------------------------------------
// MCP connectivity via opencode mcp list
// ---------------------------------------------------------------------------

export interface McpStatus {
  engram: boolean;
  context7: boolean;
  codegraph: boolean;
}

export function parseMcpList(output: string): McpStatus {
  const clean = stripAnsi(output);
  const result: McpStatus = { engram: false, context7: false, codegraph: false };

  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\w+)\s+(connected|disconnected|error)/);
    if (match?.[1] && match[2]) {
      const name = match[1];
      const status = match[2];
      if (name in result) {
        result[name as keyof McpStatus] = status === "connected";
      }
    }
  }

  return result;
}

async function detectMcpConnectivity(executor: Executor): Promise<McpStatus> {
  const result = await run(executor, "opencode", "mcp", "list");
  if (!result.ok) {
    return { engram: false, context7: false, codegraph: false };
  }
  return parseMcpList(result.stdout);
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

async function detectOpenCode(executor: Executor): Promise<{ found: boolean; version: string | null }> {
  const result = await run(executor, "opencode", "--version");
  if (!result.ok) return { found: false, version: null };
  return { found: true, version: extractVersion(result.stdout) };
}

export async function doctor(executor: Executor = defaultExecutor, configDir?: string): Promise<DepsStatus> {
  const [opencode, engram, context7, codegraph, mcp] = await Promise.all([
    detectOpenCode(executor),
    detectEngram(executor),
    detectContext7(executor, configDir),
    detectCodeGraph(executor),
    detectMcpConnectivity(executor),
  ]);

  return {
    opencode,
    engram: { ...engram, connected: mcp.engram },
    context7: { ...context7, connected: context7.configured && mcp.context7 },
    codegraph: { ...codegraph, connected: mcp.codegraph },
  };
}

export function formatDoctor(version: string, status: DepsStatus): string {
  const lines = [
    `Review-Driven Coding ${version}`,
    "",
    `OpenCode     ${status.opencode.found ? `[OK] ${status.opencode.version}` : "[FAIL] not found"}`,
    `Engram       ${status.engram.found ? `[OK] ${status.engram.version}` : "[FAIL] not found"}`,
    `Context7     ${status.context7.configured ? "[OK] configured" : "[FAIL] not configured"}`,
    `CodeGraph    ${status.codegraph.found ? `[OK] ${status.codegraph.version}` : "[FAIL] not found"}`,
    "",
    "Required MCPs:",
    `  engram     ${status.engram.connected ? "[OK] connected" : "[FAIL] not connected"}`,
    `  context7   ${status.context7.connected ? "[OK] connected" : "[FAIL] not connected"}`,
    `  codegraph  ${status.codegraph.connected ? "[OK] connected" : "[FAIL] not connected"}`,
  ];
  return lines.join("\n");
}

export function doctorExitCode(status: DepsStatus): number {
  if (!status.opencode.found) return 1;
  if (!status.engram.found) return 1;
  if (!status.engram.connected) return 1;
  if (!status.context7.connected) return 1;
  if (!status.codegraph.found) return 1;
  if (!status.codegraph.connected) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Sync orchestrator (sequential, serializes OpenCode mutations)
// ---------------------------------------------------------------------------

export async function depsSync(executor: Executor = defaultExecutor, configDir?: string, fileOps: DependencyFileOps = defaultFileOps): Promise<SyncResult> {
  // Run each sync sequentially so OpenCode config mutations are serialized.
  // Continue to later dependencies after earlier failures so the report
  // contains as many failures as possible.

  const engramResult = await syncEngram(executor, fileOps);
  const context7Result = await syncContext7(executor, configDir);
  const codegraphResult = await syncCodeGraph(executor);

  // Final health verification -- reuse doctor logic
  const health = await doctor(executor, configDir);
  const healthOk = doctorExitCode(health) === 0;

  const hasErrors = Boolean(engramResult.error || context7Result.error || codegraphResult.error);

  return {
    ok: !hasErrors && healthOk,
    engram: engramResult,
    context7: context7Result,
    codegraph: codegraphResult,
    health,
  };
}

export function formatSyncResult(result: SyncResult): string {
  const lines: string[] = [];

  lines.push(`Engram:    ${result.engram.error ? `[FAIL] ${result.engram.error}` : `[OK] ${result.engram.action}${result.engram.version ? ` (${result.engram.version})` : ""}`}`);
  lines.push(`Context7:  ${result.context7.error ? `[FAIL] ${result.context7.error}` : `[OK] ${result.context7.action}`}`);
  lines.push(`CodeGraph: ${result.codegraph.error ? `[FAIL] ${result.codegraph.error}` : `[OK] ${result.codegraph.action}${result.codegraph.version ? ` (${result.codegraph.version})` : ""}`}`);

  if (result.ok) {
    lines.push("");
    lines.push("[OK] All required dependencies synchronized.");
  } else {
    if (result.health) {
      lines.push("");
      lines.push("Health:");
      lines.push(`  engram     ${result.health.engram.connected ? "[OK] connected" : "[FAIL] not connected"}`);
      lines.push(`  context7   ${result.health.context7.connected ? "[OK] connected" : "[FAIL] not connected"}`);
      lines.push(`  codegraph  ${result.health.codegraph.connected ? "[OK] connected" : "[FAIL] not connected"}`);
    }
    lines.push("");
    lines.push("[FAIL] Some dependencies failed to synchronize.");
  }

  return lines.join("\n");
}

// Expose for testing
export {
  defaultExecutor,
  detectEngram,
  detectEngramSource,
  detectCodeGraph,
  detectContext7,
  detectMcpConnectivity,
  detectOpenCode,
  syncEngramGitHub,
  syncEngramHomebrew,
  isCoreSemverTag,
  discoverConfigPath,
  stripJsoncComments,
};
