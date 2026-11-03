import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep, win32 } from "node:path";
import { assertContained, safeProjectFile } from "./paths.js";
import { isFilesystemRoot } from "./plan-tool.js";
import { resolveGitProjectDirectory, sanitizedGitEnv } from "./git-tool.js";
export const SHIP_TOOL_NAME = "aria_ship";
const MAX_PATHS = 1000;
export const shipToolInputSchema = {
    type: "object",
    properties: {
        paths: { type: "array", minItems: 1, maxItems: MAX_PATHS, items: { type: "string", minLength: 1, maxLength: 4096 } },
        message: { type: "string", minLength: 1, maxLength: 10000 },
        push: { type: "boolean", default: false },
    },
    required: ["paths", "message"],
    additionalProperties: false,
};
const USAGE = "Usage: aria ship --paths <file> [<file> ...] --message <text> [--push]";
function fail(message) {
    return { code: 1, output: `aria ship: ${message}\n${USAGE}` };
}
/** Strict CLI parser shared by direct `aria ship` and the native tool. */
export function parseShipArgs(args) {
    let paths;
    let message;
    let push = false;
    for (let index = 0; index < args.length;) {
        const option = args[index];
        if (option === "--paths") {
            if (paths !== undefined)
                throw new Error("Option --paths may be specified only once");
            paths = [];
            index += 1;
            while (index < args.length && args[index] !== "--message" && args[index] !== "--push") {
                const value = args[index];
                if (value?.startsWith("--"))
                    throw new Error(`Unknown ship option: ${value}`);
                paths.push(value ?? "");
                index += 1;
            }
            if (paths.length === 0)
                throw new Error("Option --paths requires one or more explicit files");
            if (paths.length > MAX_PATHS)
                throw new Error(`Option --paths accepts at most ${MAX_PATHS} files`);
            continue;
        }
        if (option === "--message") {
            if (message !== undefined)
                throw new Error("Option --message may be specified only once");
            const value = args[index + 1];
            if (value === undefined)
                throw new Error("Missing value for --message");
            message = value;
            index += 2;
            continue;
        }
        if (option === "--push") {
            if (push)
                throw new Error("Option --push may be specified only once");
            push = true;
            index += 1;
            continue;
        }
        throw new Error(option === undefined ? "Missing ship option" : `Unknown ship option: ${option}`);
    }
    if (!paths?.length)
        throw new Error("Option --paths requires one or more explicit files");
    if (message === undefined || message.trim().length === 0)
        throw new Error("A non-empty --message is required");
    if (message.length > 10_000 || message.includes("\0"))
        throw new Error("--message must be at most 10000 characters and contain no NUL");
    return { paths, message, push };
}
function git(cwd, args) {
    return execFileSync("git", [
        "--literal-pathspecs", "-C", cwd,
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "color.ui=false",
        "--no-pager",
        ...args,
    ], {
        cwd,
        env: sanitizedGitEnv(),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
    });
}
function optionalGit(cwd, args) {
    try {
        return git(cwd, args);
    }
    catch (error) {
        const exit = error && typeof error === "object" ? error.status : undefined;
        if (exit === 1)
            return undefined;
        throw error;
    }
}
function nulPaths(value) {
    return value.split("\0").filter((item) => item.length > 0);
}
function assertNoUnsafeOperation(cwd, gitDir) {
    const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    if (!branch)
        throw new Error("Ship requires a valid, attached Git branch");
    git(cwd, ["check-ref-format", "--branch", branch]);
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"]) {
        try {
            lstatSync(resolve(gitDir, marker));
            throw new Error(`Ship is unavailable while Git operation state exists (${marker})`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    if (git(cwd, ["ls-files", "-u", "-z"]).length > 0)
        throw new Error("Ship is unavailable while the index contains unresolved conflicts");
    return branch;
}
function normalizeInputPath(input) {
    if (typeof input !== "string" || input.length === 0 || input.length > 4096)
        throw new Error("Each --paths entry must be a non-empty path of at most 4096 characters");
    if ([...input].some((character) => {
        const code = character.charCodeAt(0);
        return code === 0 || code < 0x20 || code === 0x7f;
    }))
        throw new Error("File paths may not contain control characters");
    if (isAbsolute(input) || win32.isAbsolute(input) || /^[A-Za-z]:/.test(input))
        throw new Error(`Path must be project-relative: ${input}`);
    let portable = process.platform === "win32" ? input.replaceAll("\\", "/") : input;
    // `./-name` is the explicit CLI spelling for a literal filename beginning
    // with a dash; strip only that one leading escape component.
    if (portable.startsWith("./-"))
        portable = portable.slice(2);
    const pieces = portable.split("/");
    if (pieces.some((part) => part === ".." || part === "."))
        throw new Error(`Path traversal is not allowed: ${input}`);
    const normalized = pieces.filter(Boolean).join("/");
    if (!normalized)
        throw new Error("Path resolves to the project directory");
    if (normalized.split("/").some((part) => [".git", "scratch"].includes(part.toLowerCase()))) {
        throw new Error(`Git metadata and generated scratch artifacts cannot be shipped: ${input}`);
    }
    return normalized;
}
function treeEntries(cwd, revision, file) {
    return git(cwd, ["ls-tree", "-z", revision, "--", file]);
}
function entryMode(entries, file) {
    const record = entries.split("\0").find((item) => item.endsWith(`\t${file}`));
    return record?.slice(0, record.indexOf(" "));
}
async function validatePaths(root, cwd, inputs, head) {
    const selected = new Set();
    for (const input of inputs) {
        const file = normalizeInputPath(input);
        if (selected.has(file))
            throw new Error(`Duplicate --paths entry: ${file}`);
        selected.add(file);
        const safe = await safeProjectFile(root, file, { allowMissing: true });
        assertContained(root, safe.path, "Ship path");
        // Git submodules have their own metadata and independent worktree. Never
        // recurse into a nested repository as though it were a project file.
        let parent = dirname(safe.path);
        for (;;) {
            if (parent === root)
                break;
            const marker = resolve(parent, ".git");
            try {
                lstatSync(marker);
                throw new Error(`Nested Git metadata is not a ship target: ${input}`);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            const next = resolve(parent, "..");
            if (next === parent || !next.startsWith(`${root}${sep}`))
                break;
            parent = next;
        }
        let exists = true;
        try {
            lstatSync(safe.path);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            exists = false;
        }
        const index = git(cwd, ["ls-files", "--stage", "-z", "--", file]);
        const headEntry = head ? treeEntries(cwd, head, file) : "";
        const mode = entryMode(index, file) ?? entryMode(headEntry, file);
        if (!exists && !mode)
            throw new Error(`Deleted path is not tracked and cannot be staged: ${file}`);
        if (mode === "040000" || mode === "160000")
            throw new Error(`Only regular files may be shipped (directories/submodules refused): ${file}`);
    }
    return [...selected];
}
function configuredValue(cwd, key) {
    return nulPaths(optionalGit(cwd, ["config", "--null", "--get-all", key]) ?? "");
}
function pushTarget(cwd, branch) {
    if (configuredValue(cwd, `branch.${branch}.merge`).length > 1) {
        throw new Error(`Push branch is ambiguous: branch ${branch} has multiple merge values`);
    }
    const remoteKeys = [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`];
    let remote;
    for (const key of remoteKeys) {
        const values = configuredValue(cwd, key);
        if (values.length > 1)
            throw new Error(`Push destination is ambiguous: ${key} has multiple values`);
        if (values.length === 1) {
            remote = values[0];
            break;
        }
    }
    remote ??= "origin";
    if (!remote || remote === "." || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(remote)) {
        throw new Error("Configured push remote is unsupported or ambiguous");
    }
    const remoteNames = git(cwd, ["remote"]).split(/\r?\n/).filter(Boolean);
    if (!remoteNames.includes(remote))
        throw new Error(`Configured push remote is unavailable: ${remote}`);
    const pushUrl = git(cwd, ["remote", "get-url", "--push", "--all", remote]).split(/\r?\n/).filter(Boolean);
    if (pushUrl.length !== 1 || !pushUrl[0] || pushUrl[0].startsWith("-") || /^ext::/i.test(pushUrl[0])) {
        throw new Error(`Push requires exactly one supported configured push URL for remote ${remote}`);
    }
    if (configuredValue(cwd, `remote.${remote}.mirror`).some((value) => value.toLowerCase() === "true")) {
        throw new Error(`Mirror push configuration is refused for remote ${remote}`);
    }
    if (configuredValue(cwd, `remote.${remote}.push`).length > 0) {
        throw new Error(`Configured refspecs for remote ${remote} are refused; use an unambiguous branch push configuration`);
    }
    if (configuredValue(cwd, "push.pushOption").length > 0 || configuredValue(cwd, `remote.${remote}.pushOption`).length > 0) {
        throw new Error("Configured push options are refused");
    }
    const symbolic = git(cwd, ["rev-parse", "--symbolic-full-name", "@{push}"]).trim();
    const prefix = `refs/remotes/${remote}/`;
    if (!symbolic.startsWith(prefix) || symbolic.length <= prefix.length) {
        throw new Error(`Push branch for ${remote} is ambiguous or outside its remote-tracking namespace`);
    }
    const targetBranch = symbolic.slice(prefix.length);
    const fullRef = `refs/heads/${targetBranch}`;
    git(cwd, ["check-ref-format", fullRef]);
    return { remote, pushUrl: pushUrl[0], branch: targetBranch };
}
function stagedPaths(cwd) {
    return nulPaths(git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", "--"]));
}
function assertScoped(paths, selected, description) {
    const outside = paths.filter((file) => !selected.has(file));
    if (outside.length > 0)
        throw new Error(`${description} contains paths outside --paths: ${outside.slice(0, 10).join(", ")}`);
}
function committedPaths(cwd, head, previousHead) {
    if (previousHead)
        return nulPaths(git(cwd, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", previousHead, head]));
    return nulPaths(git(cwd, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", head]));
}
function headHash(cwd) {
    return optionalGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim();
}
function parentOf(cwd, head) {
    const fields = git(cwd, ["rev-list", "--parents", "-n", "1", head]).trim().split(/\s+/);
    return fields[1];
}
function parentsOf(cwd, head) {
    return git(cwd, ["rev-list", "--parents", "-n", "1", head]).trim().split(/\s+/).slice(1);
}
function pushCommit(cwd, target, hash) {
    const ref = `refs/heads/${target.branch}`;
    git(cwd, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", target.pushUrl, `${hash}:${ref}`]);
    const rows = git(cwd, ["ls-remote", target.pushUrl, ref]).split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1 || rows[0] !== `${hash}\t${ref}`) {
        throw new Error("Push returned success but the configured destination ref did not verify at the requested commit");
    }
}
function matchingCurrentCommit(cwd, paths, message) {
    const head = headHash(cwd);
    if (!head)
        return undefined;
    const rawCommit = git(cwd, ["cat-file", "commit", head]);
    const separator = rawCommit.indexOf("\n\n");
    const currentMessage = separator < 0 ? "" : rawCommit.slice(separator + 2);
    const expectedMessage = message.endsWith("\n") ? message : `${message}\n`;
    if (currentMessage !== expectedMessage)
        return undefined;
    const changed = committedPaths(cwd, head, parentOf(cwd, head));
    if (changed.length === 0 || changed.some((file) => !paths.includes(file)))
        return undefined;
    return head;
}
async function executeShip(input, invocationDirectory) {
    try {
        if (typeof invocationDirectory !== "string" || invocationDirectory.trim().length === 0 || isFilesystemRoot(invocationDirectory)) {
            throw new Error("Ship requires a meaningful OpenCode project working directory");
        }
        const { root: cwd, gitDir } = resolveGitProjectDirectory(invocationDirectory);
        const branch = assertNoUnsafeOperation(cwd, gitDir);
        const before = headHash(cwd);
        const paths = await validatePaths(cwd, cwd, input.paths, before);
        const selected = new Set(paths);
        const target = input.push ? pushTarget(cwd, branch) : undefined;
        const priorStaged = stagedPaths(cwd);
        assertScoped(priorStaged, selected, "Pre-existing staged changes");
        const unmerged = git(cwd, ["ls-files", "-u", "-z"]);
        if (unmerged.length > 0)
            throw new Error("Ship is unavailable while the index contains unresolved conflicts");
        try {
            git(cwd, ["add", "--", ...paths]);
        }
        catch {
            throw new Error("Staging failed; no commit was attempted. Inspect the selected paths and index (no reset or discard was performed)");
        }
        const afterAdd = stagedPaths(cwd);
        assertScoped(afterAdd, selected, "Staged changes");
        if (afterAdd.length === 0) {
            if (target) {
                const existing = matchingCurrentCommit(cwd, paths, input.message);
                if (existing) {
                    try {
                        pushCommit(cwd, target, existing);
                        return { code: 0, output: `No new commit created; pushed matching existing commit ${existing} to ${target.remote}:${target.branch}.` };
                    }
                    catch {
                        return { code: 1, output: `No new commit created. Push retry failed for existing commit ${existing} to ${target.remote}:${target.branch}; inspect Git/remote state before retrying.` };
                    }
                }
            }
            throw new Error("No selected file changes to commit");
        }
        let commitFailure;
        try {
            git(cwd, ["commit", "--only", "--cleanup=verbatim", "-m", input.message, "--", ...paths]);
        }
        catch (error) {
            commitFailure = error;
        }
        const afterCommit = headHash(cwd);
        if (!afterCommit || afterCommit === before) {
            if (commitFailure)
                throw new Error("Commit did not complete; selected changes remain staged for inspection/recovery (no reset or discard was performed)");
            throw new Error("Git reported success but no new commit was created");
        }
        let committed;
        try {
            const parents = parentsOf(cwd, afterCommit);
            if ((before && (parents.length !== 1 || parents[0] !== before)) || (!before && parents.length !== 0)) {
                throw new Error("the commit does not have the expected single-parent transition");
            }
            committed = committedPaths(cwd, afterCommit, before);
            assertScoped(committed, selected, "New commit");
            if (committed.length === 0)
                throw new Error("the commit contains no verifiable file delta");
            const branchAfter = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
            if (branchAfter !== branch)
                throw new Error("the branch changed during hooks");
            assertScoped(stagedPaths(cwd), selected, "Staged changes after commit");
        }
        catch (error) {
            return { code: 1, output: `Commit ${afterCommit} was created but post-commit verification failed (${error instanceof Error ? error.message : "unknown verification failure"}); no push attempted. Stop and inspect repository/index state.` };
        }
        if (commitFailure)
            return { code: 1, output: `Commit ${afterCommit} was created, but the commit command reported a failure. No push attempted; inspect this commit and repository state before retrying.` };
        if (!target)
            return { code: 0, output: `Created commit ${afterCommit} on ${branch} with ${committed.length} selected path(s); no push requested.` };
        try {
            pushCommit(cwd, target, afterCommit);
            return { code: 0, output: `Created and pushed commit ${afterCommit} from ${branch} to ${target.remote}:${target.branch} (${committed.length} selected path(s)).` };
        }
        catch {
            return { code: 1, output: `Commit ${afterCommit} remains local; push to ${target.remote}:${target.branch} failed. Do not repeat the commit blindly. Re-running this exact ship request with --push recognizes and retries this matching commit without creating another.` };
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : "Git ship operation failed");
    }
}
/** Execute the strict CLI form in the current project invocation directory. */
export async function runShipCli(args, invocationDirectory) {
    let input;
    try {
        input = parseShipArgs(args);
    }
    catch (error) {
        console.error(`aria ship: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
        return 1;
    }
    const result = await executeShip(input, invocationDirectory);
    (result.code === 0 ? console.log : console.error)(result.output);
    return result.code;
}
/** Create a fixed-argv Node launcher; all repository validation lives in the CLI implementation. */
export function createShipTool(packageRoot, projectDirectory) {
    return {
        name: SHIP_TOOL_NAME,
        description: "Commit only the explicitly selected project files, optionally pushing the exact configured branch. No shell, arbitrary argv, cwd, environment, or remote URL is accepted. Repository commit hooks and clean filters are trusted code and may execute.",
        input: shipToolInputSchema,
        async execute(raw, context) {
            const invocation = context && typeof context === "object" ? context : {};
            if (typeof invocation.sessionID !== "string" || invocation.sessionID.length === 0 || invocation.agent !== "coder") {
                return { content: "aria_ship is available only to an authorized Coder invocation with a sessionID", metadata: { title: "Error" } };
            }
            if (!projectDirectory || !isAbsolute(projectDirectory))
                return { content: "aria_ship requires an absolute OpenCode project location; no cwd fallback is used", metadata: { title: "Error" } };
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                return { content: "paths and message are required", metadata: { title: "Error" } };
            }
            const input = raw;
            if (Object.keys(input).some((key) => !["paths", "message", "push"].includes(key))
                || !Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_PATHS
                || input.paths.some((file) => typeof file !== "string" || file.length === 0 || file.length > 4096 || [...file].some((char) => {
                    const code = char.charCodeAt(0);
                    return code === 0 || code < 0x20 || code === 0x7f;
                }))
                || typeof input.message !== "string" || input.message.trim().length === 0 || input.message.length > 10_000 || input.message.includes("\0")
                || (input.push !== undefined && typeof input.push !== "boolean")) {
                return { content: "Invalid aria_ship input; supply explicit paths, a message, and optional boolean push", metadata: { title: "Error" } };
            }
            const args = ["ship", "--paths", ...input.paths.map((file) => file.startsWith("-") ? `./${file}` : file), "--message", input.message];
            if (input.push === true)
                args.push("--push");
            const cliPath = resolve(packageRoot, "bin", "aria.mjs");
            if (!isAbsolute(packageRoot) || !isAbsolute(cliPath))
                return { content: "ARIA CLI path is not absolute", metadata: { title: "Error" } };
            try {
                const output = execFileSync(process.execPath, [cliPath, ...args], {
                    cwd: projectDirectory,
                    env: sanitizedGitEnv(),
                    encoding: "utf8",
                    timeout: 180_000,
                    maxBuffer: 2_000_000,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                return { content: output.trim() || "aria ship completed", metadata: { title: "Ship project files" } };
            }
            catch (error) {
                const failure = error;
                const output = [failure.stdout?.toString(), failure.stderr?.toString()].filter(Boolean).join("\n").trim();
                return { content: output || "aria ship failed; inspect the project Git state before retrying", metadata: { title: "Error" } };
            }
        },
    };
}
//# sourceMappingURL=ship.js.map