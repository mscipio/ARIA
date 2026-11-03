import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { scratchTaskScope } from "../src/scratch.js";
import { runReleaseCli } from "../src/release.js";
import { runShipCli } from "../src/ship.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubUrl = "https://github.com/reviewer/fixture.git";
const statePathEnv = "T007_RELEASE_TEST_STATE";
const logPathEnv = "T007_RELEASE_TEST_LOG";

let testRoot = "";
let fixtureRoot = "";
let workRoot = "";
let bareRoot = "";
let shimBin = "";
let realGit = "";
let statePath = "";
let invocationLog = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeGhState(state: Record<string, unknown>): Promise<void> {
  return writeFile(statePath, JSON.stringify(state));
}

beforeAll(async () => {
  const scope = await scratchTaskScope(repoRoot, "T007", "accepted release workflow focused regressions");
  testRoot = await mkdtemp(join(scope.dirs.testFixtures, "accepted-release-"));
  fixtureRoot = join(testRoot, "release-project");
  workRoot = join(fixtureRoot, "work");
  bareRoot = join(fixtureRoot, "remote.git");
  shimBin = join(testRoot, "bin");
  statePath = join(testRoot, "gh-state.json");
  invocationLog = join(testRoot, "gh-invocations.jsonl");
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  const foundGitDir = pathEntries.find((entry) => existsSync(join(entry, "git")));
  if (!foundGitDir) throw new Error("Regression fixture requires the existing Git executable on PATH");
  realGit = join(foundGitDir, "git");

  await mkdir(workRoot, { recursive: true });
  await mkdir(shimBin, { recursive: true });
  await mkdir(join(fixtureRoot, "hooks"), { recursive: true });
  // The source checkout is type=module; mark these extensionless PATH shims
  // CommonJS so Node's executable loader supports their require() calls.
  await writeFile(join(shimBin, "package.json"), '{"type":"commonjs"}\n');
  git(fixtureRoot, "init", "--bare", bareRoot);
  git(workRoot, "init", "-b", "main");
  git(workRoot, "config", "user.name", "ARIA regression fixture");
  git(workRoot, "config", "user.email", "aria-regression@example.invalid");
  git(workRoot, "config", "commit.gpgSign", "false");
  git(workRoot, "config", "tag.gpgSign", "false");
  git(workRoot, "config", "core.hooksPath", join(fixtureRoot, "hooks"));
  await writeFile(join(workRoot, "pyproject.toml"), '[project]\nname = "fixture"\nversion = "1.2.3"\n');
  await writeFile(join(workRoot, "module.py"), "value = 1\n");
  git(workRoot, "add", "pyproject.toml", "module.py");
  git(workRoot, "commit", "-m", "fixture initial");
  git(workRoot, "remote", "add", "origin", bareRoot);
  git(workRoot, "push", "--set-upstream", "origin", "main");
  git(workRoot, "tag", "--annotate", "1.2.3", "--message", "release fixture");
  git(workRoot, "push", "origin", "refs/tags/1.2.3");
  git(workRoot, "remote", "set-url", "origin", githubUrl);
  git(workRoot, "config", "branch.main.pushRemote", "origin");
  git(workRoot, "config", "aria.release.fullCheckCommand", "true");

  await writeFile(join(shimBin, "git"), `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const mapUrl = ${JSON.stringify(githubUrl)};
const opIndex = args.findIndex((arg) => arg === "ls-remote" || arg === "push");
if (opIndex >= 0) {
  const urlIndex = args.indexOf(mapUrl, opIndex + 1);
  if (urlIndex >= 0) args[urlIndex] = ${JSON.stringify(bareRoot)};
  if (args[opIndex] === "push") fs.appendFileSync(process.env.${logPathEnv}, "push\\n");
}
cp.execFileSync(realGit, args, { stdio: "inherit", env: process.env });
`);
  await chmod(join(shimBin, "git"), 0o755);
  await writeFile(join(shimBin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.${logPathEnv}, JSON.stringify({ args, host: process.env.GH_HOST }) + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "reviewer/fixture", url: "https://github.com/reviewer/fixture" }));
} else if (args[0] === "api") {
  const statePath = process.env.${statePathEnv};
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.apiCalls = (state.apiCalls ?? 0) + 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const release = state.changeOnCall && state.apiCalls >= state.changeOnCall ? state.changedRelease : state.release;
  process.stdout.write(JSON.stringify({ tag_name: "1.2.3", html_url: release.url, draft: release.draft, prerelease: release.prerelease, target_commitish: "main" }));
} else if (args[0] === "release" && args[1] === "create") {
  process.exitCode = 90;
} else {
  process.exitCode = 91;
}
`);
  await chmod(join(shimBin, "gh"), 0o755);

  await writeGhState({
    apiCalls: 0,
    release: { url: "https://github.com/reviewer/fixture/releases/tag/1.2.3", draft: false, prerelease: false },
    changedRelease: { url: "https://github.com/reviewer/fixture/releases/tag/1.2.3", draft: true, prerelease: false },
  });
  await writeFile(invocationLog, "");
  vi.stubEnv("PATH", `${shimBin}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("GH_HOST", "enterprise.example.invalid");
  vi.stubEnv(statePathEnv, statePath);
  vi.stubEnv(logPathEnv, invocationLog);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

describe("accepted release and scoped ship regressions", () => {
  it("reuses only the unchanged already-published release without pushing or creating another", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const args = ["1.2.3", "--publish", "--tag", "1.2.3"];

    expect(await runReleaseCli(args, workRoot)).toBe(0);
    expect(await runReleaseCli(args, workRoot)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Already published and verified: reviewer/fixture 1.2.3"));
    expect(error).not.toHaveBeenCalled();

    const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; host: string });
    expect(calls.every((call) => call.host === "github.com")).toBe(true);
    expect(calls.some((call) => call.args[0] === "release" && call.args[1] === "create")).toBe(false);
    expect(await readFile(invocationLog, "utf8")).not.toContain("push\n");
    expect(git(workRoot, "rev-parse", "HEAD")).toBe(git(bareRoot, "rev-parse", "refs/heads/main"));
    expect(git(workRoot, "rev-parse", "1.2.3^{commit}")).toBe(git(bareRoot, "rev-parse", "refs/tags/1.2.3^{commit}"));

    log.mockRestore();
    error.mockRestore();
  });

  it("rejects a publication state that changes after initial verification", async () => {
    await writeGhState({
      apiCalls: 0,
      changeOnCall: 2,
      release: { url: "https://github.com/reviewer/fixture/releases/tag/1.2.3", draft: false, prerelease: false },
      changedRelease: { url: "https://github.com/reviewer/fixture/releases/tag/1.2.3", draft: true, prerelease: false },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runReleaseCli(["1.2.3", "--publish", "--tag", "1.2.3"], workRoot);
    expect(result).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("publication state changed after project gates"));
    expect(await readFile(invocationLog, "utf8")).not.toContain("push\n");
    const calls = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[] });
    expect(calls.some((call) => call.args[0] === "release" && call.args[1] === "create")).toBe(false);
    error.mockRestore();
  });

  it("rejects traversal and unrelated staged files before scoped ship can commit", async () => {
    const shipRoot = join(testRoot, "ship-project");
    await mkdir(shipRoot, { recursive: true });
    await mkdir(join(shipRoot, "hooks"), { recursive: true });
    git(shipRoot, "init", "-b", "main");
    git(shipRoot, "config", "user.name", "ARIA regression fixture");
    git(shipRoot, "config", "user.email", "aria-regression@example.invalid");
    git(shipRoot, "config", "commit.gpgSign", "false");
    git(shipRoot, "config", "core.hooksPath", join(shipRoot, "hooks"));
    await writeFile(join(shipRoot, "selected.txt"), "initial\n");
    await writeFile(join(shipRoot, "other.txt"), "initial\n");
    git(shipRoot, "add", "selected.txt", "other.txt");
    git(shipRoot, "commit", "-m", "fixture initial");
    const head = git(shipRoot, "rev-parse", "HEAD");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runShipCli(["--paths", "../outside", "--message", "bad path"], shipRoot)).toBe(1);
    await writeFile(join(shipRoot, "selected.txt"), "selected change\n");
    await writeFile(join(shipRoot, "other.txt"), "staged unrelated change\n");
    git(shipRoot, "add", "other.txt");
    expect(await runShipCli(["--paths", "selected.txt", "--message", "scoped commit"], shipRoot)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Pre-existing staged changes contains paths outside --paths: other.txt"));
    expect(git(shipRoot, "rev-parse", "HEAD")).toBe(head);
    expect(git(shipRoot, "diff", "--cached", "--name-only")).toBe("other.txt");
    error.mockRestore();
  });
});
