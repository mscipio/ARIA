import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPackageVersion, rollbackAgentInstall } from "./agents.js";
import { reconcileManagedCommands, rollbackCommandInstall } from "./commands.js";
import { codegraphUpgradeComponent } from "./codegraph.js";
import { context7UpgradeComponent, quotaLifecycleUpgradeComponent, } from "./dependencies.js";
import { defaultExecutor, depsSync, detectCodeGraph, detectContext7, detectEngram, detectEngramSource, detectMcpConnectivity, } from "./deps.js";
import { doctorExitCode, runDoctor } from "./doctor.js";
import { engramUpgradeComponent } from "./engram.js";
import { classifyAriaRegistration, parsePluginList } from "./lifecycle.js";
import { reconcileManagedAgents } from "./model-config.js";
import { openCodeGlobalDir } from "./paths.js";
import { resolveDurableAriaSkillsRoot } from "./skills.js";
import { checkQuotaUpgrade } from "./quota.js";
import { defaultGlobalConfigPath, ensureAriaSkillsRefreshFile } from "./setup-config.js";
import { zotpilotUpgradeComponent } from "./zotpilot.js";
// ---------------------------------------------------------------------------
// T010 — `aria upgrade` shared orchestration (single owner for upgrade
// inventory, approval gating, ARIA-target validation, bounded handoff, and
// before/after reporting).
//
// deps sync vs upgrade (the one definition; see `describeSyncVsUpgrade`):
// - `aria deps sync` normalizes the CURRENT installs (idempotent, no version
//   upgrades, no approval, Quota excluded). It is the same sync invoked by
//   `aria setup` and the post-update handoff.
// - `aria upgrade` is inventory → explicit approval → validate the ARIA
//   target BEFORE removal → T011 self-upgrade + bounded handoff → ONLY in
//   the new release: component upgrades → target-version-specific
//   normalization/registration → agent regen if required → deps sync →
//   doctor → before/after report.
//
// Handoff binds the exact validated target plus the approved component
// inventory. The new release continues without re-asking ONLY on an exact
// match; any target/scope drift stops for fresh approval. Pre-handoff
// failure leaves/restores the old registration where feasible or reports
// the exact unresolved state; post-handoff component failure stops with
// per-component completed/rolled-back/unresolved states and no global
// transactionality. After handoff the old code performs no further
// normalization, regen, sync, doctor, or reporting (recovery is limited to
// registration restoration plus failure reporting, owned by T011).
//
// Invariants: approval precedes ALL mutations; unknown ownership/version
// means no install; unrelated entries are preserved (adapters only touch
// their owned entries); everything is XDG-contained (explicit `configDir`
// seam, never hardcoded homes, no prod V1/session migration, no V1/0.6
// removal, no `.npmrc`); any git env (`PROCESS_LOCAL_GIT_ENV`) is spread
// per-call only, never assigned to `process.env`.
//
// Scope: T010 provides inventory/status/reporting plus handoff plumbing.
// The T011 self-upgrade adapter stays an injectable seam (fail-closed
// default); the T012/T013/T014 component upgrades plus the T017 Quota
// bootstrap and Context7 normalize run as REAL defaults post-handoff via the
// shared dependency lifecycle (`src/dependencies.js`) — this module never
// implements adapter internals, only wires them.
//
// T002 ownership: production `aria upgrade` (bin/aria.mjs) is ARIA-only and
// passes ARIA-only continuation components with no third-party sync, so no
// third-party upgrade/sync runs on the production upgrade path; version
// upgrades belong exclusively to `aria deps --upgrade` (T004).
// ---------------------------------------------------------------------------
/** Git remote ARIA releases are discovered from (read-only `ls-remote`). */
export const ARIA_GIT_REMOTE = "https://github.com/mscipio/ARIA.git";
/** Exact Git package spec prefix for ARIA releases (T011 validates identity). */
export const ARIA_GIT_SPEC_PREFIX = "github:mscipio/ARIA#";
/**
 * Git environment for any upgrade-owned subprocess. Spread per-call only
 * (e.g. `{ ...process.env, ...PROCESS_LOCAL_GIT_ENV }` at the spawn site);
 * never assign to `process.env` and never persist to any file.
 */
export const PROCESS_LOCAL_GIT_ENV = { NPM_CONFIG_ALLOW_GIT: "all" };
// ---------------------------------------------------------------------------
// T003 exact-package upgrade invocation (never bare `aria`).
//
// `bin/aria.mjs` dispatches `upgrade` by importing `../dist/upgrade.js` and
// `../dist/aria-upgrade.js` relative to its own location, so a bare
// `aria upgrade --yes` runs whatever `aria` resolves on PATH (for example
// the development checkout at 1.0.8) instead of the positively identified
// installed registration (for example `github:mscipio/ARIA#v1.0.7`). The
// executable form pins the package:
//
//   NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package <spec> -- aria upgrade --yes
//
// (`NPM_CONFIG_ALLOW_GIT=all npx --yes --package <spec> -- aria upgrade --yes` is equivalent.)
// The `NPM_CONFIG_ALLOW_GIT=all` prefix is the approved per-invocation process-local Git
// allowance (mirrors `PROCESS_LOCAL_GIT_ENV` spread per-call via the Executor `env` seam):
// it allows the one npm fetch of the exact Git spec without any global `npm config`,
// environment export, or `.npmrc` change (a bare `npm exec ...` without it fails with
// EALLOWGIT on Git specs). The
// `--` boundary keeps the `aria ...` argv from being parsed as npm
// options; `--package <spec>` selects the exact Git spec (never a local
// path, never a bare name). These builders are pure: they format argv and
// display strings only and never touch an executor, config, or the
// network. No launcher is needed: npm resolves the `aria` binary from the
// named package, and the dispatched release is that package's own code.
//
// T009 installed identity: the `<spec>` above is the positively identified
// OpenCode plugin registration (approved Git source plus exact release
// tag, resolved read-only by `checkUpgradeInventory` via `opencode plugin
// list`), never the running CLI package version. The CLI version only
// selects the code that executes inventory; it is reported separately
// (`cliVersion`) and never used for guidance or version comparison, so a
// dev CLI (for example 1.0.8) cannot steer guidance at an installed
// registration (for example v1.0.7) nor falsely report it already current.
// ---------------------------------------------------------------------------
/**
 * Derive the installed Git spec for guidance from a positively identified
 * bare `X.Y.Z` version (e.g. `1.0.6` → `github:mscipio/ARIA#v1.0.6`).
 * Anything else (null, dev/inexact versions) yields null and guidance
 * fails closed without guessing.
 */
export function installedSpecForGuidance(currentVersion) {
    if (currentVersion === null)
        return null;
    if (!/^\d+\.\d+\.\d+$/.test(currentVersion))
        return null;
    return `${ARIA_GIT_SPEC_PREFIX}v${currentVersion}`;
}
/**
 * Pure npm argv for an approval run against the installed release:
 * `exec --yes --package <spec> -- aria upgrade --yes`. The caller
 * prefixes `npm` (or `npx`) and the approved per-invocation
 * `NPM_CONFIG_ALLOW_GIT=all` env (see `PROCESS_LOCAL_GIT_ENV`, spread
 * per-call via the Executor `env` seam, never global/`.npmrc`); the `--`
 * boundary and `--package` position
 * are part of the contract verified by regression tests.
 */
export function buildExactUpgradeApprovalArgv(installedSpec) {
    return ["exec", "--yes", "--package", installedSpec, "--", "aria", "upgrade", "--yes"];
}
/** Display form of the exact-package approval invocation (pure). Includes the approved
 * per-invocation `NPM_CONFIG_ALLOW_GIT=all` prefix so the displayed command fetches the
 * exact Git spec without any global npm config or `.npmrc` change. */
export function formatExactUpgradeApprovalCommand(installedSpec) {
    return `NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${installedSpec} -- aria upgrade --yes`;
}
/**
 * Approval guidance line for `formatUpgradeCheck` / `runUpgrade`
 * blocked-approval (pure, no mutation). Names the exact installed package
 * when it is positively identified; otherwise fails closed with no bare
 * invocation offered.
 */
export function formatApprovalGuidance(currentVersion, targetSpec) {
    const installedSpec = installedSpecForGuidance(currentVersion);
    if (installedSpec === null) {
        return `Self-upgrade approval is withheld: the installed release is not positively identified as an exact version, so no exact-package invocation can be offered for ${targetSpec}. Establish identity, then re-run with fresh approval. No changes were made.`;
    }
    return `Self-upgrade: available — run \`${formatExactUpgradeApprovalCommand(installedSpec)}\` to approve the inventoried target (${targetSpec}) and component scope`;
}
/**
 * Blocked-approval detail for `runUpgrade` when `--yes` was not given
 * (pure, no mutation). Same exact-package rule as `formatApprovalGuidance`.
 */
export function formatBlockedApprovalDetail(currentVersion, targetSpec) {
    const installedSpec = installedSpecForGuidance(currentVersion);
    if (installedSpec === null || targetSpec === null) {
        return "Explicit approval is required before any mutation. The installed release or available target is not positively identified, so no exact-package invocation can be offered. Establish identity, then re-run with fresh approval. No changes were made.";
    }
    return `Explicit approval is required before any mutation. Re-run with \`${formatExactUpgradeApprovalCommand(installedSpec)}\` to approve the inventoried target (${targetSpec}) and component scope. No changes were made.`;
}
/** Component inventory scope bound by `--check`, approval, and handoff. */
export const UPGRADE_COMPONENTS = ["aria", "engram", "context7", "codegraph", "zotpilot", "quota"];
// ---------------------------------------------------------------------------
// Current + available ARIA release discovery (read-only)
// ---------------------------------------------------------------------------
/** Installed ARIA version, or null when it cannot be positively read. */
export function readCurrentAriaVersion() {
    try {
        return readPackageVersion();
    }
    catch {
        return null;
    }
}
/** Installed identity from an explicit pin (test/operator override; trusted as stated). */
function installedIdentityFromPin(pin) {
    if (pin === null) {
        return { version: null, spec: null, note: "installed ARIA version is not positively identified (pinned unknown)" };
    }
    const spec = installedSpecForGuidance(pin);
    if (spec === null) {
        return {
            version: pin,
            spec: null,
            note: `installed version ${pin} is not an exact release identity, so no exact-package invocation can be offered`,
        };
    }
    return { version: pin, spec, note: `installed ${pin} (${spec})` };
}
/**
 * Read-only installed-identity probe (`opencode plugin list`; never
 * mutates). Exactly one ARIA-identifying row (shared T012 rule in
 * `src/lifecycle.ts`, never deduplicated before the uniqueness decision)
 * with an exact `vX.Y.Z` tag identifies; zero registrations, multiple
 * rows (including duplicate identical specs), a foreign
 * (non-approved-source) `aria` id, or an inexact ref fails closed with
 * zero version evidence. Mirrors the source rule in
 * `src/aria-upgrade.ts` (`isAriaGitTarget`) without importing it (that
 * module imports this one).
 */
async function detectInstalledAriaIdentity(executor) {
    let stdout;
    try {
        stdout = (await executor("opencode", ["plugin", "list"])).stdout;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            version: null,
            spec: null,
            note: `installed ARIA registration unknown (opencode plugin list failed: ${reason}); not guessed`,
        };
    }
    const { recognized, entries } = parsePluginList(stdout);
    if (!recognized) {
        return {
            version: null,
            spec: null,
            note: "installed ARIA registration unknown (unrecognized plugin list output); not guessed",
        };
    }
    // T013: row-level uniqueness via the shared T012 rule — identical specs
    // still count as multiple registrations (never deduplicated before the
    // uniqueness decision). Exactly one identifying row may proceed.
    const registration = classifyAriaRegistration(entries);
    if (registration.kind === "ambiguous") {
        const observed = registration.identifying.map((entry) => `${entry.id} ${entry.target}`).join(", ");
        return {
            version: null,
            spec: null,
            note: `installed ARIA registration ambiguous (multiple registrations: ${observed}); refusing to guess`,
        };
    }
    const approved = [...new Set(entries.filter((entry) => entry.target.startsWith(ARIA_GIT_SPEC_PREFIX)).map((entry) => entry.target))];
    const foreign = entries.filter((entry) => entry.id === "aria" && !entry.target.startsWith(ARIA_GIT_SPEC_PREFIX));
    if (approved.length > 1) {
        return {
            version: null,
            spec: null,
            note: `installed ARIA registration ambiguous (multiple distinct registrations: ${approved.join(", ")}); refusing to guess`,
        };
    }
    if (foreign.length > 0 && approved.length === 0) {
        return {
            version: null,
            spec: null,
            note: `installed ARIA registration is from an unapproved source (${foreign.map((entry) => entry.target).join(", ")}); ownership unsupported, leaving untouched`,
        };
    }
    if (foreign.length > 0) {
        return {
            version: null,
            spec: null,
            note: `installed ARIA registration conflicting (approved ${approved[0]} plus unapproved ${foreign.map((entry) => entry.target).join(", ")}); refusing to guess`,
        };
    }
    if (approved.length === 0) {
        return {
            version: null,
            spec: null,
            note: "installed ARIA registration is definitely absent (no approved ARIA Git registration in the recognized plugin list)",
        };
    }
    const spec = approved[0];
    const ref = spec.slice(spec.lastIndexOf("#") + 1);
    if (isExactAriaReleaseTag(ref)) {
        return { version: ref.slice(1), spec, note: `installed ${ref.slice(1)} (${spec}) via opencode plugin list` };
    }
    if (isExactCommitRef(ref)) {
        const resolved = await discoverAriaTargetByExactSpec(spec, executor);
        if (resolved.kind === "known") {
            return { version: resolved.target.version, spec, note: `installed ${resolved.target.version} (${spec}; ${resolved.target.tag}) via opencode plugin list and git ls-remote` };
        }
    }
    {
        return {
            version: null,
            spec: null,
            note: `installed ARIA ref is not an exact release identity (${spec}); refusing to guess`,
        };
    }
}
const EXACT_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const EXACT_PRERELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-rc\.(0|[1-9]\d*)$/;
const EXACT_COMMIT_RE = /^[0-9a-f]{40}$/i;
/**
 * Exact `vX.Y.Z` release-tag predicate. Single source of truth shared by
 * release discovery/validation (T010) and the self-upgrade adapter (T011);
 * never duplicated.
 */
export function isExactReleaseTag(tag) {
    return EXACT_TAG_RE.test(tag);
}
/** Exact ARIA prerelease tag supported for explicit immutable migration targets. */
export function isExactPrereleaseTag(tag) {
    return EXACT_PRERELEASE_TAG_RE.test(tag);
}
/** Exact stable or supported rc release tag; stable discovery remains stable-only. */
export function isExactAriaReleaseTag(tag) {
    return isExactReleaseTag(tag) || isExactPrereleaseTag(tag);
}
/** Full commit IDs only; branches, tag aliases, and abbreviated hashes are not immutable targets. */
export function isExactCommitRef(ref) {
    return EXACT_COMMIT_RE.test(ref);
}
export function compareAriaVersions(a, b) {
    const [leftCore, leftPrerelease] = a.split("-", 2);
    const [rightCore, rightPrerelease] = b.split("-", 2);
    const left = (leftCore ?? "").split(".").map((chunk) => Number.parseInt(chunk, 10));
    const right = (rightCore ?? "").split(".").map((chunk) => Number.parseInt(chunk, 10));
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0)
            return diff;
    }
    if (leftPrerelease === undefined)
        return rightPrerelease === undefined ? 0 : 1;
    if (rightPrerelease === undefined)
        return -1;
    const leftNumber = Number.parseInt(leftPrerelease.replace(/^rc\./, ""), 10);
    const rightNumber = Number.parseInt(rightPrerelease.replace(/^rc\./, ""), 10);
    const labelDiff = leftPrerelease.startsWith("rc.") === rightPrerelease.startsWith("rc.") ? 0 : leftPrerelease.startsWith("rc.") ? 1 : -1;
    if (labelDiff !== 0)
        return labelDiff;
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
        return leftNumber - rightNumber;
    return leftPrerelease.localeCompare(rightPrerelease);
}
function exactReleaseTagsFromRemote(lsRemoteOutput) {
    const refs = new Map();
    for (const line of lsRemoteOutput.split("\n")) {
        const [hash, ref] = line.trim().split(/\s+/, 2);
        if (!hash || !ref || !ref.startsWith("refs/tags/"))
            continue;
        const peeled = ref.endsWith("^{}");
        const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
        if (!isExactAriaReleaseTag(tag))
            continue;
        const current = refs.get(tag) ?? { object: null, peeled: null, invalid: false };
        if (!isExactCommitRef(hash))
            current.invalid = true;
        else if (peeled) {
            if (current.peeled !== null && current.peeled !== hash.toLowerCase())
                current.invalid = true;
            current.peeled = hash.toLowerCase();
        }
        else {
            if (current.object !== null && current.object !== hash.toLowerCase())
                current.invalid = true;
            current.object = hash.toLowerCase();
        }
        refs.set(tag, current);
    }
    const tags = [];
    for (const [tag, record] of refs) {
        const commit = record.peeled ?? record.object;
        if (!record.invalid && commit !== null)
            tags.push({ tag, commit });
    }
    return tags;
}
/** Resolve an exact immutable ARIA commit spec to its unique exact release tag. */
export async function discoverAriaTargetByExactSpec(spec, executor = defaultExecutor, prereleaseOnly = false) {
    if (!spec.startsWith(ARIA_GIT_SPEC_PREFIX) || !isExactCommitRef(spec.slice(ARIA_GIT_SPEC_PREFIX.length))) {
        return { kind: "unknown", reason: `target ${spec} is not an exact immutable ARIA commit spec` };
    }
    if (spec.slice(ARIA_GIT_SPEC_PREFIX.length) !== spec.slice(ARIA_GIT_SPEC_PREFIX.length).toLowerCase()) {
        return { kind: "unknown", reason: `target ${spec} is not a canonical lowercase immutable ARIA commit spec` };
    }
    let stdout;
    try {
        stdout = (await executor("git", ["ls-remote", "--tags", ARIA_GIT_REMOTE])).stdout;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "unknown", reason: `cannot verify exact ARIA commit target (${reason})` };
    }
    const commit = spec.slice(ARIA_GIT_SPEC_PREFIX.length).toLowerCase();
    const matches = exactReleaseTagsFromRemote(stdout).filter((entry) => entry.commit === commit);
    if (matches.length !== 1) {
        return {
            kind: "unknown",
            reason: matches.length === 0
                ? `exact ARIA commit ${commit} does not match a current exact release tag`
                : `exact ARIA commit ${commit} matches multiple release tags; refusing ambiguous target`,
        };
    }
    const match = matches[0];
    if (prereleaseOnly && !isExactPrereleaseTag(match.tag)) {
        return { kind: "unknown", reason: `explicit target ${spec} is not an exact ARIA rc prerelease tag` };
    }
    return { kind: "known", target: { tag: match.tag, version: match.tag.slice(1), spec } };
}
/** Resolve a version tag to the immutable commit spec used for npm installation. */
export async function discoverAriaTargetByExactTag(tag, executor = defaultExecutor) {
    if (!isExactAriaReleaseTag(tag)) {
        return { kind: "unknown", reason: `${tag} is not an exact ARIA stable or rc release tag` };
    }
    let stdout;
    try {
        const ref = `refs/tags/${tag}`;
        stdout = (await executor("git", ["ls-remote", "--tags", ARIA_GIT_REMOTE, ref, ref.concat("^{}")])).stdout;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "unknown", reason: `cannot verify ARIA release tag ${tag} (${reason})` };
    }
    const matches = exactReleaseTagsFromRemote(stdout).filter((entry) => entry.tag === tag);
    if (matches.length !== 1) {
        return { kind: "unknown", reason: `ARIA release tag ${tag} did not resolve to one exact commit` };
    }
    const match = matches[0];
    return { kind: "known", target: { tag, version: tag.slice(1), spec: `${ARIA_GIT_SPEC_PREFIX}${match.commit}` } };
}
/** Re-checks the tag/commit binding for immutable target specs immediately before mutation. */
export async function verifyAriaTargetIdentity(target, executor = defaultExecutor) {
    const structural = validateAriaTargetForRemoval(target);
    if (!structural.ok)
        return structural;
    const ref = target.spec.slice(ARIA_GIT_SPEC_PREFIX.length);
    if (!isExactCommitRef(ref))
        return { ok: true };
    const resolved = await discoverAriaTargetByExactTag(target.tag, executor);
    if (resolved.kind !== "known" || resolved.target.version !== target.version || resolved.target.spec !== target.spec) {
        return { ok: false, reason: `target tag/commit mismatch for ${target.tag} and ${target.spec}; refusing to mutate` };
    }
    return { ok: true };
}
function compareSemver(a, b) {
    return compareAriaVersions(a, b);
}
/**
 * Parse read-only `git ls-remote` output into the newest exact `vX.Y.Z`
 * release tag. Dereferenced `^{[1]}` lines, non-tag refs, and non-exact
 * tags (prereleases, moving tags) never identify a target. Returns null
 * when no exact release tag is observed (never guessed).
 *
 * [1]: `^{}` suffix lines repeat the tag's object; the suffix is stripped
 * before matching, so annotated and lightweight tags behave identically.
 */
export function parseAriaRemoteRefs(lsRemoteOutput) {
    let best = null;
    for (const line of lsRemoteOutput.split("\n")) {
        const ref = line.trim().split(/\s+/)[1];
        if (!ref || !ref.startsWith("refs/tags/"))
            continue;
        const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
        if (!isExactReleaseTag(tag))
            continue;
        const version = tag.slice(1);
        if (best === null || compareSemver(version, best) > 0)
            best = version;
    }
    if (best === null)
        return null;
    return { tag: `v${best}`, version: best, spec: `${ARIA_GIT_SPEC_PREFIX}v${best}` };
}
/** Read-only available-release probe (`git ls-remote`; never mutates). */
export async function discoverAvailableAriaTarget(executor = defaultExecutor) {
    let stdout;
    try {
        const result = await executor("git", ["ls-remote", ARIA_GIT_REMOTE]);
        stdout = result.stdout;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "unknown", reason: `available ARIA release is unknown (git ls-remote failed: ${reason})` };
    }
    const target = parseAriaRemoteRefs(stdout);
    if (!target) {
        return { kind: "unknown", reason: "available ARIA release is unknown (no exact vX.Y.Z release tag observed)" };
    }
    return { kind: "known", target };
}
/**
 * Pre-removal gate: the requested target must be positively identified and
 * exactly shaped BEFORE the current registration is touched. Unknown or
 * misshapen targets fail closed with zero mutation.
 */
export function validateAriaTargetForRemoval(target) {
    if (!target) {
        return { ok: false, reason: "ARIA available target is unknown; self-upgrade blocked with zero mutation" };
    }
    const ref = target.spec.startsWith(ARIA_GIT_SPEC_PREFIX) ? target.spec.slice(ARIA_GIT_SPEC_PREFIX.length) : "";
    const exactIdentity = isExactAriaReleaseTag(target.tag) &&
        target.version === target.tag.slice(1) &&
        (ref === target.tag || isExactCommitRef(ref));
    if (!exactIdentity) {
        return { ok: false, reason: `ARIA target is not an exact release identity (${target.spec}); refusing to remove the current registration` };
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Read-only component inventory (`--check` never mutates)
// ---------------------------------------------------------------------------
function ariaRow(installed, available) {
    // T009: comparison requires approved-source version evidence on BOTH
    // sides. A registration without a positively identified spec (foreign
    // source, ambiguous, absent, unknown) never compares — even an
    // equal tag from a foreign source stays unknown-target, never current.
    const current = installed.version !== null && installed.spec !== null ? installed.version : null;
    if (current === null || available.kind === "unknown") {
        const reason = current === null
            ? installed.note
            : available.kind === "unknown"
                ? available.reason
                : installed.note;
        return {
            component: "aria",
            installed: current,
            available: null,
            status: "unknown-target",
            detail: `${reason}; self-upgrade blocked with zero mutation`,
        };
    }
    if (current === available.target.version) {
        return {
            component: "aria",
            installed: current,
            available: available.target.tag,
            status: "current",
            detail: `installed ${current} equals available ${available.target.tag}; nothing to upgrade`,
        };
    }
    if (compareSemver(available.target.version, current) > 0) {
        return {
            component: "aria",
            installed: current,
            available: available.target.tag,
            status: "upgrade-available",
            detail: `available ${available.target.tag} (${available.target.spec}) supersedes installed ${current}`,
        };
    }
    return {
        component: "aria",
        installed: current,
        available: available.target.tag,
        status: "current",
        detail: `installed ${current} is ahead of latest known tag ${available.target.tag}; nothing to upgrade`,
    };
}
function dualConfigAmbiguous(configDir) {
    const base = openCodeGlobalDir(configDir);
    const jsonPath = join(base, "opencode.json");
    const jsoncPath = join(base, "opencode.jsonc");
    return { ambiguous: existsSync(jsonPath) && existsSync(jsoncPath), jsonPath, jsoncPath };
}
/**
 * Strictly read-only inventory: current AND available ARIA releases plus
 * one row per component. Probes are `git ls-remote`, `opencode plugin
 * list`, `opencode mcp list`, `engram version`, `codegraph --version`,
 * and XDG-contained config file reads — no installer, updater, writer,
 * or mutating CLI is ever invoked here.
 */
export async function checkUpgradeInventory(executor = defaultExecutor, options = {}) {
    // T009: the installed version/spec derive from the positively identified
    // plugin registration (or an explicit pin), never from the running CLI
    // package. The CLI version is reporting-only and never compared.
    const cliVersion = options.cliVersion !== undefined ? options.cliVersion : readCurrentAriaVersion();
    const installed = options.currentVersion !== undefined
        ? installedIdentityFromPin(options.currentVersion)
        : await detectInstalledAriaIdentity(executor);
    const currentVersion = installed.version;
    const installedSpec = installed.spec;
    const available = options.availableOverride !== undefined
        ? options.availableOverride === null
            ? { kind: "unknown", reason: "available ARIA release pinned unknown" }
            : { kind: "known", target: options.availableOverride }
        : await discoverAvailableAriaTarget(executor);
    const components = [ariaRow(installed, available)];
    // Engram: installed version observed read-only; version currency is
    // established post-handoff by the T012 adapter, not by this check
    // (deps sync only normalizes the current install).
    const engram = await detectEngram(executor);
    if (!engram.found) {
        components.push({ component: "engram", installed: null, available: null, status: "skipped", detail: "no Engram installation observed; nothing to upgrade" });
    }
    else if (!engram.version) {
        components.push({ component: "engram", installed: null, available: null, status: "unknown-target", detail: "Engram is installed but its version is not positively identified; no version action without fresh evidence" });
    }
    else {
        const mcp = await detectMcpConnectivity(executor);
        const link = mcp.listFailed ? "MCP connectivity unknown" : mcp.engram ? "MCP connected" : "MCP not connected";
        components.push({
            component: "engram",
            installed: engram.version,
            available: null,
            status: "unmanaged-observed",
            detail: `Engram ${engram.version} observed (${link}); version action owned by the post-handoff T012 adapter`,
        });
    }
    // Context7: remote-only endpoint (no local package, no version upgrade).
    const dual = dualConfigAmbiguous(options.configDir);
    if (dual.ambiguous) {
        components.push({
            component: "context7",
            installed: null,
            available: null,
            status: "unknown-target",
            detail: `global ${dual.jsonPath} and ${dual.jsoncPath} both exist; dual-file ambiguity fails closed with neither file mutated`,
        });
    }
    else {
        const context7 = await detectContext7(executor, options.configDir);
        if (!context7.configured) {
            components.push({ component: "context7", installed: null, available: null, status: "skipped", detail: "Context7 remote endpoint not configured; nothing to upgrade" });
        }
        else {
            const mcp = await detectMcpConnectivity(executor);
            if (mcp.listFailed) {
                components.push({ component: "context7", installed: "remote", available: null, status: "unknown-target", detail: "Context7 is configured but live MCP health is not established; no action without fresh evidence" });
            }
            else if (mcp.context7) {
                components.push({ component: "context7", installed: "remote", available: null, status: "remote-healthy", detail: "Context7 remote endpoint configured and connected; no version upgrade exists" });
            }
            else {
                components.push({ component: "context7", installed: "remote", available: null, status: "unknown-target", detail: "Context7 is configured but not connected; normalization runs post-handoff, never on guess" });
            }
        }
    }
    // CodeGraph: T006 evidence gate — non-managed, observed only.
    const codegraph = await detectCodeGraph(executor);
    if (!codegraph.found) {
        components.push({ component: "codegraph", installed: null, available: null, status: "skipped", detail: "no CodeGraph installation observed; nothing to upgrade" });
    }
    else if (!codegraph.version) {
        components.push({ component: "codegraph", installed: null, available: null, status: "unknown-target", detail: "CodeGraph is installed but its version is not positively identified; report-only with zero mutation" });
    }
    else {
        components.push({
            component: "codegraph",
            installed: codegraph.version,
            available: null,
            status: "unmanaged-observed",
            detail: `CodeGraph ${codegraph.version} observed and non-managed (T006: no safe V2/XDG-aware path demonstrated); report-only`,
        });
    }
    // ZotPilot: T006 evidence gate — detection only via `opencode mcp list`.
    const zotMcp = await detectMcpConnectivity(executor);
    if (zotMcp.listFailed && !zotMcp.zotpilot) {
        components.push({ component: "zotpilot", installed: null, available: null, status: "unknown-target", detail: "MCP inventory unavailable; ZotPilot presence not positively identified, report-only" });
    }
    else if (!zotMcp.zotpilot) {
        components.push({ component: "zotpilot", installed: null, available: null, status: "skipped", detail: "no ZotPilot MCP server listed; nothing to upgrade" });
    }
    else {
        components.push({
            component: "zotpilot",
            installed: "mcp-listed",
            available: null,
            status: "unmanaged-observed",
            detail: `ZotPilot MCP server listed (${zotMcp.zotpilot.connected ? "connected" : "not connected"}); non-managed (T006 shared-env ownership), report-only`,
        });
    }
    // Quota: delegate to the T007 read-only inventory (status vocabulary shared).
    const quota = await checkQuotaUpgrade(executor, options.configDir);
    components.push({
        component: "quota",
        installed: quota.installedVersion,
        available: null,
        status: quota.status,
        detail: quota.detail,
    });
    // T009: unknown installed spec blocks self-upgrade with zero mutation —
    // guidance cannot name an exact package without a positively identified
    // registration, even when a bare installed version string is present.
    const selfUpgradeBlocked = available.kind === "unknown" || currentVersion === null || installedSpec === null;
    const blockReason = currentVersion === null || installedSpec === null
        ? installed.note
        : available.kind === "unknown"
            ? available.reason
            : null;
    return { currentVersion, cliVersion, installedSpec, available, selfUpgradeBlocked, blockReason, components };
}
// ---------------------------------------------------------------------------
// Reporting (plain text, no ANSI — same convention as doctor)
// ---------------------------------------------------------------------------
function padCells(cells, widths) {
    return cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
}
export function formatUpgradeCheck(result) {
    const lines = ["ARIA upgrade check", ""];
    lines.push(`Current release: ${result.currentVersion ?? "unknown"}${result.installedSpec ? ` (${result.installedSpec})` : ""}`);
    // T009: the running CLI is reported separately and never used for
    // guidance or comparison (legacy results without `cliVersion` report it
    // as unknown rather than guessing).
    lines.push(`Running CLI: ${result.cliVersion ?? "unknown"} (reporting only; guidance names the registered installation)`);
    lines.push(result.available.kind === "known"
        ? `Available release: ${result.available.target.tag} (${result.available.target.spec})`
        : "Available release: unknown");
    if (result.selfUpgradeBlocked) {
        lines.push(`Self-upgrade: BLOCKED — ${result.blockReason ?? "target not positively identified"}`);
    }
    else if (result.available.kind === "known" &&
        result.currentVersion === result.available.target.version &&
        result.cliVersion === result.available.target.version) {
        // R006: already current only when BOTH the installed registration AND
        // the running CLI are at the target. A stale CLI still needs the
        // bounded exact-target CLI update, so it reports as available.
        lines.push("Self-upgrade: already current");
    }
    else if (result.available.kind === "known") {
        lines.push(formatApprovalGuidance(result.currentVersion, result.available.target.spec));
    }
    else {
        lines.push(formatApprovalGuidance(result.currentVersion, "unknown target"));
    }
    lines.push("");
    const header = ["Component", "Installed", "Available", "Status"];
    const rows = result.components.map((row) => [row.component, row.installed ?? "-", row.available ?? "-", row.status]);
    const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
    lines.push(padCells(header, widths));
    for (const row of rows)
        lines.push(padCells(row, widths));
    lines.push("");
    lines.push("Details:");
    for (const row of result.components)
        lines.push(`  ${row.component}: ${row.detail}`);
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// T004 — `aria deps --upgrade` proposal reporting (pure, read-only).
//
// Renders the non-ARIA inventory rows as an upgrade proposal: rows whose
// status shows adapter-owned currency (`unmanaged-observed`) are proposed
// for re-evaluation by the owning adapter on explicit approval; every other
// row states why it will see no action. The proposal promises nothing per
// component — each managed adapter fails closed to report-only for
// unknown/unmanaged targets when `runDepsUpgrades` runs. Never mutates.
// ---------------------------------------------------------------------------
export function formatDepsUpgradeProposal(check) {
    const rows = check.components.filter((row) => row.component !== "aria");
    const lines = ["ARIA dependency upgrade proposal (read-only; no changes were made)", ""];
    for (const row of rows) {
        lines.push(`  ${row.component}: installed=${row.installed ?? "-"} available=${row.available ?? "-"} status=${row.status} — ${row.detail}`);
        const stance = row.status === "unmanaged-observed"
            ? "proposed: re-evaluated by the owning adapter on approval (unknown/unmanaged stays report-only)"
            : row.status === "remote-healthy" || row.status === "current"
                ? "no action: already healthy/current"
                : row.status === "skipped"
                    ? "no action: nothing installed (missing installs belong to `aria setup`)"
                    : "report-only: stays untouched even on approval (unknown/unmanaged)";
        lines.push(`    ${stance}`);
    }
    lines.push("");
    lines.push("Explicit approval is required before any mutation. Re-run as `aria deps --upgrade --yes` to apply managed upgrades; unknown/unmanaged targets stay report-only with zero mutation. No changes were made.");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// v1.0.11 hotfix: formula-scoped Engram Homebrew prerequisite preflight.
//
// Placement: AFTER explicit approval (`--yes`/approved migrate entry) plus
// target/identity validation, and BEFORE any ARIA registration mutation,
// handoff/spawn, or component mutation. Read-only inventory
// (`checkUpgradeInventory`) and `upgrade --check` never invoke this — they
// only report the inventoried Engram row.
//
// Scope: only when the inventoried Engram install positively resolves to the
// Homebrew-formula path (`detectEngramSource() === "homebrew"`). Missing,
// unknown-target, non-Homebrew (`unknown`), and GitHub-asset paths skip
// unchanged (no probe, no behavior change). No trust is granted
// automatically and no transactionality is redesigned.
//
// Probe: exactly `brew upgrade --formula
// gentleman-programming/tap/engram --dry-run` via the existing Executor
// seam. `--dry-run` keeps the probe read-only (no install/upgrade).
// `HOMEBREW_NO_AUTO_UPDATE=1` is passed process-locally for that one probe
// call only (via the Executor `env` seam, never assigned to `process.env`,
// never persisted) so the probe cannot trigger a Homebrew auto-update — a
// network/state mutation outside the approved read-only probe.
//
// Tradeoff: HOMEBREW_NO_AUTO_UPDATE=1 freezes tap data at its cached state,
// so the dry-run reasons over possibly stale formulae. That staleness cannot
// cause a false block — worst case it reports success ("already current"),
// which still permits the real upgrade path (which performs its own `brew
// update` plus the real formula upgrade). A genuinely missing/untrusted
// formula still fails the dry-run and blocks with an actionable error.
// Omitting the flag would let a supposedly read-only probe mutate Homebrew
// state via auto-update, so the flag is the smallest safe read-only probe.
// ---------------------------------------------------------------------------
/** Fully qualified Engram Homebrew formula the preflight and upgrade use. */
export const ENGRAM_HOMEBREW_FORMULA = "gentleman-programming/tap/engram";
/** Exact argv for the read-only preflight probe (never mutates). */
export function buildEngramPreflightArgv() {
    return ["upgrade", "--formula", ENGRAM_HOMEBREW_FORMULA, "--dry-run"];
}
/** Display form of the preflight probe (for errors and reporting). */
export function formatEngramPreflightCommand() {
    return `brew upgrade --formula ${ENGRAM_HOMEBREW_FORMULA} --dry-run`;
}
/**
 * Per-call environment addition for the preflight probe only. Returned as
 * additions for the Executor `env` seam (the executor merges over a copy of
 * `process.env` for that call); never assigned to `process.env` and never
 * persisted to any file.
 */
export function engramPreflightEnv() {
    return { HOMEBREW_NO_AUTO_UPDATE: "1" };
}
/**
 * Formula-scoped prerequisite probe. Skips (ok, no probe) unless the
 * inventoried Engram row shows an installed version AND the install
 * positively resolves to the Homebrew-formula path. On the Homebrew path,
 * runs the exact read-only dry-run probe; any throw (failure or
 * indeterminate) blocks with an actionable error naming the formula, the
 * failed command, and the manual prerequisite. Never grants trust.
 */
export async function checkEngramHomebrewPreflight(executor, check) {
    const row = check.components.find((entry) => entry.component === "engram");
    if (!row || row.status === "skipped" || row.status === "unknown-target" || row.installed === null) {
        return { ok: true, skipped: true };
    }
    let source;
    try {
        source = await detectEngramSource(executor);
    }
    catch {
        // Source ambiguity is not a preflight failure: non-Homebrew/GitHub paths
        // stay unchanged and the real upgrade path reports its own errors.
        return { ok: true, skipped: true };
    }
    if (source !== "homebrew") {
        return { ok: true, skipped: true };
    }
    try {
        await executor("brew", buildEngramPreflightArgv(), { env: engramPreflightEnv() });
        return { ok: true, skipped: false };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            reason: `Engram Homebrew preflight failed: \`${formatEngramPreflightCommand()}\` reported (${reason}); establish formula trust for ${ENGRAM_HOMEBREW_FORMULA} manually (e.g. verify the tap is tapped and the formula is installed), then re-run with fresh approval. No changes were made. No trust was granted automatically.`,
        };
    }
}
/**
 * Default self-upgrade seam: fail closed. T011 owns exact-ref
 * remove/replace/re-register plus the one-shot handoff spawn; until it
 * lands, approval never causes a mutation here.
 */
export async function defaultSelfUpgrade() {
    return {
        ok: false,
        detail: "ARIA self-upgrade adapter unavailable (T011 owns exact-ref replacement plus the bounded handoff); no changes made",
    };
}
/**
 * R001 bare-CLI convergence probe for the already-current gate (read-only).
 *
 * The running package version (`check.cliVersion`) alone never proves the
 * globally installed bare `aria` is at the target. This probes the real
 * bare `aria --version` through the same executor and returns the bare
 * version (e.g. `1.1.0`) or null when it cannot be positively identified.
 * Never installs: the single `npm install -g <target.spec>` updater stays
 * inside the self-upgrade adapter (R003). Mirrors
 * `readInstalledCliVersion` in `src/aria-upgrade.ts` without importing it
 * (that module imports this one).
 */
async function readBareInstalledCliVersion(executor) {
    try {
        const result = await executor("aria", ["--version"]);
        const raw = result.stdout.trim().split(/\s+/)[0] ?? "";
        const version = raw.startsWith("v") ? raw.slice(1) : raw;
        return /^\d+\.\d+\.\d+/.test(version) ? version : null;
    }
    catch {
        return null;
    }
}
/**
 * T010 already-current CLI/plugin identity gate (pure, no mutation).
 *
 * The already-current dependency path mutates (shared lifecycle) directly
 * under the running release with NO self-replacement/handoff, so the
 * running CLI must positively be the registered installation before the
 * seam runs. The CLI version is positively identified (`cliVersion`) and
 * must exactly equal the positively identified installed registration
 * (`currentVersion` + `installedSpec`); any unknown or differing identity
 * fails closed with zero mutation. The approved exact-target handoff path
 * (upgrade-available, below) is preserved: it remains allowed to replace
 * the positively identified registration with the exact validated target.
 */
export function checkAlreadyCurrentCliIdentity(check) {
    if (check.currentVersion === null || check.installedSpec === null) {
        return {
            ok: false,
            reason: `installed ARIA registration is not positively identified (${check.installedSpec ?? "no exact spec"}); refusing to run dependency updates under an unverified release`,
        };
    }
    if (check.cliVersion === null) {
        return {
            ok: false,
            reason: `running CLI version is unknown; refusing to run dependency updates against registered ${check.installedSpec} without positive CLI identity`,
        };
    }
    if (check.cliVersion !== check.currentVersion) {
        return {
            ok: false,
            reason: `definite mismatch: running CLI ${check.cliVersion} vs registered installation ${check.currentVersion} (${check.installedSpec}); refusing to run dependency updates under a conflicting release (move only via the explicit exact-target \`aria upgrade --yes\` handoff)`,
        };
    }
    return { ok: true };
}
/**
 * Old-release upgrade pipeline: inventory → explicit approval → validate
 * the ARIA target BEFORE removal → T011 self-upgrade + bounded handoff.
 * On handoff success this function returns WITHOUT running any further
 * normalization, regen, sync, doctor, or reporting — the new release owns
 * the remainder via `continueUpgradeInNewRelease`.
 */
export async function runUpgrade(executor = defaultExecutor, options) {
    const check = await checkUpgradeInventory(executor, options);
    // Approval precedes ALL mutations (inventory above is strictly read-only).
    // T009: `check.currentVersion` is the installed registration version
    // (never the running CLI package version), so the blocked-approval
    // guidance names the registered installation.
    if (!options.approval.yes) {
        const targetSpec = check.available.kind === "known" ? check.available.target.spec : null;
        return {
            stage: "blocked-approval",
            ok: false,
            check,
            detail: formatBlockedApprovalDetail(check.currentVersion, targetSpec),
        };
    }
    // Unknown available target blocks self-upgrade with zero mutation.
    if (check.selfUpgradeBlocked) {
        return {
            stage: "blocked-unknown-target",
            ok: false,
            check,
            detail: `${check.blockReason ?? "target not positively identified"}. Self-upgrade blocked with zero mutation; establish the available release, then re-run with fresh approval.`,
        };
    }
    if (check.available.kind === "unknown" || check.currentVersion === null) {
        return {
            stage: "blocked-unknown-target",
            ok: false,
            check,
            detail: "ARIA target or installed version is not positively identified; self-upgrade blocked with zero mutation.",
        };
    }
    // Already current: ARIA is current only when the positively identified
    // installed/OpenCode registration, the running CLI, AND the positively
    // verified globally installed bare CLI are all at the available target
    // (R006 + R001). A stale bare CLI (registration and running package at
    // target with bare `aria --version` behind, e.g. plugin 1.1.0 plus bare
    // 1.0.15 at target 1.1.0) is NOT already current: it falls through to the
    // existing bounded exact-target CLI-update path below (R003
    // `npm install -g <exact-target-spec>` inside the self-upgrade adapter,
    // then the one-shot handoff with no registration replacement), so a bare
    // `aria --version` ends at the target release. No new mechanism, no
    // second updater: this gate only probes read-only and fails closed.
    //
    // Without a dependencies seam, report with zero mutation (pre-T017
    // behavior preserved for existing callers/tests). With a seam (the `aria
    // upgrade` CLI always provides the real shared lifecycle), run the
    // approved dependency updates directly under the current release with NO
    // self-replacement/handoff — the binding T017 case.
    //
    // T010: the seam path additionally requires CLI/plugin identity before
    // mutation (defense-in-depth alongside the both-at-target entry above; a
    // running CLI that is not positively the registered installation fails
    // closed with zero mutation). Only the approved exact-target handoff
    // below moves between releases.
    //
    // R001: the running package version alone never reports already-current.
    // The bare CLI is probed read-only here; an unknown or stale bare CLI
    // falls through (fail-closed, never false success).
    const cliAtTarget = check.cliVersion !== null && check.cliVersion === check.available.target.version;
    const bareCliAtTarget = check.currentVersion === check.available.target.version && cliAtTarget
        ? (await readBareInstalledCliVersion(executor)) === check.available.target.version
        : false;
    if (check.currentVersion === check.available.target.version && cliAtTarget && bareCliAtTarget) {
        if (!options.dependenciesFn) {
            return { stage: "already-current", ok: true, check, detail: `ARIA ${check.currentVersion} is already current; no changes made.` };
        }
        const identity = checkAlreadyCurrentCliIdentity(check);
        if (!identity.ok) {
            return {
                stage: "already-current",
                ok: false,
                check,
                detail: `ARIA ${check.currentVersion} is already current; ${identity.reason}. No changes were made.`,
            };
        }
        // R002: no dependency preflight gates the already-current seam — a
        // dependency failure surfaces through the seam's own per-component
        // states, never as a preflight block.
        let dependencies;
        try {
            dependencies = await options.dependenciesFn(executor, options.configDir);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                stage: "already-current",
                ok: false,
                check,
                dependencies: { outcomes: [], report: `dependencies threw: ${message}` },
                detail: `ARIA ${check.currentVersion} is already current; approved dependency updates failed (dependencies threw: ${message}). No self-replacement or handoff ran.`,
            };
        }
        const outcomes = dependencies.outcomes.map((outcome) => ({
            component: outcome.component,
            status: outcome.status,
            detail: outcome.detail,
            mutated: outcome.mutated,
        }));
        return {
            stage: "already-current",
            ok: dependencies.ok,
            check,
            dependencies: { outcomes, report: dependencies.report },
            detail: dependencies.ok
                ? `ARIA ${check.currentVersion} is already current; approved dependency updates completed directly under this release with no self-replacement/handoff.\n${dependencies.report}`
                : `ARIA ${check.currentVersion} is already current; approved dependency updates stopped with per-component states and no self-replacement/handoff.\n${dependencies.report}`,
        };
    }
    // Validate the exact target BEFORE the current registration is touched.
    const validated = validateAriaTargetForRemoval(check.available.target);
    if (!validated.ok) {
        return { stage: "blocked-unknown-target", ok: false, check, detail: `${validated.reason}; no changes made.` };
    }
    // R002: ARIA-only upgrade carries no dependency-upgrade prerequisites —
    // the approved self-upgrade runs even when a dependency probe would fail.
    // Dependency version upgrades belong exclusively to
    // `aria deps --upgrade` (T004). The formula-scoped Engram preflight stays
    // available for the newer-CLI migrate path only.
    const handoff = buildUpgradeHandoff(check.available.target, check);
    const selfUpgradeFn = options.selfUpgradeFn ?? defaultSelfUpgrade;
    const selfUpgrade = await selfUpgradeFn(check.available.target, handoff);
    // Pre-handoff failure: the old registration is left/restored by T011 and
    // reported exactly; this pipeline performs no further phases.
    if (!selfUpgrade.ok) {
        return {
            stage: "self-upgrade-failed",
            ok: false,
            check,
            handoff,
            selfUpgrade,
            detail: `ARIA self-upgrade failed before handoff: ${selfUpgrade.detail}${selfUpgrade.registration ? ` Registration: ${selfUpgrade.registration}` : ""} No component upgrades, normalization, regen, sync, doctor, or reporting ran.`,
        };
    }
    // Handoff taken: the old code stops here. Everything after this point
    // (component upgrades → normalization/registration → regen → sync →
    // doctor → before/after report) runs ONLY in the new release.
    return {
        stage: "handoff-taken",
        ok: true,
        check,
        handoff,
        selfUpgrade,
        detail: `Handoff taken to ${check.available.target.spec}. ${selfUpgrade.handoffNote ?? "The new release owns the remainder."} This release performs no further work.`,
    };
}
export function formatUpgradeResult(result) {
    const stageLine = result.stage === "already-current"
        ? "Upgrade: already current"
        : result.stage === "blocked-approval"
            ? "Upgrade: blocked (explicit approval required)"
            : result.stage === "blocked-unknown-target"
                ? "Upgrade: blocked (unknown target)"
                : result.stage === "preflight-failed"
                    ? "Upgrade: [FAIL] Engram Homebrew preflight failed before handoff"
                    : result.stage === "self-upgrade-failed"
                        ? "Upgrade: [FAIL] self-upgrade failed before handoff"
                        : "Upgrade: handoff taken";
    return `${formatUpgradeCheck(result.check)}\n\n${stageLine}\n${result.detail}`;
}
/** CLI exit code: 0 only for already-current or a taken handoff. */
export function upgradeExitCode(result) {
    return result.ok ? 0 : 1;
}
/** Bind the exact validated target plus the approved inventory scope. */
export function buildUpgradeHandoff(target, check) {
    return {
        kind: "aria-upgrade-handoff",
        handoffVersion: 1,
        target: { ...target },
        approvedComponents: check.components.map((row) => row.component),
        before: check,
    };
}
function sameScope(left, right) {
    if (left.length !== right.length)
        return false;
    const remaining = new Set(left);
    for (const name of right) {
        if (!remaining.delete(name))
            return false;
    }
    return remaining.size === 0;
}
/**
 * New-release gate: continue without re-asking ONLY on an exact match of
 * the validated target spec plus the approved component scope. Any
 * target/scope drift stops for fresh approval with zero mutation.
 */
export function isHandoffMatch(handoff, actualTarget, actualComponents) {
    if (handoff.kind !== "aria-upgrade-handoff" || handoff.handoffVersion !== 1) {
        return { match: false, reason: "handoff payload is not a recognized v1 upgrade handoff; stopping for fresh approval" };
    }
    if (actualTarget.spec !== handoff.target.spec) {
        return {
            match: false,
            reason: `handoff target drift: approved ${handoff.target.spec} but new release resolves ${actualTarget.spec}; stopping for fresh approval`,
        };
    }
    if (!sameScope(handoff.approvedComponents, [...actualComponents])) {
        return {
            match: false,
            reason: `handoff scope drift: approved [${handoff.approvedComponents.join(", ")}] but new release inventories [${[...actualComponents].join(", ")}]; stopping for fresh approval`,
        };
    }
    return { match: true };
}
function reportOnlyComponent(component, detail) {
    return async () => ({ component, status: "skipped", detail, mutated: false });
}
/**
 * T007 v1.0.14 post-handoff skills normalize phase (strict refresh).
 *
 * Runs ONLY in the new release as the `normalize` phase (before regen,
 * deps-sync, doctor). Refreshes a single stale positively owned packaged
 * entry (`node_modules/aria/skills`, e.g. the v1.0.7 npx cache) to the
 * current release location via the existing skills-only writer
 * (`ensureAriaSkillsRefreshFile` with backup/atomic/idempotence); current
 * is idempotent, unrelated entries and all other keys are preserved
 * byte-for-byte, ambiguous ownership (missing file/key, non-array, empty,
 * multiple owned, duplicate, non-string) fails closed as a failed phase
 * (`ok: false`, no write). Never deletes old caches; never rewrites
 * unrelated config. Nothing is thrown past the phase boundary.
 */
export async function runAriaSkillsRefreshPhase(ctx) {
    try {
        const configPath = ctx.configDir
            ? join(openCodeGlobalDir(ctx.configDir), "opencode.json")
            : defaultGlobalConfigPath();
        const result = await ensureAriaSkillsRefreshFile({ configPath, skillsRoot: resolveDurableAriaSkillsRoot() });
        if (!result.changed) {
            return { ok: true, detail: `ARIA skills already current in ${result.path} (idempotent, no changes)`, mutated: false };
        }
        const action = result.refreshed ? "refreshed stale owned path to the current release location" : "installed the current release location alongside unrelated entries";
        return { ok: true, detail: `ARIA skills ${action} in ${result.path}`, mutated: true };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `ARIA skills refresh failed: ${reason}`, mutated: false };
    }
}
/**
 * T002 post-handoff managed-agent regen phase (strict reconciliation).
 *
 * Runs ONLY in the new release after registration/normalization and before
 * deps-sync/doctor (phase order owned by `continueUpgradeInNewRelease` below:
 * normalize → regen → deps-sync → doctor). Uses the strict
 * `reconcileManagedAgents` wrapper (T001: packaged defaults plus the
 * supported global overlay via `resolveSetupAriaConfig`, fail-closed on
 * unowned/ambiguous role paths, unrelated files untouched) — never the
 * tolerant standalone-setup `installAgentFiles` (preserved in
 * `src/lifecycle.ts`). Reconciliation conflicts return a failed phase
 * (`ok: false`) so the continuation stops as `phase-stopped` with the
 * actionable conflict detail; nothing is thrown past the phase boundary.
 */
export async function runManagedAgentRegenPhase(ctx) {
    let agents;
    let commands;
    try {
        const dir = ctx.configDir ? join(openCodeGlobalDir(ctx.configDir), "agents") : undefined;
        agents = await reconcileManagedAgents(process.cwd(), dir ? { dir } : {});
        const commandDir = ctx.configDir ? join(openCodeGlobalDir(ctx.configDir), "commands") : undefined;
        commands = await reconcileManagedCommands(commandDir ? { dir: commandDir, version: agents.version } : { version: agents.version });
        const tamperedNote = agents.tampered.length > 0 ? ` (tampered regenerated: ${agents.tampered.join(", ")})` : "";
        return {
            ok: true,
            detail: `managed-agent/command reconciliation: ${agents.written.length} agents and ${commands.written.length} commands written; ${agents.unchanged.length} agents and ${commands.unchanged.length} commands unchanged${tamperedNote}`,
            mutated: agents.written.length > 0 || commands.written.length > 0,
        };
    }
    catch (error) {
        if (commands)
            await rollbackCommandInstall(commands.dir, commands).catch(() => undefined);
        if (agents)
            await rollbackAgentInstall(agents.dir, agents).catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `managed agent/command reconciliation failed: ${reason}`, mutated: false };
    }
}
export async function runManagedCommandRegenPhase(ctx) {
    try {
        const dir = ctx.configDir ? join(openCodeGlobalDir(ctx.configDir), "commands") : undefined;
        const result = await reconcileManagedCommands(dir ? { dir } : {});
        return { ok: true, detail: `managed-command reconciliation: ${result.written.length} written, ${result.unchanged.length} unchanged in ${result.dir} (v${result.version})`, mutated: result.written.length > 0 };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `managed-command reconciliation failed: ${reason}`, mutated: false };
    }
}
/**
 * Continue an approved upgrade ONLY in the new release. The handoff match
 * is checked before any mutation; component failures stop the pipeline
 * with per-component states and no global transactionality (completed work
 * stays, unattempted work reports `skipped`).
 */
export async function continueUpgradeInNewRelease(handoff, actualTarget, actualComponents, options = {}) {
    const matched = isHandoffMatch(handoff, actualTarget, actualComponents);
    if (!matched.match) {
        return { stage: "drift-blocked", ok: false, outcomes: [], report: "", detail: `${matched.reason} No changes were made.` };
    }
    const executor = options.executor ?? defaultExecutor;
    const ctx = { target: handoff.target, executor, configDir: options.configDir };
    const overrides = options.components ?? {};
    const componentFns = [
        { name: "aria", fn: overrides.aria ?? reportOnlyComponent("aria", "ARIA self-upgrade completed pre-handoff; nothing remains post-handoff") },
        { name: "engram", fn: overrides.engram ?? engramUpgradeComponent },
        { name: "context7", fn: overrides.context7 ?? context7UpgradeComponent },
        { name: "codegraph", fn: overrides.codegraph ?? codegraphUpgradeComponent },
        { name: "zotpilot", fn: overrides.zotpilot ?? zotpilotUpgradeComponent },
        { name: "quota", fn: overrides.quota ?? quotaLifecycleUpgradeComponent },
    ];
    const outcomes = [];
    for (const { fn } of componentFns) {
        const outcome = await fn(ctx);
        outcomes.push(outcome);
        if (outcome.status === "rolled-back" || outcome.status === "unresolved") {
            for (const { name } of componentFns.slice(outcomes.length)) {
                outcomes.push({ component: name, status: "skipped", detail: `not attempted (stopped after ${outcome.component})`, mutated: false });
            }
            return {
                stage: "component-stopped",
                ok: false,
                outcomes,
                report: formatUpgradeReport(handoff.before, outcomes),
                detail: `Component ${outcome.component} stopped the upgrade (${outcome.status}); completed work stays, nothing was rolled back globally.`,
            };
        }
    }
    const phases = [
        {
            name: "normalize",
            fn: options.normalizeFn ??
                (async () => ({
                    ok: true,
                    detail: "target-version normalization/registration owned by the new release (T011+); T010 performs no normalization",
                    mutated: false,
                })),
        },
        {
            name: "regen",
            fn: options.regenFn ??
                (async () => ({
                    ok: true,
                    detail: "agent regeneration owned by the new release when its routes require it; T010 regenerates nothing",
                    mutated: false,
                })),
        },
        {
            name: "deps-sync",
            fn: options.depsSyncFn ??
                (async (phaseCtx) => {
                    const result = await depsSync(phaseCtx.executor, phaseCtx.configDir);
                    return {
                        ok: result.ok,
                        detail: result.ok ? "deps sync normalized the current installs" : "deps sync reported failures",
                        mutated: true,
                    };
                }),
        },
        {
            name: "doctor",
            fn: options.doctorFn ??
                (async (phaseCtx) => {
                    const report = await runDoctor({ executor: phaseCtx.executor });
                    const failures = report.findings.filter((finding) => finding.severity === "FAIL").length;
                    return {
                        ok: doctorExitCode(report.findings) === 0,
                        detail: failures === 0 ? "doctor reports no FAIL findings" : `doctor reports ${failures} FAIL finding(s)`,
                        mutated: false,
                    };
                }),
        },
    ];
    for (const { name, fn } of phases) {
        const phase = await fn(ctx);
        if (!phase.ok) {
            return {
                stage: "phase-stopped",
                ok: false,
                outcomes,
                report: formatUpgradeReport(handoff.before, outcomes, { phase: `${name}: ${phase.detail}` }),
                detail: `Post-handoff phase ${name} stopped the upgrade: ${phase.detail}`,
            };
        }
    }
    return {
        stage: "complete",
        ok: true,
        outcomes,
        report: formatUpgradeReport(handoff.before, outcomes),
        detail: `Upgrade to ${handoff.target.spec} completed through doctor; see the before/after report.`,
    };
}
/** Before/after report: the bound before-inventory plus per-component after states. */
export function formatUpgradeReport(before, outcomes, extra) {
    const lines = ["ARIA upgrade report", ""];
    lines.push(`Before: ARIA ${before.currentVersion ?? "unknown"} (available was ${before.available.kind === "known" ? before.available.target.tag : "unknown"})`);
    for (const row of before.components) {
        lines.push(`  before ${row.component}: installed=${row.installed ?? "-"} available=${row.available ?? "-"} status=${row.status}`);
    }
    lines.push("");
    lines.push("After:");
    if (outcomes.length === 0) {
        lines.push("  (no component outcomes)");
    }
    for (const outcome of outcomes) {
        lines.push(`  after ${outcome.component}: ${outcome.status}${outcome.mutated ? " (mutated)" : ""} — ${outcome.detail}`);
    }
    if (extra?.phase) {
        lines.push("");
        lines.push(`Phase: ${extra.phase}`);
    }
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Sync vs upgrade definition (the pipeline contract in code)
// ---------------------------------------------------------------------------
/**
 * The one sync-vs-upgrade definition: `deps sync` normalizes CURRENT
 * installs (idempotent, unapproved, Quota excluded); `aria upgrade` moves
 * to a NEW release through inventory, explicit approval, pre-removal
 * validation, self-upgrade plus a bounded handoff, and new-release-only
 * completion with a before/after report.
 */
export function describeSyncVsUpgrade() {
    return {
        sync: {
            normalizeCurrent: true,
            idempotent: true,
            approvalRequired: false,
            quotaExcluded: true,
            phases: ["normalize current installs (Engram, Context7, CodeGraph)", "validate health", "report"],
        },
        upgrade: {
            approvalRequired: true,
            phases: [
                "inventory (read-only --check)",
                "explicit approval (--yes)",
                "validate ARIA target before removal",
                "T011 self-upgrade plus bounded handoff",
                "ONLY in new release: component upgrades",
                "ONLY in new release: target-version normalization/registration",
                "ONLY in new release: agent regen if required",
                "ONLY in new release: deps sync",
                "ONLY in new release: doctor",
                "before/after report",
            ],
        },
    };
}
// ---------------------------------------------------------------------------
// T003 migrate-from: newer-CLI-owned escape for an immutable sender (e.g.
// installed v1.0.7).
//
// A normal `aria upgrade --yes` runs the INSTALLED release's own transition
// code (selected via `npm exec --package <installed-spec>`). When that code
// cannot be trusted, the NEWER release owns the transition instead:
//
//   NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package <to-spec> -- aria upgrade --migrate-from <from-spec> --yes
//
// `--package` names the newer (to) release whose code runs; `--migrate-from`
// names the installed (from) registration that must be replaced. Gates: the
// installed registration must positively equal `--migrate-from` (list
// inventory plus the adapter's persisted+list check), the running release
// must positively be the (to) target from its own package.json (never the
// installed row), `--yes` is required, and any mismatch, ambiguity, unknown,
// or foreign state fails closed with zero mutation. On success the corrected
// remove→add→persisted-verify→bounded-list-converge transition runs under
// the CURRENT (newer) code paths only (the old release's mutation logic is
// never invoked: no spawn of the from-release), and the normal post-handoff
// continuation is dispatched through the exact target package.
// ---------------------------------------------------------------------------
/**
 * Validate an explicit `--migrate-from` spec (pure, no mutation): exactly
 * the approved Git namespace plus an exact `vX.Y.Z` release tag. Anything
 * else fails closed (never guessed, never a branch, moving tag, or short
 * SHA).
 */
export function parseMigrateFromSpec(spec) {
    if (!spec.startsWith(ARIA_GIT_SPEC_PREFIX)) {
        return { ok: false, reason: `--migrate-from ${spec} is not an exact ARIA Git spec (expected ${ARIA_GIT_SPEC_PREFIX}vX.Y.Z[-rc.N] or a full commit SHA)` };
    }
    const ref = spec.slice(ARIA_GIT_SPEC_PREFIX.length);
    if (!isExactAriaReleaseTag(ref) && !isExactCommitRef(ref)) {
        return { ok: false, reason: `--migrate-from ref ${ref} is not an exact release tag or full commit SHA` };
    }
    return { ok: true };
}
/**
 * Derive the migrate (to) target from the running release's own packaged
 * version (package.json, never the installed row). Null, dev, or inexact
 * versions fail closed: a release that cannot name its own target cannot
 * own a transition.
 */
export function ownReleaseTarget(ownVersion) {
    if (ownVersion === null) {
        return { ok: false, reason: "this release's packaged version is not positively identified (package.json unreadable); migrate blocked with zero mutation" };
    }
    const ownTag = `v${ownVersion}`;
    if (!isExactAriaReleaseTag(ownTag)) {
        return { ok: false, reason: `this release's packaged version (${ownVersion}) is not an exact release identity; migrate blocked with zero mutation` };
    }
    const target = { tag: ownTag, version: ownVersion, spec: `${ARIA_GIT_SPEC_PREFIX}${ownTag}` };
    const validated = validateAriaTargetForRemoval(target);
    if (!validated.ok)
        return { ok: false, reason: validated.reason };
    return { ok: true, target };
}
/**
 * Pure npm argv for an approved migrate run: the newer bootstrap CLI is
 * selected via `--package`, the installed (from) registration via
 * `--migrate-from`, and an optional immutable prerelease destination via
 * `--target-spec`. The caller prefixes `npm` (or `npx`) and the approved
 * per-invocation `NPM_CONFIG_ALLOW_GIT=all` env (process-local, never
 * global/`.npmrc`); the `--` boundary keeps the `aria ...` argv from being
 * parsed as npm options.
 */
export function buildMigrateApprovalArgv(fromSpec, toSpec, targetSpec) {
    return [
        "exec", "--yes", "--package", toSpec, "--", "aria", "upgrade", "--migrate-from", fromSpec,
        ...(targetSpec === undefined ? [] : ["--target-spec", targetSpec]), "--yes",
    ];
}
/** Display form of the exact newer-CLI migrate invocation (pure). */
export function formatMigrateApprovalCommand(fromSpec, toSpec, targetSpec) {
    return `NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${toSpec} -- aria upgrade --migrate-from ${fromSpec}${targetSpec === undefined ? "" : ` --target-spec ${targetSpec}`} --yes`;
}
/**
 * Blocked-approval detail for `runMigrateUpgrade` when `--yes` was not
 * given (pure, no mutation). Names the exact newer-CLI invocation when the
 * (to) target is positively identified; otherwise fails closed with no
 * invocation offered.
 */
export function formatMigrateBlockedDetail(fromSpec, toSpec, targetSpec) {
    if (toSpec === null) {
        return "Explicit approval is required before any mutation, and this release is not positively identified as an exact ARIA release, so no migrate invocation can be offered. Establish identity, then re-run with fresh approval. No changes were made.";
    }
    return `Explicit approval is required before any mutation. Re-run with \`${formatMigrateApprovalCommand(fromSpec, toSpec, targetSpec)}\` to approve the migrate-from transition (${fromSpec} → ${targetSpec ?? toSpec}). No changes were made.`;
}
/** Default migrate seam: fail closed (the adapter owns the transition). */
export async function defaultMigrate() {
    return {
        ok: false,
        detail: "ARIA migrate adapter unavailable (aria-upgrade owns the newer-CLI transition); no changes made",
    };
}
/**
 * Newer-CLI migrate pipeline: read-only inventory → explicit approval →
 * validate `--migrate-from` plus the own package target (or an explicitly
 * selected immutable rc commit) →
 * require the installed registration to exactly equal `--migrate-from` →
 * newer-CLI-owned remove→add→persisted-verify→bounded-list-converge
 * transition (never the old release's mutation logic: no from-release
 * spawn) → verified exact-target package continuation via npm exec.
 */
export async function runMigrateUpgrade(executor = defaultExecutor, options) {
    const explicitTarget = options.targetSpec === undefined
        ? undefined
        : await discoverAriaTargetByExactSpec(options.targetSpec, executor, true);
    const check = await checkUpgradeInventory(executor, options.targetSpec === undefined
        ? options
        : { ...options, availableOverride: explicitTarget?.kind === "known" ? explicitTarget.target : null });
    const ownVersion = options.ownVersion !== undefined ? options.ownVersion : readCurrentAriaVersion();
    const own = ownReleaseTarget(ownVersion);
    const from = parseMigrateFromSpec(options.migrateFrom);
    const target = explicitTarget?.kind === "known" ? explicitTarget.target : own.ok ? own.target : null;
    if (explicitTarget?.kind === "unknown") {
        return {
            stage: "blocked-migrate",
            ok: false,
            check,
            detail: `${explicitTarget.reason}; explicit target blocked with zero mutation. No changes were made.`,
            report: "",
        };
    }
    if (!own.ok) {
        return { stage: "blocked-migrate", ok: false, check, detail: `${own.reason} No changes were made.`, report: "" };
    }
    if (!target) {
        return { stage: "blocked-migrate", ok: false, check, detail: "No exact migrate target was positively identified. No changes were made.", report: "" };
    }
    if (!from.ok) {
        return { stage: "blocked-migrate", ok: false, check, detail: `${from.reason}; migrate blocked with zero mutation. No changes were made.`, report: "" };
    }
    if (explicitTarget?.kind === "known") {
        if (compareAriaVersions(target.version, own.target.version) >= 0) {
            return {
                stage: "blocked-migrate",
                ok: false,
                check,
                ownTarget: target,
                detail: `explicit target ${target.tag} must be older than the bootstrap release ${own.target.tag}; refusing a mismatched target version. No changes were made.`,
                report: "",
            };
        }
        if (check.currentVersion !== null && compareAriaVersions(target.version, check.currentVersion) <= 0) {
            return {
                stage: "blocked-migrate",
                ok: false,
                check,
                ownTarget: target,
                detail: `explicit target ${target.tag} does not supersede installed ${check.currentVersion}; refusing a downgrade or same-version migration. No changes were made.`,
                report: "",
            };
        }
    }
    if (!options.approval.yes) {
        let approvalPackageSpec = own.target.spec;
        if (options.targetSpec !== undefined) {
            const bootstrap = await discoverAriaTargetByExactTag(own.target.tag, executor);
            approvalPackageSpec = bootstrap.kind === "known" ? bootstrap.target.spec : "";
        }
        return {
            stage: "blocked-approval",
            ok: false,
            check,
            detail: formatMigrateBlockedDetail(options.migrateFrom, approvalPackageSpec || null, options.targetSpec),
            report: "",
        };
    }
    if (options.migrateFrom === target.spec || check.currentVersion === target.version) {
        return {
            stage: "blocked-migrate",
            ok: false,
            check,
            ownTarget: target,
            detail: `--migrate-from ${options.migrateFrom} equals the target release (${target.spec}); nothing to migrate. Use the normal exact-package upgrade path. No changes were made.`,
            report: "",
        };
    }
    if (check.installedSpec !== options.migrateFrom) {
        const observed = check.installedSpec ?? check.blockReason ?? "unknown";
        return {
            stage: "blocked-migrate",
            ok: false,
            check,
            ownTarget: target,
            detail: `migrate-from mismatch: approved ${options.migrateFrom} but the installed registration is ${observed}; refusing to mutate. No changes were made.`,
            report: "",
        };
    }
    // v1.0.11 hotfix: formula-scoped Engram prerequisite preflight — after the
    // approved migrate entry passes every identity gate, before any ARIA
    // registration mutation or target-package continuation. Failure/indeterminate
    // stops here with zero mutation.
    const migratePreflight = await checkEngramHomebrewPreflight(executor, check);
    if (!migratePreflight.ok) {
        return {
            stage: "preflight-failed",
            ok: false,
            check,
            ownTarget: target,
            detail: migratePreflight.reason,
            report: "",
        };
    }
    const handoff = buildUpgradeHandoff(target, check);
    const migrateFn = options.migrateFn ?? defaultMigrate;
    const selfUpgrade = await migrateFn(options.migrateFrom, target, handoff);
    if (!selfUpgrade.ok) {
        return {
            stage: "migrate-failed",
            ok: false,
            check,
            ownTarget: target,
            handoff,
            selfUpgrade,
            detail: `ARIA migrate transition or target-release handoff failed: ${selfUpgrade.detail}${selfUpgrade.registration ? ` Registration: ${selfUpgrade.registration}` : ""}`,
            report: selfUpgrade.handoffOutput ?? "",
        };
    }
    return {
        stage: "complete",
        ok: true,
        check,
        ownTarget: target,
        handoff,
        selfUpgrade,
        report: selfUpgrade.handoffOutput ?? "",
        detail: `Migrate ${options.migrateFrom} → ${target.spec}: ${selfUpgrade.handoffNote ?? selfUpgrade.detail}`,
    };
}
export function formatMigrateResult(result) {
    const stageLine = result.stage === "complete"
        ? "Migrate: complete"
        : result.stage === "blocked-approval"
            ? "Migrate: blocked (explicit approval required)"
            : result.stage === "blocked-migrate"
                ? "Migrate: blocked (identity gate)"
                : result.stage === "preflight-failed"
                    ? "Migrate: [FAIL] Engram Homebrew preflight failed before transition"
                    : result.stage === "migrate-failed"
                        ? "Migrate: [FAIL] transition failed before continuation"
                        : `Migrate: stopped (${result.stage})`;
    const head = formatUpgradeCheck(result.check);
    const tail = result.report ? `\n\n${result.report}` : "";
    return `${head}\n\n${stageLine}\n${result.detail}${tail}`;
}
/** CLI exit code: 0 only when the migrate transition plus continuation completed. */
export function migrateExitCode(result) {
    return result.ok ? 0 : 1;
}
//# sourceMappingURL=upgrade.js.map