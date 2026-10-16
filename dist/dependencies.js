// ---------------------------------------------------------------------------
// T017 — Shared dependency lifecycle + setup wiring.
//
// Single orchestrator for the supported bootstrap stack (Engram, CodeGraph,
// ZotPilot, Quota, Context7-remote-only) implementing the model:
// detect → discover latest upstream → install if missing OR update if safely
// owned/outdated → normalize/configure → validate.
//
// - `aria setup` invokes the setup lifecycle DIRECTLY on clean/existing
//   OpenCode V2+ installs via `runSetupDependencies` (no ARIA self-upgrade
//   handoff first; setup never performs self-replacement — that ordering
//   belongs only to `aria upgrade` when ARIA itself is outdated).
//   T002: setup is install-if-missing ONLY — an already-installed dependency
//   is left untouched even when a newer release exists (missing → setup;
//   version upgrades belong exclusively to `aria deps --upgrade`, T004).
// - `aria deps sync` remains non-version-chasing normalization/repair and is
//   unchanged by this module (see `depsSync` in `./deps.js`; no behavior
//   change beyond current).
// - `aria upgrade` performs the existing ARIA self-upgrade/handoff first ONLY
//   when ARIA itself needs upgrading; after handoff the target release runs
//   the SAME lifecycle in update/normalize/validate mode via
//   `continueUpgradeInNewRelease` component seams below. When ARIA is already
//   current, the approved dependency updates run directly under the current
//   release with NO self-replacement/handoff (see `runUpgradeDependencies`).
//
// This task explicitly supersedes two older wordings (narrowly, bootstrap
// path only):
// - T012–T014 "execute only after T011 handoff": that restriction applies
//   ONLY to the `aria upgrade` path; the same adapters are callable directly
//   by `aria setup` (see `ensureEngram`/`ensureCodegraph`/`ensureZotpilot`
//   headers, already shared).
// - T007 "setup never touches Quota": setup/sync still never touch Quota
//   through `depsSync`, but the BOOTSTRAP path (`ensureQuotaForLifecycle`,
//   missing → install via the T016 demonstrated-safe native `plugin add`)
//   IS part of the setup stack. `deps sync` keeps its exclusion (no change).
//
// Reuse, no duplication:
// - Engram T012 (`ensureEngram`), CodeGraph T013 (`ensureCodegraph`),
//   ZotPilot T014 (`ensureZotpilot`), Quota T007 (`upgradeQuota`) + T016
//   (`installQuotaIfMissing`), Context7 T009 (`syncContext7`), T005
//   statusline normalization (reused inside the Engram adapter, never here).
// - No dependency-version compatibility database is introduced anywhere:
//   current upstream is discovered at runtime through each package manager's
//   normal mechanism (`npm view` / `pip index` / GitHub releases / brew) and
//   post-change integration validation is the safety mechanism.
// - XDG isolation via the explicit `configDir` seam; legacy shapes never
//   written; ambiguous ownership fails closed report-only with zero mutation.
// ---------------------------------------------------------------------------
import { installQuotaIfMissing } from "./bootstrap.js";
import { detectCodegraphState, ensureCodegraph } from "./codegraph.js";
import { defaultExecutor, detectContext7, syncContext7 } from "./deps.js";
import { detectEngramState, ensureEngram } from "./engram.js";
import { checkQuotaUpgrade, upgradeQuota } from "./quota.js";
import { detectZotpilotState, ensureZotpilot } from "./zotpilot.js";
/** Bootstrap-stack component names (ARIA self-upgrade is separate, T011). */
export const DEPENDENCY_COMPONENTS = ["engram", "codegraph", "zotpilot", "quota", "context7"];
function completed(component, detail, mutated) {
    return { component, status: "completed", detail, mutated };
}
function skipped(component, detail) {
    return { component, status: "skipped", detail, mutated: false };
}
function failed(component, detail, rolledBack) {
    return { component, status: rolledBack === true ? "rolled-back" : "unresolved", detail, mutated: true };
}
// ---------------------------------------------------------------------------
// Quota — bootstrap lifecycle (missing → install, owned-outdated → update)
// ---------------------------------------------------------------------------
/**
 * Quota bootstrap lifecycle for the setup/upgrade shared path.
 *
 * - Absent (`checkQuotaUpgrade` skipped) → install-if-missing via the T016
 *   demonstrated-safe native `opencode plugin add <exact 5.x>` after `npm
 *   view` discovery (XDG-guarded, validated, snapshot rollback).
 * - Positively identified Quota 5 (`unmanaged-observed`) → gated native
 *   update via the T007 adapter (owned-outdated → update, current →
 *   normalize/validate as `already-current`).
 * - Ambiguous/unsupported (`unknown-target`/`unsupported-ownership`) →
 *   fail-closed report-only with zero mutation (never guessed).
 *
 * This supersedes T007's setup-exclusion wording ONLY for this bootstrap
 * path; `depsSync` keeps its exclusion unchanged (no Quota call there).
 */
export async function ensureQuotaForLifecycle(executor, options = {}) {
    const inventory = await checkQuotaUpgrade(executor, options.configDir);
    if (inventory.status === "skipped") {
        const installed = await installQuotaIfMissing(executor, { configDir: options.configDir });
        switch (installed.status) {
            case "installed":
                return completed("quota", installed.detail, true);
            case "already-present":
                return skipped("quota", `${installed.detail} (observed during install; leaving untouched)`);
            case "report-only":
                return skipped("quota", installed.detail);
            case "install-failed":
                return {
                    component: "quota",
                    status: "unresolved",
                    detail: installed.detail,
                    mutated: installed.mutated,
                };
            case "validation-failed":
                return failed("quota", installed.detail, installed.rolledBack);
        }
    }
    if (inventory.status === "unmanaged-observed") {
        const upgraded = await upgradeQuota(executor, { configDir: options.configDir });
        switch (upgraded.status) {
            case "upgraded":
            case "already-current":
                return completed("quota", upgraded.detail, upgraded.mutated);
            case "skipped":
            case "unmanaged-observed":
            case "unknown-target":
            case "unsupported-ownership":
                return skipped("quota", upgraded.detail);
            case "update-failed":
            case "validation-failed":
                return failed("quota", upgraded.detail, upgraded.rolledBack);
        }
    }
    return skipped("quota", inventory.detail);
}
// ---------------------------------------------------------------------------
// Context7 — remote-only lifecycle (configure/normalize/validate, no package)
// ---------------------------------------------------------------------------
/**
 * Context7 remote-only lifecycle (T009, reused without duplication).
 *
 * - Missing/wrong URL → normalize to the canonical
 *   `mcp.servers.context7 = { type: "remote", url }` entry (file-based,
 *   preserves unrelated servers/keys).
 * - Canonical → already-current (completed, no mutation).
 * - Conflicting/ambiguous/invalid → fail-closed report-only (skipped, zero
 *   mutation, never guessed). No local package is ever installed or upgraded
 *   on this path.
 */
export async function ensureContext7ForLifecycle(executor, options = {}) {
    const result = await syncContext7(executor, options.configDir);
    if (result.action === "already-configured") {
        return completed("context7", "Context7 remote endpoint already configured (canonical URL, remote-healthy when connected)", false);
    }
    if (result.action === "configured") {
        return completed("context7", "Context7 remote endpoint configured (canonical URL https://mcp.context7.com/mcp, unrelated entries preserved)", true);
    }
    return skipped("context7", result.error ?? "Context7 registration ambiguous; leaving untouched");
}
// ---------------------------------------------------------------------------
// Shared orchestration (setup-direct + post-handoff upgrade share this)
// ---------------------------------------------------------------------------
function mapEngram(component, result) {
    switch (result.status) {
        case "installed":
        case "upgraded":
        case "already-current":
            return completed(component, result.detail, result.mutated);
        case "report-only":
            return skipped(component, result.detail);
        case "install-failed":
        case "update-failed":
        case "setup-failed":
        case "validation-failed":
            return failed(component, result.detail, result.rolledBack);
    }
}
function mapCodegraph(component, result) {
    switch (result.status) {
        case "installed":
            return completed(component, result.detail, result.mutated);
        case "report-only":
            return skipped(component, result.detail);
        case "install-failed":
        case "validation-failed":
            return failed(component, result.detail, result.rolledBack);
    }
}
function mapZotpilot(component, result) {
    switch (result.status) {
        case "installed":
        case "updated":
        case "already-current":
            return completed(component, result.detail, result.mutated);
        case "report-only":
            return skipped(component, result.detail);
        case "install-failed":
        case "update-failed":
        case "validation-failed":
            return failed(component, result.detail, result.rolledBack);
    }
}
/** Human-readable before/after-style report for the setup/upgrade lifecycle. */
export function formatDependenciesReport(outcomes) {
    const lines = ["Dependency lifecycle report", ""];
    if (outcomes.length === 0)
        lines.push("  (no component outcomes)");
    for (const outcome of outcomes) {
        lines.push(`  ${outcome.component}: ${outcome.status}${outcome.mutated ? " (mutated)" : ""} — ${outcome.detail}`);
    }
    return lines.join("\n");
}
/**
 * Shared lifecycle: detect → discover latest upstream → install if missing
 * OR update if safely owned/outdated → normalize/configure → validate.
 *
 * Runs the five bootstrap-stack adapters directly (no ARIA self-upgrade,
 * no handoff, no version database). Each adapter owns its validation and
 * snapshot rollback; this orchestration serializes config mutations (like
 * `depsSync`) and continues through failures so the report carries every
 * component state (upgrade continuation instead stops on the first failure
 * with no global transactionality — see `continueUpgradeInNewRelease`).
 *
 * - Setup calls this directly on clean/existing OC2+ installs.
 *   T002 install-only rule: each adapter runs ONLY when its component is
 *   positively identified as missing; an already-installed component
 *   (any version, any registration) is reported skipped with zero mutation
 *   — never upgraded, replaced, or re-normalized merely because a newer
 *   release exists. Missing → setup; version upgrades belong exclusively
 *   to `aria deps --upgrade` (T004). Reuses the existing adapters; no new
 *   dependency abstraction is introduced.
 * - Post-handoff upgrade calls the SAME adapters in update/normalize mode
 *   through the component seams below (plus `runUpgradeDependencies`).
 */
export async function runSetupDependencies(executor, options = {}) {
    const outcomes = [];
    // T002 install-only: Engram runs ONLY when positively missing. A present
    // binary (any version, any channel) is left untouched with zero mutation
    // — never upgraded merely because a newer release exists.
    try {
        const initial = await detectEngramState(executor, options.fileOps);
        if (initial.found) {
            outcomes.push(skipped("engram", `Engram ${initial.version ?? "unknown"} already installed; setup leaves present installs untouched (version upgrades belong to 'aria deps --upgrade')`));
        }
        else {
            const engram = await ensureEngram(executor, { configDir: options.configDir, fileOps: options.fileOps });
            outcomes.push(mapEngram("engram", engram));
        }
    }
    catch (error) {
        outcomes.push({
            component: "engram",
            status: "unresolved",
            detail: `Engram lifecycle threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        const codegraph = await ensureCodegraph(executor, { configDir: options.configDir });
        outcomes.push(mapCodegraph("codegraph", codegraph));
    }
    catch (error) {
        outcomes.push({
            component: "codegraph",
            status: "unresolved",
            detail: `CodeGraph lifecycle threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    // T002 install-only: ZotPilot runs ONLY on a clean system (no binary AND
    // no registration). Any existing binary or registration (V2, legacy, or
    // otherwise) is left untouched with zero mutation — never updated merely
    // because a newer release exists.
    try {
        const initial = await detectZotpilotState(executor, options.configDir);
        if (initial.found || initial.registration !== "absent") {
            const shape = initial.found
                ? `ZotPilot ${initial.version ?? "unknown"} already installed`
                : `existing ${initial.registration} zotpilot registration observed`;
            outcomes.push(skipped("zotpilot", `${shape}; setup leaves present installs untouched (version upgrades belong to 'aria deps --upgrade')`));
        }
        else {
            const zotpilot = await ensureZotpilot(executor, { configDir: options.configDir, homeDir: options.homeDir });
            outcomes.push(mapZotpilot("zotpilot", zotpilot));
        }
    }
    catch (error) {
        outcomes.push({
            component: "zotpilot",
            status: "unresolved",
            detail: `ZotPilot lifecycle threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    // T002 install-only: Quota installs ONLY when positively absent
    // (`checkQuotaUpgrade` skipped). Any observed, ambiguous, or unsupported
    // target is left untouched with zero mutation — never upgraded here;
    // version upgrades belong exclusively to `aria deps --upgrade` (T004).
    try {
        const inventory = await checkQuotaUpgrade(executor, options.configDir);
        if (inventory.status !== "skipped") {
            outcomes.push(skipped("quota", `${inventory.detail}; setup leaves present installs untouched (version upgrades belong to 'aria deps --upgrade')`));
        }
        else {
            const installed = await installQuotaIfMissing(executor, { configDir: options.configDir });
            switch (installed.status) {
                case "installed":
                    outcomes.push(completed("quota", installed.detail, true));
                    break;
                case "already-present":
                    outcomes.push(skipped("quota", `${installed.detail} (observed during install; leaving untouched)`));
                    break;
                case "report-only":
                    outcomes.push(skipped("quota", installed.detail));
                    break;
                case "install-failed":
                    outcomes.push({
                        component: "quota",
                        status: "unresolved",
                        detail: installed.detail,
                        mutated: installed.mutated,
                    });
                    break;
                case "validation-failed":
                    outcomes.push(failed("quota", installed.detail, installed.rolledBack));
                    break;
            }
        }
    }
    catch (error) {
        outcomes.push({
            component: "quota",
            status: "unresolved",
            detail: `Quota lifecycle threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        outcomes.push(await ensureContext7ForLifecycle(executor, { configDir: options.configDir }));
    }
    catch (error) {
        outcomes.push({
            component: "context7",
            status: "unresolved",
            detail: `Context7 lifecycle threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    const ok = outcomes.every((outcome) => outcome.status === "completed" || outcome.status === "skipped");
    return { ok, outcomes, report: formatDependenciesReport(outcomes) };
}
/**
 * Upgrade-mode entry for the already-current path and post-handoff docs.
 * The adapters already branch on missing vs outdated internally, so the
 * update/normalize/validate mode IS the same shared lifecycle (no separate
 * version-chasing path, no database).
 *
 * T002 ownership note: production `aria upgrade` is ARIA-only and never
 * calls this entry (bin/aria.mjs omits the seam); version upgrades belong
 * exclusively to `aria deps --upgrade` (T004), which wires the managed
 * adapters directly via `runDepsUpgrades` below. Retained as the shared install-only lifecycle for
 * existing callers/tests.
 */
export async function runUpgradeDependencies(executor, options = {}) {
    return runSetupDependencies(executor, options);
}
export async function runDepsUpgrades(executor = defaultExecutor, options = {}) {
    const outcomes = [];
    // R004: confirmed upgrades run ONLY on eligible existing managed targets.
    // A missing component (clean system: no binary AND no registration, or the
    // Quota-absent inventory) stays report-only even under `--upgrade --yes`:
    // missing installs belong to `aria setup` (the proposal's no-action
    // contract). Present-but-unmanaged states still delegate to the adapters,
    // which fail closed to report-only with zero mutation on their own.
    try {
        const initial = await detectEngramState(executor, options.fileOps);
        if (!initial.found) {
            outcomes.push(skipped("engram", "Engram not installed; missing installs belong to `aria setup` (confirmed upgrades only move existing managed targets)"));
        }
        else {
            outcomes.push(mapEngram("engram", await ensureEngram(executor, { configDir: options.configDir, fileOps: options.fileOps })));
        }
    }
    catch (error) {
        outcomes.push({
            component: "engram",
            status: "unresolved",
            detail: `Engram upgrade threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        const initial = await detectCodegraphState(executor, options.configDir);
        if (!initial.found && initial.registration === "absent") {
            outcomes.push(skipped("codegraph", "CodeGraph not installed; missing installs belong to `aria setup` (confirmed upgrades only move existing managed targets)"));
        }
        else {
            outcomes.push(mapCodegraph("codegraph", await ensureCodegraph(executor, { configDir: options.configDir })));
        }
    }
    catch (error) {
        outcomes.push({
            component: "codegraph",
            status: "unresolved",
            detail: `CodeGraph upgrade threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        const initial = await detectZotpilotState(executor, options.configDir);
        if (!initial.found && initial.registration === "absent") {
            outcomes.push(skipped("zotpilot", "ZotPilot not installed; missing installs belong to `aria setup` (confirmed upgrades only move existing managed targets)"));
        }
        else {
            outcomes.push(mapZotpilot("zotpilot", await ensureZotpilot(executor, { configDir: options.configDir, homeDir: options.homeDir })));
        }
    }
    catch (error) {
        outcomes.push({
            component: "zotpilot",
            status: "unresolved",
            detail: `ZotPilot upgrade threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        // R004: the Quota-absent inventory (`skipped`: nothing observed) stays
        // report-only — installation belongs to `aria setup`. Only a positively
        // observed target delegates to the shared lifecycle (owned-outdated
        // upgrades; ambiguous/unsupported stays report-only there).
        const inventory = await checkQuotaUpgrade(executor, options.configDir);
        if (inventory.status === "skipped") {
            outcomes.push(skipped("quota", "no Quota installation observed; missing installs belong to `aria setup` (confirmed upgrades only move existing managed targets)"));
        }
        else {
            outcomes.push(await ensureQuotaForLifecycle(executor, { configDir: options.configDir }));
        }
    }
    catch (error) {
        outcomes.push({
            component: "quota",
            status: "unresolved",
            detail: `Quota upgrade threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    try {
        // R007: confirmed upgrades move ONLY existing managed targets. An
        // absent/missing Context7 remote endpoint stays report-only even under
        // `--upgrade --yes` — missing installs belong to `aria setup`, which
        // keeps creating it through the same lifecycle. Reuses the existing
        // detection; no new abstraction.
        const initial = await detectContext7(executor, options.configDir);
        if (!initial.configured) {
            outcomes.push(skipped("context7", "Context7 remote endpoint not configured; missing installs belong to `aria setup` (confirmed upgrades only move existing managed targets)"));
        }
        else {
            outcomes.push(await ensureContext7ForLifecycle(executor, { configDir: options.configDir }));
        }
    }
    catch (error) {
        outcomes.push({
            component: "context7",
            status: "unresolved",
            detail: `Context7 upgrade threw (${error instanceof Error ? error.message : String(error)}); no state is positively confirmed`,
            mutated: false,
        });
    }
    const ok = outcomes.every((outcome) => outcome.status === "completed" || outcome.status === "skipped");
    return { ok, outcomes, report: formatDependenciesReport(outcomes) };
}
// ---------------------------------------------------------------------------
// Post-handoff component seams (T010 continuation defaults, T017 wiring)
// ---------------------------------------------------------------------------
/**
 * Quota post-handoff seam: missing → install, owned-outdated → update,
 * current → completed, ambiguous → skipped. Maps lifecycle outcomes to
 * component states with no global transactionality.
 */
export async function quotaLifecycleUpgradeComponent(ctx) {
    const outcome = await ensureQuotaForLifecycle(ctx.executor, { configDir: ctx.configDir });
    switch (outcome.status) {
        case "completed":
            return { component: "quota", status: "completed", detail: outcome.detail, mutated: outcome.mutated };
        case "skipped":
            return { component: "quota", status: "skipped", detail: outcome.detail, mutated: false };
        case "rolled-back":
        case "unresolved":
            return { component: "quota", status: outcome.status, detail: outcome.detail, mutated: outcome.mutated };
    }
}
/**
 * Context7 post-handoff seam: remote-only normalize (no version upgrade).
 * Completed work stays completed; ambiguous stays skipped with zero
 * mutation.
 */
export async function context7UpgradeComponent(ctx) {
    const outcome = await ensureContext7ForLifecycle(ctx.executor, { configDir: ctx.configDir });
    switch (outcome.status) {
        case "completed":
            return { component: "context7", status: "completed", detail: outcome.detail, mutated: outcome.mutated };
        case "skipped":
            return { component: "context7", status: "skipped", detail: outcome.detail, mutated: false };
        case "rolled-back":
        case "unresolved":
            return { component: "context7", status: outcome.status, detail: outcome.detail, mutated: outcome.mutated };
    }
}
//# sourceMappingURL=dependencies.js.map