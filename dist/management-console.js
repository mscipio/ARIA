import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import { createElement as h } from "react";
import { selfUpgradeAria } from "./aria-upgrade.js";
import { readPackageVersion, defaultAgentsDir, isAriaManaged } from "./agents.js";
import { OPTIONAL_INSTALL_COMPONENTS, runDepsUpgrades, runSetupDependencies } from "./dependencies.js";
import { defaultExecutor } from "./deps.js";
import { discoverIntegrations, formatIntegrationProposal } from "./integrations.js";
import { runDoctor } from "./doctor.js";
import { discoverAvailableModels } from "./model-config.js";
import { saveFromManager } from "./model-manager.js";
import { loadModelManagerSnapshot } from "./model-manager-store.js";
import { ROLES, globalAriaConfigPath } from "./overrides.js";
import { setup } from "./lifecycle.js";
import { checkUpgradeInventory, formatDepsUpgradeProposal, formatUpgradeCheck, formatUpgradeResult, runUpgrade, } from "./upgrade.js";
import { ManagementConsoleApp } from "./management-console-tui.js";
/**
 * Entry point and service adapters for the ARIA Management Console (bare
 * `aria` in an interactive terminal). The adapters call the same functions the
 * explicit CLI commands use (`setup`, `runDoctor`, `checkUpgradeInventory`,
 * `runUpgrade`, `runDepsUpgrades`, the Model Manager save path), so the console
 * is a presentation layer and adds no second backend.
 */
export const NON_TERMINAL_HELP_NOTE = "aria: no interactive terminal; showing command help instead of the management console.";
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
function countManagedAgents() {
    const dir = defaultAgentsDir();
    let managed = 0;
    for (const role of ROLES) {
        try {
            if (isAriaManaged(readFileSync(join(dir, `${role}.md`), "utf8")))
                managed += 1;
        }
        catch {
            // Absent or unreadable: not counted as managed.
        }
    }
    return { managed, total: ROLES.length };
}
/** Cheap, file-system-only status for the menu (no subprocess, no network). */
export function readMenuStatus(worktree) {
    let version = null;
    try {
        version = readPackageVersion();
    }
    catch {
        version = null;
    }
    const agents = countManagedAgents();
    return {
        version,
        globalConfig: globalAriaConfigPath() !== undefined,
        projectConfig: existsSync(join(worktree, "aria.json")) || existsSync(join(worktree, "review-driven-code.json")),
        managedAgents: agents.managed,
        totalAgents: agents.total,
    };
}
function inspectionLines(check, status) {
    const lines = [
        `ARIA plugin registration: ${check.currentVersion ?? "not positively identified"}`,
        `Registered spec: ${check.installedSpec ?? "-"}`,
        `Running CLI package: ${check.cliVersion ?? "unknown"}`,
        `Managed agent files: ${status.managedAgents} of ${status.totalAgents} present`,
        `Global config: ${status.globalConfig ? "present" : "absent"}; project config: ${status.projectConfig ? "present" : "absent"}`,
        "",
        "Dependencies (read-only, no network):",
    ];
    for (const row of check.components) {
        lines.push(`  ${row.component}: installed=${row.installed ?? "-"} status=${row.status}`);
    }
    return lines;
}
function setupLines(result) {
    const phases = result.setup;
    if (!phases)
        return [`Setup stopped at stage: ${result.stage}.`];
    const lines = [];
    lines.push(`Registration: ${phases.registration.action}${phases.registration.detail ? ` (${phases.registration.detail})` : ""}`);
    lines.push(phases.sync.ok ? `Sync: ${phases.sync.output ?? "ok"}` : `Sync: ${phases.sync.error ?? "failed"}`);
    if (phases.config) {
        lines.push(phases.config.detail
            ? `Config: failed, ${phases.config.detail}`
            : `Config: ${phases.config.changed ? "updated" : "unchanged"} ${phases.config.path}`);
    }
    if (phases.agents) {
        lines.push(phases.agents.detail
            ? `Agents: failed, ${phases.agents.detail}`
            : `Agents: ${phases.agents.written} written, ${phases.agents.unchanged} unchanged (${phases.agents.dir})`);
    }
    if (phases.dependencies) {
        lines.push(`Dependencies: ${phases.dependencies.ok ? "ok" : "reported failures"}`);
        lines.push(...phases.dependencies.report.split("\n").map((line) => `  ${line}`));
    }
    lines.push(result.ok ? "Setup completed." : `Setup stopped at stage: ${result.stage}.`);
    return lines;
}
/** Read-only preview for optional installs: refused while required components are missing. */
export function optionalPreview(integrations) {
    const optional = integrations.missingOptional;
    if (integrations.missingRequired.length > 0) {
        return {
            action: "check-optional",
            ok: true,
            applicable: false,
            lines: [
                `Required dependencies are missing: ${integrations.missingRequired.join(", ")}.`,
                "Install them with Run setup / reconciliation first. Optional installs are offered only when required dependencies are present.",
            ],
        };
    }
    if (optional.length === 0) {
        return { action: "check-optional", ok: true, applicable: false, lines: ["All optional dependencies are already present."] };
    }
    const lines = [`Optional dependencies not installed: ${optional.join(", ")}.`, "Installing is opt-in: press A to review and confirm.", ""];
    for (const entry of integrations.entries) {
        if (entry.component && optional.includes(entry.component))
            lines.push(`${entry.component}: ${entry.mechanism ?? "no mechanism defined"}`);
    }
    for (const component of optional) {
        lines.push(`${component}: install only with consent (aria setup --install-optional ${component}).`);
    }
    return { action: "check-optional", ok: true, applicable: true, lines };
}
/** Real services: each member calls the existing ARIA capability. */
export function createConsoleServices(options) {
    const { worktree, binaryUrl } = options;
    const executor = options.executor ?? defaultExecutor;
    /** One read-only inventory pass shared by the integration views. */
    const loadIntegrations = async (discoverProviders = false) => {
        const check = await checkUpgradeInventory(executor, { availableOverride: null, discoverProviders });
        const integrations = await discoverIntegrations(executor, { inventory: check });
        return { check, integrations };
    };
    const run = async (action) => {
        try {
            switch (action) {
                case "inspect": {
                    const check = await checkUpgradeInventory(undefined, { availableOverride: null });
                    return { action, ok: true, lines: inspectionLines(check, readMenuStatus(worktree)) };
                }
                case "setup": {
                    // Mirrors `aria setup` exactly, minus the retired --configure phase.
                    const result = await setup(binaryUrl, undefined, undefined, {
                        configure: false,
                        worktree,
                        tty: false,
                        dependenciesFn: async (executor, configDir) => runSetupDependencies(executor, { configDir }),
                    });
                    return { action, ok: result.ok, lines: setupLines(result) };
                }
                case "doctor": {
                    const report = await runDoctor({ worktree });
                    return { action, ok: true, lines: [], findings: report.findings };
                }
                case "plugins": {
                    const { integrations } = await loadIntegrations();
                    return { action, ok: true, lines: [], entries: integrations.entries };
                }
                case "check-optional": {
                    const { integrations } = await loadIntegrations();
                    return optionalPreview(integrations);
                }
                case "apply-optional": {
                    const { integrations } = await loadIntegrations();
                    if (integrations.missingRequired.length > 0) {
                        return {
                            action,
                            ok: false,
                            lines: [`Required dependencies are missing (${integrations.missingRequired.join(", ")}); install them with Run setup first. No changes were made.`],
                        };
                    }
                    const selected = integrations.missingOptional.filter((component) => OPTIONAL_INSTALL_COMPONENTS.includes(component));
                    if (selected.length === 0) {
                        return { action, ok: true, lines: ["No optional dependency is missing; nothing was changed."] };
                    }
                    const result = await runSetupDependencies(executor, { optionalInstalls: selected });
                    return { action, ok: result.ok, lines: result.report.split("\n") };
                }
                case "check-aria": {
                    const check = await checkUpgradeInventory();
                    const available = check.available.kind === "known" ? check.available.target : undefined;
                    const applicable = !check.selfUpgradeBlocked && available !== undefined && available.version !== check.currentVersion;
                    const lines = formatUpgradeCheck(check).split("\n");
                    if (check.blockReason)
                        lines.push("", `Blocked: ${check.blockReason}`);
                    if (applicable)
                        lines.push("", "Console: press A to approve this target through the same confirmed upgrade path. The npm command above is the equivalent manual approval.");
                    return { action, ok: true, lines, applicable };
                }
                case "apply-aria": {
                    // Same authorization path as `aria upgrade --yes`: explicit approval is
                    // passed only after the user confirmed in the console.
                    const result = await runUpgrade(undefined, {
                        approval: { yes: true },
                        selfUpgradeFn: (target, handoff) => selfUpgradeAria(target, handoff),
                    });
                    return { action, ok: result.ok, lines: formatUpgradeResult(result).split("\n") };
                }
                case "check-deps": {
                    const { check, integrations } = await loadIntegrations(true);
                    const applicable = check.components.some((row) => row.component !== "aria" && (row.status === "provider-upgrade-available" || row.status === "upgrade-available"));
                    const lines = [...formatDepsUpgradeProposal(check).split("\n"), "", ...formatIntegrationProposal(integrations).split("\n")];
                    return { action, ok: true, lines, applicable };
                }
                case "apply-deps": {
                    const applied = await runDepsUpgrades();
                    return { action, ok: applied.ok, lines: applied.report.split("\n") };
                }
            }
        }
        catch (error) {
            return { action, ok: false, lines: [describe(error)] };
        }
    };
    return {
        menuStatus: () => readMenuStatus(worktree),
        loadModelSnapshot: () => loadModelManagerSnapshot(worktree),
        discoverModels: async () => (await discoverAvailableModels(worktree)).models,
        saveModels: (pending) => saveFromManager(worktree, pending, {}),
        run,
    };
}
/**
 * Run the console until the user quits. Returns the process exit code.
 * Terminal state is restored by Ink on unmount; the unmount is also done in a
 * finally block so an error during rendering still leaves the terminal clean.
 */
export async function runManagementConsole(options) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    if (stdin.isTTY !== true || stdout.isTTY !== true) {
        console.error(NON_TERMINAL_HELP_NOTE);
        return 1;
    }
    const services = options.services ?? createConsoleServices(options);
    let instance;
    try {
        instance = render(h(ManagementConsoleApp, {
            services,
            initialStatus: services.menuStatus(),
            onExit: () => {
                instance?.unmount();
            },
        }), { stdin, stdout, exitOnCtrlC: false, patchConsole: false });
        await instance.waitUntilExit();
    }
    catch (error) {
        console.error(`aria: management console failed: ${describe(error)}`);
        return 1;
    }
    finally {
        instance?.unmount();
    }
    // A read-only check still in flight finishes on its own; the console never forces exit.
    return 0;
}
//# sourceMappingURL=management-console.js.map