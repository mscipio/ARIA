import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { resolveGitProjectDirectory, sanitizedGitEnv } from "./git-tool.js";
export const RELEASE_TOOL_NAME = "aria_release";
const MODES = ["--check", "--full-check", "--publish"];
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function isPrerelease(version) { return (version.split("+", 1)[0] ?? version).includes("-"); }
export const releaseToolInputSchema = {
    type: "object",
    properties: {
        version: { type: "string", minLength: 1, maxLength: 128 },
        mode: { type: "string", enum: ["check", "full-check", "publish"] },
        tag: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["version", "mode"],
    additionalProperties: false,
};
function fail(message) {
    return { code: 1, output: `aria release: ${message}` };
}
function parseArgs(args) {
    const version = args[0];
    if (!version || !VERSION_PATTERN.test(version))
        throw new Error("usage: aria release VERSION --check|--full-check|--publish [--tag TAG]");
    let mode;
    let tag;
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--tag") {
            if (tag !== undefined)
                throw new Error("Option --tag may be specified only once");
            tag = args[index + 1];
            if (!tag || tag.startsWith("--"))
                throw new Error("Option --tag requires a value");
            index += 1;
            continue;
        }
        if (MODES.includes(arg)) {
            if (mode !== undefined)
                throw new Error("Specify exactly one of --check, --full-check, or --publish");
            mode = arg;
            continue;
        }
        throw new Error(`Unknown release option: ${arg}`);
    }
    if (!mode)
        throw new Error("Specify exactly one of --check, --full-check, or --publish");
    if (tag && (tag.length > 256 || tag.startsWith("-") || [...tag].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
    })))
        throw new Error("--tag must be a valid single Git tag name");
    return { version, mode, ...(tag ? { tag } : {}) };
}
function git(root, args) {
    return execFileSync("git", [
        "--literal-pathspecs", "-C", root,
        "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "color.ui=false", "--no-pager",
        ...args,
    ], { cwd: root, env: sanitizedGitEnv(), encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"] });
}
function optionalGit(root, args) {
    try {
        return git(root, args);
    }
    catch (error) {
        const status = error && typeof error === "object" ? error.status : undefined;
        if (status === 1)
            return undefined;
        throw new Error("Git query failed; check repository state and configuration");
    }
}
function configValues(root, key) {
    return (optionalGit(root, ["config", "--local", "--null", "--get-all", key]) ?? "").split("\0").filter(Boolean);
}
function resolveTag(root, version, explicit) {
    let tag = explicit;
    if (!tag) {
        const template = configValues(root, "aria.releaseTagTemplate");
        if (template.length > 1)
            throw new Error("aria.releaseTagTemplate has multiple values; specify --tag");
        if (template.length === 1) {
            if (!template[0]?.includes("{version}") || template[0].indexOf("{version}") !== template[0].lastIndexOf("{version}")) {
                throw new Error("aria.releaseTagTemplate must contain exactly one {version} placeholder");
            }
            tag = template[0].replace("{version}", version);
        }
        else {
            const tags = git(root, ["tag", "--list"]).split(/\r?\n/).filter((item) => /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item));
            const prefixes = new Set(tags.map((item) => item.startsWith("v") ? "v" : ""));
            if (prefixes.size === 0 || prefixes.size > 1)
                throw new Error("Release tag convention is unknown or ambiguous; pass --tag TAG or set local aria.releaseTagTemplate");
            tag = `${[...prefixes][0]}${version}`;
        }
    }
    git(root, ["check-ref-format", `refs/tags/${tag}`]);
    return tag;
}
function projectVersion(root) {
    const candidates = [];
    const packagePath = join(root, "package.json");
    if (existsSync(packagePath)) {
        try {
            const value = JSON.parse(readFileSync(packagePath, "utf8"));
            if (typeof value.version === "string")
                candidates.push({ version: value.version, source: "package.json" });
        }
        catch {
            throw new Error("package.json exists but its version metadata is unreadable");
        }
    }
    for (const name of ["pyproject.toml", "Cargo.toml"]) {
        const file = join(root, name);
        if (!existsSync(file))
            continue;
        const source = readFileSync(file, "utf8");
        const sectionName = name === "pyproject.toml" ? "project" : "package";
        const section = new RegExp(`(?:^|\\n)\\[${sectionName}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`).exec(source)?.[1];
        if (section) {
            const matches = [...section.matchAll(/^\s*version\s*=\s*["']([^"']+)["']\s*$/gm)];
            if (matches.length === 1 && matches[0]?.[1])
                candidates.push({ version: matches[0][1], source: name });
            else if (matches.length > 1)
                return { ambiguous: true };
        }
    }
    const unique = new Map(candidates.map((item) => [item.version, item]));
    if (unique.size > 1)
        return { ambiguous: true };
    const first = candidates[0];
    return first ? first : {};
}
function githubRepoFromPushUrl(url) {
    let owner;
    let repo;
    const scp = /^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
    if (scp)
        [, owner, repo] = scp;
    else {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error("Configured push destination is not a supported GitHub URL");
        }
        if (parsed.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:", "git:"].includes(parsed.protocol)) {
            throw new Error("Configured push destination is not github.com");
        }
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length !== 2)
            throw new Error("Configured push destination is not one GitHub owner/repository");
        owner = decodeURIComponent(parts[0] ?? "");
        repo = decodeURIComponent(parts[1] ?? "").replace(/\.git$/, "");
    }
    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || owner === "." || repo === ".") {
        throw new Error("Configured push destination is not a valid GitHub owner/repository");
    }
    return { owner, repo };
}
function releaseDestination(root, branch) {
    const keys = [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`];
    let remote;
    for (const key of keys) {
        const values = configValues(root, key);
        if (values.length > 1)
            throw new Error(`Push destination is ambiguous (${key})`);
        if (values.length === 1) {
            remote = values[0];
            break;
        }
    }
    const remotes = git(root, ["remote"]).split(/\r?\n/).filter(Boolean);
    remote ??= remotes.length === 1 ? remotes[0] : undefined;
    if (!remote || !remotes.includes(remote))
        throw new Error("No unambiguous configured push remote for the current branch");
    const urls = git(root, ["remote", "get-url", "--push", "--all", remote]).split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || !urls[0] || urls[0].startsWith("-") || /^ext::/i.test(urls[0])) {
        throw new Error("The configured remote must have exactly one supported effective push URL");
    }
    if (configValues(root, `remote.${remote}.mirror`).some((value) => value.toLowerCase() === "true")
        || configValues(root, `remote.${remote}.push`).length > 0
        || configValues(root, "push.pushOption").length > 0
        || configValues(root, `remote.${remote}.pushOption`).length > 0) {
        throw new Error("Mirror, configured refspec, and push-option settings are refused for releases");
    }
    const symbolic = git(root, ["rev-parse", "--symbolic-full-name", "@{push}"]).trim();
    const prefix = `refs/remotes/${remote}/`;
    if (!symbolic.startsWith(prefix) || symbolic.length <= prefix.length)
        throw new Error("Current branch has no unambiguous configured push branch");
    const targetBranch = symbolic.slice(prefix.length);
    git(root, ["check-ref-format", `refs/heads/${targetBranch}`]);
    return { remote, pushUrl: urls[0], targetBranch, ...githubRepoFromPushUrl(urls[0]) };
}
function refRecord(output, ref) {
    const records = output.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
    const matches = records.filter((fields) => fields[1] === ref);
    if (matches.length > 1)
        throw new Error("Git remote returned an ambiguous ref listing");
    return matches[0]?.[0];
}
function remoteSha(pushUrl, ref) {
    try {
        return refRecord(execFileSync("git", ["ls-remote", pushUrl, ref], { encoding: "utf8", env: sanitizedGitEnv(), timeout: 120_000, maxBuffer: 100_000, stdio: ["ignore", "pipe", "pipe"] }), ref);
    }
    catch {
        throw new Error("Configured GitHub destination query failed; check network/authentication without changing release state");
    }
}
function runGh(args, cwd) {
    const result = spawnSync("gh", args, { cwd, env: { ...process.env, GH_HOST: "github.com" }, encoding: "utf8", timeout: 120_000, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error)
        throw new Error("GitHub CLI is unavailable; install/configure gh before release operations");
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function releaseState(context) {
    const result = runGh(["api", `repos/${context.owner}/${context.repo}/releases/tags/${encodeURIComponent(context.tag)}`], context.root);
    if (result.code !== 0) {
        // Only GitHub's explicit 404 means absent. Authentication and all other
        // query failures must not be mistaken for a new release.
        const detail = result.stderr;
        if (/\bHTTP 404\b|\bNot Found \(404\)/i.test(detail))
            return { exists: false };
        throw new Error("GitHub release-state query failed (not an authenticated, verified absence)");
    }
    try {
        const response = JSON.parse(result.stdout);
        if (response.tag_name !== context.tag || typeof response.html_url !== "string" || !isGithubReleaseUrl(response.html_url, context))
            throw new Error();
        return { exists: true, url: response.html_url, draft: response.draft === true, prerelease: response.prerelease === true };
    }
    catch {
        throw new Error("GitHub release-state response is malformed or names a different tag");
    }
}
function isGithubRepoUrl(value, owner, repo) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
            && url.username === "" && url.password === "" && url.port === ""
            && url.pathname.replace(/\/$/, "").toLowerCase() === `/${owner}/${repo}`.toLowerCase();
    }
    catch {
        return false;
    }
}
function isGithubReleaseUrl(value, context) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port)
            return false;
        const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
        return parts.length === 5 && parts[0]?.toLowerCase() === context.owner.toLowerCase()
            && parts[1]?.toLowerCase() === context.repo.toLowerCase() && parts[2] === "releases"
            && parts[3] === "tag" && parts[4] === context.tag;
    }
    catch {
        return false;
    }
}
function tagState(context) {
    const ref = `refs/tags/${context.tag}`;
    const object = remoteSha(context.pushUrl, ref);
    if (!object)
        return {};
    const peeled = remoteSha(context.pushUrl, `${ref}^{}`);
    return { object, commit: peeled ?? object };
}
function detectAriaProject(root) {
    const packageFile = join(root, "package.json");
    if (!existsSync(packageFile))
        return false;
    try {
        const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
        return pkg.name === "aria" && pkg.scripts?.["release:check"] === "node scripts/release-check.mjs";
    }
    catch {
        return false;
    }
}
function configuredCommands(root, key) {
    const commands = configValues(root, key);
    if (commands.some((command) => !command.trim() || command.length > 4096 || command.includes("\0"))) {
        throw new Error(`Project release command ${key} contains an invalid command`);
    }
    return commands;
}
function runConfiguredCommands(root, key, commands) {
    for (const [index, command] of commands.entries()) {
        // These commands are explicitly project-local Git config and trusted
        // project code; no command string is accepted from the native tool.
        const result = spawnSync(command, { cwd: root, env: process.env, shell: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 4_000_000 });
        if (result.error || result.status !== 0)
            throw new Error(`Configured project gate ${key} (${index + 1}/${commands.length}) failed (exit ${result.status ?? "unavailable"}); rerun that trusted project-local command directly for diagnostics before release`);
    }
}
function checkCleanHead(root) {
    const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    if (!branch)
        throw new Error("Release requires an attached branch");
    git(root, ["check-ref-format", "--branch", branch]);
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"]) {
        try {
            lstatSync(join(resolve(root, git(root, ["rev-parse", "--absolute-git-dir"]).trim()), marker));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            continue;
        }
        throw new Error(`Release is unavailable during Git operation state (${marker})`);
    }
    if (git(root, ["ls-files", "-u", "-z"]).length > 0)
        throw new Error("Release is unavailable with unresolved index conflicts");
    const scratchPath = join(root, "scratch");
    let canonicalScratch;
    try {
        if (lstatSync(scratchPath).isDirectory() && realpathSync(scratchPath) === resolve(scratchPath))
            canonicalScratch = scratchPath;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirty = status.split("\0").filter(Boolean).some((entry) => {
        if (!entry.startsWith("?? ") || !canonicalScratch)
            return true;
        const absolute = resolve(root, entry.slice(3));
        const rel = relative(canonicalScratch, absolute);
        return !rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(absolute) !== absolute;
    });
    if (dirty)
        throw new Error("Release requires a clean worktree and index; tracked changes are never exempt, and only untracked files under canonical scratch are ignored");
    const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    return { branch, head };
}
function buildContext(input, root) {
    const { branch, head } = checkCleanHead(root);
    const metadata = projectVersion(root);
    if (metadata.ambiguous)
        throw new Error("Project version metadata is ambiguous across recognized files");
    if (metadata.version && metadata.version !== input.version)
        throw new Error(`Requested version ${input.version} does not match ${metadata.source} version ${metadata.version}`);
    if (metadata.version && !VERSION_PATTERN.test(metadata.version))
        throw new Error(`${metadata.source} contains an unsupported version format`);
    const tag = resolveTag(root, input.version, input.tag);
    const destination = releaseDestination(root, branch);
    const repoResult = runGh(["repo", "view", `${destination.owner}/${destination.repo}`, "--json", "nameWithOwner,url"], root);
    if (repoResult.code !== 0)
        throw new Error("GitHub could not verify the configured destination (authentication, network, or repository access failed)");
    let repoData;
    try {
        repoData = JSON.parse(repoResult.stdout);
    }
    catch {
        throw new Error("GitHub destination query returned an invalid repository response");
    }
    if (typeof repoData.nameWithOwner !== "string" || repoData.nameWithOwner.toLowerCase() !== `${destination.owner}/${destination.repo}`.toLowerCase()
        || !isGithubRepoUrl(repoData.url, destination.owner, destination.repo)) {
        throw new Error("Configured push URL and verified GitHub repository identity do not match");
    }
    const localTagRefs = git(root, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/tags/${tag}`]).trim().split(/\r?\n/).filter(Boolean);
    const exactLocalRefs = localTagRefs.filter((record) => record.split(" ")[0] === `refs/tags/${tag}`);
    if (exactLocalRefs.length > 1)
        throw new Error(`Local tag lookup for ${tag} returned duplicate exact refs`);
    const localTagObject = exactLocalRefs[0]?.split(" ")[1];
    const localTagCommit = localTagObject ? git(root, ["rev-parse", "--verify", `${tag}^{commit}`]).trim() : undefined;
    if (localTagCommit && localTagCommit !== head)
        throw new Error(`Local tag ${tag} already points to a different commit; tags are immutable and will not be moved`);
    const context = { root, branch, head, version: input.version, tag, ...destination, ...(localTagObject ? { localTagObject, localTagCommit } : {}) };
    const remoteTag = tagState(context);
    if (remoteTag.commit && remoteTag.commit !== head)
        throw new Error(`Configured GitHub tag ${tag} already points to a different commit; tags are immutable and will not be replaced`);
    if (remoteTag.object && localTagObject && remoteTag.object !== localTagObject)
        throw new Error(`Configured GitHub tag ${tag} differs from the local immutable tag object`);
    const remoteBranchSha = remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`);
    // The --publish branch push below is non-force. Reject an obviously
    // divergent remote before running expensive gates or making a local tag.
    if (remoteBranchSha && remoteBranchSha !== head) {
        const ancestor = optionalGit(root, ["merge-base", "--is-ancestor", remoteBranchSha, head]);
        if (ancestor === undefined)
            throw new Error("Configured branch destination is ahead/divergent; reconcile it before publishing");
    }
    const knownRelease = releaseState(context);
    if (knownRelease.exists && !remoteTag.commit)
        throw new Error("GitHub reports a release but the configured destination has no matching tag ref; inspect release state manually");
    if (remoteTag.object && !localTagObject && !knownRelease.exists)
        throw new Error(`Configured GitHub tag ${tag} exists but no matching local tag object is available; do not recreate or replace it`);
    if (knownRelease.exists) {
        if (!knownRelease.url)
            throw new Error("GitHub release response omitted its verified URL");
        context.initialRelease = { url: knownRelease.url, draft: knownRelease.draft === true, prerelease: knownRelease.prerelease === true };
    }
    if (remoteTag.object)
        context.remoteTagObject = remoteTag.object;
    if (remoteTag.commit)
        context.remoteTagCommit = remoteTag.commit;
    if (remoteBranchSha)
        context.remoteBranchSha = remoteBranchSha;
    return context;
}
function runAriaGate(root, fast) {
    const args = fast ? ["run", "release:check", "--", "--fast"] : ["run", "release:check"];
    const result = spawnSync("npm", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 8_000_000 });
    if (result.error || result.status !== 0)
        throw new Error(`ARIA ${fast ? "fast" : "full"} release gate failed; inspect npm run release:check output and resolve it before continuing`);
}
function runReleaseGates(mode, context) {
    const aria = detectAriaProject(context.root);
    const check = configuredCommands(context.root, "aria.release.checkCommand");
    const full = configuredCommands(context.root, "aria.release.fullCheckCommand");
    const validated = [];
    const unavailable = [];
    if (aria) {
        runAriaGate(context.root, mode === "--check");
        validated.push(mode === "--check" ? "ARIA release gate stages 1-4" : "ARIA release gate stages 1-6");
    }
    else {
        if (check.length > 0) {
            runConfiguredCommands(context.root, "aria.release.checkCommand", check);
            validated.push("configured fast project checks");
        }
        else
            unavailable.push("project-specific fast checks (configure local aria.release.checkCommand)");
        if (mode !== "--check") {
            if (full.length === 0)
                throw new Error("No full project release gate is configured; set local aria.release.fullCheckCommand to a trusted repository validation command before --full-check or --publish");
            runConfiguredCommands(context.root, "aria.release.fullCheckCommand", full);
            validated.push("configured full project checks");
        }
    }
    return { validated, unavailable };
}
function localTagObject(context) {
    const rows = git(context.root, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/tags/${context.tag}`]).trim().split(/\r?\n/).filter(Boolean);
    const exact = rows.filter((row) => row.split(" ")[0] === `refs/tags/${context.tag}`);
    if (exact.length > 1)
        throw new Error("Local tag ref lookup was ambiguous");
    return exact[0]?.split(" ")[1];
}
function assertFrozenInputs(context) {
    const current = checkCleanHead(context.root);
    if (current.branch !== context.branch || current.head !== context.head)
        throw new Error("Branch or HEAD changed after project gates; no further release mutation attempted");
    const metadata = projectVersion(context.root);
    if (metadata.ambiguous || (metadata.version && metadata.version !== context.version))
        throw new Error("Project version metadata changed after project gates; no further release mutation attempted");
    const local = localTagObject(context);
    if (context.localTagObject ? local !== context.localTagObject : local !== undefined) {
        throw new Error("Local tag object changed or appeared after checks; immutable tag conflict, no further mutation attempted");
    }
    const remote = tagState(context);
    if (remote.object !== context.remoteTagObject || remote.commit !== context.remoteTagCommit) {
        throw new Error("Remote tag object/commit changed after project gates; immutable tag conflict, no further mutation attempted");
    }
    const release = releaseState(context);
    if (context.initialRelease) {
        if (!release.exists || release.url !== context.initialRelease.url || release.draft !== context.initialRelease.draft
            || release.prerelease !== context.initialRelease.prerelease) {
            throw new Error("The initially verified GitHub Release identity or publication state changed after project gates");
        }
    }
    else if (release.exists) {
        throw new Error("A GitHub Release appeared after project gates; inspect its identity and state before any mutation");
    }
    return release;
}
function createLocalTag(context) {
    if (context.localTagObject) {
        if (context.localTagCommit !== context.head)
            throw new Error("Existing local tag no longer matches the verified HEAD");
        return context.localTagObject;
    }
    if (localTagObject(context) !== undefined)
        throw new Error("Local tag appeared during release checks; refusing to replace it");
    git(context.root, ["tag", "--annotate", "--message", `Release ${context.version}`, context.tag, context.head]);
    const object = localTagObject(context);
    const commit = git(context.root, ["rev-parse", "--verify", `${context.tag}^{commit}`]).trim();
    if (!object || commit !== context.head)
        throw new Error("New local tag did not resolve to the verified HEAD; stop and inspect Git state");
    return object;
}
function runAriaPostTagVerifier(context) {
    if (!detectAriaProject(context.root))
        return;
    const script = join(context.root, "scripts", "verify-release-tag.mjs");
    const pkg = join(context.root, "package.json");
    if (!existsSync(script) || !existsSync(pkg))
        throw new Error("Verified ARIA project is missing its required post-tag verifier or package metadata; GitHub Release creation stopped");
    const spec = `github:${context.owner}/${context.repo}#${context.tag}`;
    const result = spawnSync(process.execPath, [script, context.tag, "--expect-sha", context.head, "--remote-url", context.pushUrl, "--spec", spec], {
        cwd: context.root, env: process.env, encoding: "utf8", timeout: 40 * 60 * 1000, maxBuffer: 8_000_000,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
        throw new Error(`ARIA post-tag verifier failed for ${context.tag} at ${context.head}; tag remains immutable and no GitHub Release was created. Inspect verifier output and destination state before recovery.`);
    }
}
function publish(context) {
    const existingRelease = assertFrozenInputs(context);
    if (existingRelease.exists) {
        if (existingRelease.draft)
            throw new Error("A draft GitHub release already exists for this tag; inspect it manually, no overwrite attempted");
        if (existingRelease.prerelease !== isPrerelease(context.version))
            throw new Error("Existing GitHub Release prerelease status does not match the requested version; no update attempted");
        return `Already published and verified: ${context.owner}/${context.repo} ${context.tag} at ${context.head} (${existingRelease.url})`;
    }
    const localObject = createLocalTag(context);
    const localCommit = git(context.root, ["rev-parse", "--verify", `${context.tag}^{commit}`]).trim();
    if (localCommit !== context.head)
        throw new Error("Frozen local tag no longer peels to the verified HEAD");
    // Recheck the complete frozen release identity immediately before the first
    // remote mutation. The newly-created local tag object is now the immutable
    // object we will push directly, never a mutable tag-name source ref.
    const prePush = tagState(context);
    if (prePush.object !== context.remoteTagObject || prePush.commit !== context.remoteTagCommit)
        throw new Error("Remote tag changed before publication; no push attempted");
    const branchBefore = remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`);
    if (branchBefore !== context.remoteBranchSha)
        throw new Error("Destination branch changed after checks; no push attempted");
    const releaseBefore = releaseState(context);
    if (releaseBefore.exists)
        throw new Error("A GitHub Release appeared after checks; no push attempted");
    const remoteBranch = remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`);
    if (remoteBranch !== context.head) {
        try {
            git(context.root, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", context.pushUrl, `${context.head}:refs/heads/${context.targetBranch}`]);
        }
        catch {
            throw new Error(`Local tag ${context.tag} was created, but branch push failed; inspect local/remote refs, then rerun only after confirming the same HEAD and tag`);
        }
        if (remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`) !== context.head)
            throw new Error("Branch push returned success but exact destination ref SHA did not verify; inspect before retrying");
    }
    if (localTagObject(context) !== localObject || git(context.root, ["rev-parse", "--verify", `${context.tag}^{commit}`]).trim() !== context.head) {
        throw new Error("Local immutable tag changed before tag publication; inspect refs and do not retry blindly");
    }
    const remoteTag = tagState(context);
    if (!remoteTag.object) {
        if (remoteTag.object !== context.remoteTagObject || localTagObject(context) !== localObject)
            throw new Error("Tag identity changed immediately before tag push");
        try {
            git(context.root, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", context.pushUrl, `${localObject}:refs/tags/${context.tag}`]);
        }
        catch {
            throw new Error(`Branch is verified, but tag push failed. Local tag ${context.tag} remains at ${context.head}; inspect the exact remote tag ref before retrying`);
        }
    }
    else if (remoteTag.object !== localObject || remoteTag.commit !== context.head) {
        throw new Error("Configured destination tag differs from the local immutable tag; no force or overwrite attempted");
    }
    const finalTag = tagState(context);
    if (finalTag.object !== localObject || finalTag.commit !== context.head)
        throw new Error("Tag push returned but exact remote tag object/commit did not verify; inspect before retrying");
    const branchAfter = remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`);
    if (branchAfter !== context.head)
        throw new Error("Branch ref changed during release publication; no GitHub Release creation attempted");
    runAriaPostTagVerifier(context);
    const postVerifierTag = tagState(context);
    if (localTagObject(context) !== localObject || postVerifierTag.object !== localObject || postVerifierTag.commit !== context.head
        || remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`) !== context.head) {
        throw new Error("Branch or immutable tag identity changed during post-tag verification; no GitHub Release creation attempted");
    }
    if (releaseState(context).exists)
        throw new Error("A GitHub Release appeared during post-tag verification; inspect before proceeding");
    const args = ["release", "create", context.tag, "--repo", `${context.owner}/${context.repo}`, "--verify-tag", "--title", context.tag, "--notes", `Release ${context.version}.`];
    if (isPrerelease(context.version))
        args.push("--prerelease");
    const created = runGh(args, context.root);
    if (created.code !== 0)
        throw new Error(`Tag ${context.tag} is verified at ${context.head}, but GitHub Release creation failed; query release/tag state before retrying`);
    const verified = releaseState(context);
    if (!verified.exists || verified.draft || !verified.url || verified.prerelease !== isPrerelease(context.version))
        throw new Error("GitHub Release command returned but exact published release state did not verify; inspect before retrying");
    const finalBranch = remoteSha(context.pushUrl, `refs/heads/${context.targetBranch}`);
    const finalTagState = tagState(context);
    if (finalBranch !== context.head || finalTagState.object !== localObject || finalTagState.commit !== context.head) {
        throw new Error(`GitHub Release exists (${verified.url}), but a destination ref changed during final verification; inspect manually and do not repeat publication blindly`);
    }
    return `Published and verified ${context.owner}/${context.repo} ${context.tag}: commit ${context.head}, branch ${context.targetBranch}, tag ${context.tag}, GitHub Release ${verified.url}`;
}
async function execute(input, invocationDirectory) {
    try {
        if (!invocationDirectory || !resolve(invocationDirectory))
            throw new Error("An OpenCode project directory is required");
        const { root } = resolveGitProjectDirectory(invocationDirectory);
        const context = buildContext(input, root);
        const gates = runReleaseGates(input.mode, context);
        if (input.mode === "--publish") {
            const result = publish(context);
            return { code: 0, output: `${result}. Validation: ${gates.validated.join(", ")}.` };
        }
        const noTagYet = context.localTagObject ? "existing local tag matches HEAD" : "tag not created";
        const pending = gates.unavailable.length ? `; unavailable: ${gates.unavailable.join(", ")}` : "";
        if (input.mode === "--full-check")
            return { code: 0, output: `Full release checks passed for ${context.version} (${context.tag}) at ${context.head}; validated ${gates.validated.join(", ")}; ${noTagYet}${pending}. No Git or GitHub publication mutation performed.` };
        return { code: 0, output: `Release preflight passed for ${context.version} (${context.tag}) at ${context.head}; validated ${gates.validated.join(", ") || "generic repository/version/destination checks only"}; ${noTagYet}${pending}. This is not a full release-readiness claim. No Git or GitHub publication mutation performed.` };
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : "Release operation failed");
    }
}
export async function runReleaseCli(args, invocationDirectory) {
    let input;
    try {
        input = parseArgs(args);
    }
    catch (error) {
        console.error(`aria release: ${error instanceof Error ? error.message : String(error)}\nUsage: aria release VERSION --check|--full-check|--publish [--tag TAG]`);
        return 1;
    }
    const result = await execute(input, invocationDirectory);
    (result.code === 0 ? console.log : console.error)(result.output);
    return result.code;
}
/** Registered native tool uses an absolute installed CLI and fixed command argv. */
export function createReleaseTool(packageRoot, projectDirectory) {
    return {
        name: RELEASE_TOOL_NAME,
        description: "Check or explicitly publish one release of the current OpenCode project. Coder-only, fixed CLI invocation; no arbitrary cwd, executable, shell, environment, argv, remote, or ref input. --publish is a release mutation and requires explicit human request.",
        input: releaseToolInputSchema,
        async execute(raw, context) {
            const caller = context && typeof context === "object" ? context : {};
            if (caller.agent !== "coder" || typeof caller.sessionID !== "string" || !caller.sessionID) {
                return { content: "aria_release is available only to an authorized Coder invocation with a sessionID", metadata: { title: "Error" } };
            }
            if (!projectDirectory || !/^(?:\/|[A-Za-z]:\\)/.test(projectDirectory))
                return { content: "aria_release requires an absolute OpenCode project location; no cwd fallback is used", metadata: { title: "Error" } };
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return { content: "version and mode are required", metadata: { title: "Error" } };
            const input = raw;
            if (Object.keys(input).some((key) => !["version", "mode", "tag"].includes(key))
                || typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)
                || typeof input.mode !== "string" || !["check", "full-check", "publish"].includes(input.mode)
                || (input.tag !== undefined && (typeof input.tag !== "string" || input.tag.length < 1 || input.tag.length > 256))) {
                return { content: "Invalid aria_release input; supply version, exactly one mode, and optional explicit tag", metadata: { title: "Error" } };
            }
            const mode = input.mode === "check" ? "--check" : input.mode === "full-check" ? "--full-check" : "--publish";
            const args = ["release", input.version, mode];
            if (typeof input.tag === "string")
                args.push("--tag", input.tag);
            const cliPath = resolve(packageRoot, "bin", "aria.mjs");
            if (!/^(?:\/|[A-Za-z]:\\)/.test(packageRoot) || !/^(?:\/|[A-Za-z]:\\)/.test(cliPath))
                return { content: "ARIA CLI path is not absolute", metadata: { title: "Error" } };
            try {
                const output = execFileSync(process.execPath, [cliPath, ...args], { cwd: projectDirectory, env: sanitizedGitEnv(), encoding: "utf8", timeout: 40 * 60 * 1000, maxBuffer: 8_000_000, stdio: ["ignore", "pipe", "pipe"] });
                return { content: output.trim() || "aria release completed", metadata: { title: "Release project" } };
            }
            catch (error) {
                const failure = error;
                const output = [failure.stdout?.toString(), failure.stderr?.toString()].filter(Boolean).join("\n").trim();
                return { content: output || "aria release failed; inspect repository and destination state before retrying", metadata: { title: "Error" } };
            }
        },
    };
}
//# sourceMappingURL=release.js.map