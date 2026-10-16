#!/usr/bin/env node

// ARIA CLI — dependency-free, Node standard library only.
// Public surface (v1.1.0 T002): aria setup, aria doctor, aria upgrade
// [--check], aria models [--config], aria deps [--upgrade], aria --help,
// aria --version. Legacy top-level `update`/`configure`/`routes`/`deps sync`
// are retired (rejected with guidance); `--migrate-from`/`--handoff-json`
// remain accepted as internal handoff switches but are not advertised.
//
// T005 production contract: a bare `aria` invocation uses its globally
// installed package/assets (this file's `../dist/*` and `../package.json`,
// resolved relative to the running install) and never infers or requires
// the dev checkout. Development remains `node ./bin/aria.mjs` or the
// repository-local npm script; `process.cwd()` selects the invocation
// worktree where appropriate (setup worktree, `models --config`). No
// `npm link`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_JSON_PATH = resolve(__dirname, "..", "package.json");

function loadVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage() {
  const version = loadVersion();
  return `ARIA CLI v${version}

Usage:
  aria setup                 Register ARIA with OpenCode and install missing dependencies (idempotent; never upgrades present deps)
  aria setup --configure     Then interactively configure ARIA role models
  aria setup --plugin-spec <spec>  Register a Git package specifier (e.g. github:mscipio/ARIA#<SHA>) instead of the local checkout
  aria doctor                Read-only health check of ARIA (package, config, routes/models, integrations, skills, ZotPilot, Wiki)
  aria upgrade               Show upgrade inventory (requires --yes to approve any mutation; ARIA-only)
  aria upgrade --check        Read-only upgrade inventory (current + available releases, component table)
  aria upgrade --yes          Approve and run the ARIA-only upgrade pipeline
  aria models                Print resolved model routes for each ARIA role
  aria models --config       Interactively configure ARIA role models
  aria deps                  Read-only dependency inventory (plugins/MCPs with observed versions)
  aria deps --upgrade        Check managed dependencies; version upgrades require explicit confirmation (use --yes to apply)
   aria deps --upgrade --yes   Apply managed upgrades (unknown/unmanaged stay report-only)
  aria --help                Show this help message
  aria -h                    Show this help message
  aria --version             Show version
  aria -v                    Show version`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(loadVersion());
    return 0;
  }

  const command = args[0];

  if (command === "deps") {
    // T002 public surface: bare `deps` (read-only inventory). T004:
    // `deps --upgrade` checks and proposes with zero mutation (explicit
    // approval required); `deps --upgrade --yes` applies managed upgrades
    // via the existing adapters (unknown/unmanaged stay report-only).
    // Legacy `deps sync` is retired: use `aria deps`, `aria deps --upgrade`,
    // or `aria setup`.
    const rest = args.slice(1);
    if (rest.length === 1 && (rest[0] === "sync" || rest[0] === "synchronize")) {
      console.error("aria deps sync is retired; use `aria deps` (read-only inventory), `aria deps --upgrade` (managed upgrades), or `aria setup` (install missing).");
      console.error("Usage: aria deps [--upgrade [--yes]]");
      return 1;
    }
    let upgrade = false;
    let yes = false;
    for (const arg of rest) {
      if (arg === "--upgrade") {
        upgrade = true;
        continue;
      }
      if (arg === "--yes") {
        yes = true;
        continue;
      }
      console.error(`Unknown deps option: ${arg}`);
      console.error("Usage: aria deps [--upgrade [--yes]]");
      return 1;
    }
    if (yes && !upgrade) {
      console.error("Option --yes requires --upgrade (explicit confirmation applies only to managed dependency upgrades)");
      console.error("Usage: aria deps [--upgrade [--yes]]");
      return 1;
    }

    try {
      const { checkUpgradeInventory, formatDepsUpgradeProposal } = await import("../dist/upgrade.js");
      // Read-only inventory without the ARIA remote probe (pinned unknown:
      // no `git ls-remote`, never any installer/updater).
      const result = await checkUpgradeInventory(undefined, { availableOverride: null });
      const rows = result.components.filter((row) => row.component !== "aria");
      if (!upgrade) {
        const lines = ["ARIA dependency inventory (read-only; no changes were made)", ""];
        for (const row of rows) {
          lines.push(`  ${row.component}: installed=${row.installed ?? "-"} available=${row.available ?? "-"} status=${row.status} — ${row.detail}`);
        }
        console.log(lines.join("\n"));
        return 0;
      }
      if (!yes) {
        // T004 proposal: the inventoried rows re-rendered as an upgrade
        // proposal with zero mutation — re-run with --yes to apply managed
        // upgrades. Unknown/unmanaged targets stay report-only either way.
        console.log(formatDepsUpgradeProposal(result));
        return 1;
      }
      // T004 confirmed: managed-only upgrades via the existing adapters.
      // Each adapter upgrades only positively identified managed targets;
      // unknown/unmanaged stay report-only with zero mutation inside the
      // adapters. A dependency failure here is reported per component and
      // never touches the ARIA-only upgrade path.
      const { runDepsUpgrades } = await import("../dist/dependencies.js");
      const applied = await runDepsUpgrades();
      console.log(["ARIA dependency upgrades (explicitly approved; unknown/unmanaged stay report-only)", "", applied.report].join("\n"));
      return applied.ok ? 0 : 1;
    } catch (err) {
      console.error(`Dependencies: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "doctor") {
    const { runDoctor, formatDoctorReport, doctorExitCode } = await import("../dist/doctor.js");
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    return doctorExitCode(report.findings);
  }

  if (command === "configure") {
    console.error("aria configure is retired; use `aria models --config` (interactively configure ARIA role models).");
    console.error("Usage: aria models [--config]");
    return 1;
  }

  if (command === "models") {
    // T002 surface gating for the T003-owned forms: `models` prints the
    // resolved routes via the existing implementation; `models --config`
    // runs the existing interactive workflow (no registration or sync).
    // T003 refines output without dispatcher rework.
    const rest = args.slice(1);
    if (rest.length === 0) {
      try {
        const { formatRoutes } = await import("../dist/routes.js");
        console.log(formatRoutes());
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }
    if (rest.length === 1 && rest[0] === "--config") {
      try {
        const { configureModels } = await import("../dist/model-config.js");
        const result = await configureModels(process.cwd());

        if (result.status === "configured") {
          console.log(`Model configuration: [OK] ${result.message}`);
          return 0;
        }
        if (result.status === "unchanged") {
          console.log(`Model configuration: unchanged. ${result.message}`);
          return 0;
        }
        if (result.status === "skipped") {
          console.log(`Model configuration: skipped. ${result.message}`);
          return 0;
        }
        console.error(`Model configuration: [FAIL] ${result.error || result.message}`);
        return 1;
      } catch (err) {
        console.error(`Model configuration: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    console.error(`Unknown models option: ${rest.join(" ")}`);
    console.error("Usage: aria models [--config]");
    return 1;
  }

  if (command === "setup") {
    // Accepted setup options: --configure and --plugin-spec <spec> (T012
    // Git-package source: passed verbatim to `opencode plugin add`, never
    // rewritten to a file:// URI, never given --global). Anything else is
    // rejected before any registration, file write, or sync.
    const rest = args.slice(1);
    let configureRequested = false;
    let pluginSpec;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--configure") {
        configureRequested = true;
        continue;
      }
      if (arg === "--plugin-spec") {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) {
          console.error("Missing value for --plugin-spec (expected a Git package specifier such as github:mscipio/ARIA#<EXACT_SHA>)");
          console.error("Usage: aria setup [--configure] [--plugin-spec <spec>]");
          return 1;
        }
        pluginSpec = value;
        index++;
        continue;
      }
      if (arg.startsWith("--plugin-spec=")) {
        const value = arg.slice("--plugin-spec=".length);
        if (value.length === 0) {
          console.error("Missing value for --plugin-spec (expected a Git package specifier such as github:mscipio/ARIA#<EXACT_SHA>)");
          console.error("Usage: aria setup [--configure] [--plugin-spec <spec>]");
          return 1;
        }
        pluginSpec = value;
        continue;
      }
      console.error(`Unknown setup option: ${arg}`);
      console.error("Usage: aria setup [--configure] [--plugin-spec <spec>]");
      return 1;
    }

    const { setup } = await import("../dist/lifecycle.js");
    const { runSetupDependencies } = await import("../dist/dependencies.js");
    const result = await setup(import.meta.url, undefined, undefined, {
      configure: configureRequested,
      pluginSpec,
      worktree: process.cwd(),
      input: process.stdin,
      output: process.stdout,
      tty: process.stdin.isTTY === true,
      // T017: invoke the shared dependency lifecycle directly (no ARIA
      // self-upgrade handoff on the setup path). R001: no depsSync seam is
      // provided, so production setup is install-if-missing only — no
      // version-chasing sync ever runs here.
      dependenciesFn: async (executor, configDir) => runSetupDependencies(executor, { configDir }),
    });

    if (result.setup) {
      const { registration, sync, config, agents, dependencies, model } = result.setup;

      // Registration
      if (registration.action === "registered") {
        console.log(`Registration: [OK] plugin registered`);
      } else if (registration.action === "already registered") {
        console.log(`Registration: plugin already registered`);
        if (registration.detail) console.log(`  ${registration.detail}`);
      } else {
        console.error(`Registration: [FAIL] ${registration.detail || "registration failed"}`);
      }

      // Sync
      if (sync.ok) {
        console.log(`Sync: [OK] ${sync.output || "all dependencies synchronized"}`);
      } else if (sync.error) {
        console.error(`Sync: [FAIL] ${sync.error}`);
      }

      // Shared dependency lifecycle (T017): direct adapter invocation, no handoff.
      if (dependencies) {
        if (dependencies.ok) {
          console.log(`Dependencies: [OK] shared lifecycle completed`);
        } else {
          console.error(`Dependencies: [FAIL] shared lifecycle reported failures`);
        }
        for (const outcome of dependencies.outcomes ?? []) {
          const flag = outcome.status === "completed" ? "[OK]" : outcome.status === "skipped" ? "[SKIP]" : "[FAIL]";
          if (outcome.status === "completed") {
            console.log(`  ${outcome.component}: ${flag} ${outcome.detail}`);
          } else if (outcome.status === "skipped") {
            console.log(`  ${outcome.component}: ${flag} ${outcome.detail}`);
          } else {
            console.error(`  ${outcome.component}: ${flag} ${outcome.detail}`);
          }
        }
      }

      // Global V2 config (T008): exact plugin URI, single skills root,
      // depth default 3; unrelated user keys preserved, backup on replace.
      if (config) {
        if (config.detail) {
          console.error(`Config: [FAIL] ${config.detail}`);
        } else if (config.changed) {
          console.log(`Config: [OK] ${config.path}${config.backupPath ? ` (backup: ${config.backupPath})` : " (created)"}`);
        } else {
          console.log(`Config: unchanged (${config.path})`);
        }
      }

      // Managed agent files (T008): eleven deterministic files.
      if (agents) {
        if (agents.detail) {
          console.error(`Agents: [FAIL] ${agents.detail}`);
        } else {
          console.log(`Agents: [OK] ${agents.written} written, ${agents.unchanged} unchanged (${agents.dir})`);
        }
      }

      // Model configuration (optional third phase, present only when requested)
      if (model) {
        if (model.status === "configured") {
          console.log(`Model configuration: [OK] ${model.message}`);
        } else if (model.status === "unchanged") {
          console.log(`Model configuration: unchanged. ${model.message}`);
        } else if (model.status === "skipped") {
          console.log(`Model configuration: skipped. ${model.message}`);
        } else {
          console.error(`Model configuration: [FAIL] ${model.error || model.message}`);
        }
      }
    }

    if (!result.ok) {
      console.error(`Stage failed: ${result.stage}`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === "update") {
    console.error("aria update is retired; use `aria upgrade` (ARIA-only release moves) or `aria setup` (install missing dependencies).");
    console.error("Run 'aria --help' for usage.");
    return 1;
  }

  if (command === "upgrade") {
    // T002 (v1.1.0): `upgrade` is ARIA-only (CLI, registration, agents,
    // skills/config) with read-only `--check`. Public forms are bare
    // `upgrade` (blocked without --yes), `upgrade --check`, and
    // `upgrade --yes`. `--migrate-from`/`--handoff-json` stay accepted as
    // internal handoff switches (not advertised) and never combine with
    // --check/--yes. Third-party upgrade/sync paths are never invoked here:
    // version upgrades belong exclusively to `aria deps --upgrade` (T004).
    // Anything else is rejected before any probe, registration, file write,
    // or sync.
    // T003: --migrate-from <spec> (with --yes, never with --check or
    // --handoff-json) selects the newer-CLI-owned escape: this release
    // replaces the exact installed spec and continues in-process.
    //
    // T011: --handoff-json <payload> receives an approved upgrade handoff in
    // the new release (the old release's one-shot spawn invokes it; it is not
    // run by hand). It carries its own approval via the handoff payload and
    // never combines with --check/--yes.
    const rest = args.slice(1);
    let check = false;
    let yes = false;
    let handoffJson;
    let migrateFrom;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--check") {
        check = true;
        continue;
      }
      if (arg === "--yes") {
        yes = true;
        continue;
      }
      if (arg === "--migrate-from") {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) {
          console.error("Missing value for --migrate-from (expected the exact installed spec such as github:mscipio/ARIA#v1.0.7)");
          console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
          return 1;
        }
        migrateFrom = value;
        index++;
        continue;
      }
      if (arg.startsWith("--migrate-from=")) {
        const value = arg.slice("--migrate-from=".length);
        if (value.length === 0) {
          console.error("Missing value for --migrate-from (expected the exact installed spec such as github:mscipio/ARIA#v1.0.7)");
          console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
          return 1;
        }
        migrateFrom = value;
        continue;
      }
      if (arg === "--handoff-json") {
        const value = rest[index + 1];
        if (value === undefined) {
          console.error("Missing value for --handoff-json (expected the JSON handoff payload from the approved upgrade)");
          console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
          return 1;
        }
        handoffJson = value;
        index++;
        continue;
      }
      if (arg.startsWith("--handoff-json=")) {
        const value = arg.slice("--handoff-json=".length);
        if (value.length === 0) {
          console.error("Missing value for --handoff-json (expected the JSON handoff payload from the approved upgrade)");
          console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
          return 1;
        }
        handoffJson = value;
        continue;
      }
      console.error(`Unknown upgrade option: ${arg}`);
      console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
      return 1;
    }
    if (check && yes) {
      console.error("Options --check and --yes cannot be combined (--check is strictly read-only)");
      console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
      return 1;
    }
    if (handoffJson !== undefined && (check || yes)) {
      console.error("Option --handoff-json cannot be combined with --check or --yes (the handoff carries its own approval)");
      console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
      return 1;
    }
    if (migrateFrom !== undefined && check) {
      console.error("Option --migrate-from cannot be combined with --check (--check is strictly read-only)");
      console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
      return 1;
    }
    if (migrateFrom !== undefined && handoffJson !== undefined) {
      console.error("Option --migrate-from cannot be combined with --handoff-json (migrate carries its own from-gate)");
      console.error("Usage: aria upgrade [--check] [--yes] [--migrate-from <spec> --yes]");
      return 1;
    }

    // T002 ARIA-only post-handoff continuation: third-party components stay
    // skipped (version upgrades belong exclusively to `aria deps --upgrade`,
    // T004) and no third-party sync runs (deps-sync phase reports skipped
    // with zero mutation). Only ARIA skills normalize + managed-agent regen
    // + read-only doctor remain.
    const ariaOnlyComponents = {
      aria: async () => ({ component: "aria", status: "completed", detail: "ARIA self-upgrade completed pre-handoff; nothing remains post-handoff", mutated: false }),
      engram: async () => ({ component: "engram", status: "skipped", detail: "left untouched by ARIA-only upgrade (version upgrades belong to `aria deps --upgrade`)", mutated: false }),
      context7: async () => ({ component: "context7", status: "skipped", detail: "left untouched by ARIA-only upgrade (remote endpoint changes belong to setup/deps)", mutated: false }),
      codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "left untouched by ARIA-only upgrade (version upgrades belong to `aria deps --upgrade`)", mutated: false }),
      zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "left untouched by ARIA-only upgrade (version upgrades belong to `aria deps --upgrade`)", mutated: false }),
      quota: async () => ({ component: "quota", status: "skipped", detail: "left untouched by ARIA-only upgrade (version upgrades belong to `aria deps --upgrade`)", mutated: false }),
    };
    const ariaOnlyDepsSync = async () => ({ ok: true, detail: "deps sync skipped: upgrade is ARIA-only (third-party sync belongs to setup/deps)", mutated: false });

    if (handoffJson !== undefined) {
      try {
        const { receiveUpgradeHandoff } = await import("../dist/aria-upgrade.js");
        const { runAriaSkillsRefreshPhase, runManagedAgentRegenPhase } = await import("../dist/upgrade.js");
        const result = await receiveUpgradeHandoff(handoffJson, loadVersion(), {
          components: ariaOnlyComponents,
          // T007: post-handoff continuation refreshes a single stale owned
          // packaged skills path to the current release location with the
          // strict fail-closed phase (normalize, before regen); ambiguous
          // ownership stops as a failed phase with no write.
          normalizeFn: (ctx) => runAriaSkillsRefreshPhase(ctx),
          // T002: post-handoff continuation reconciles managed agents with
          // the strict fail-closed phase (after normalization, before
          // doctor); conflicts stop as a failed phase.
          regenFn: (ctx) => runManagedAgentRegenPhase(ctx),
          depsSyncFn: ariaOnlyDepsSync,
        });
        if (result.report) console.log(result.report);
        console.log(result.stage === "complete" ? "Upgrade: complete" : `Upgrade: stopped (${result.stage})`);
        console.log(result.detail);
        return result.ok ? 0 : 1;
      } catch (err) {
        console.error(`Upgrade: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // T003 migrate-from: this release owns the transition of the exact
    // installed spec (immutable-sender escape). Run ONLY via the exact-package
    // invocation naming the NEWER release (`npm exec --package <to-spec> --
    // aria upgrade --migrate-from <from-spec> --yes`): this dispatcher imports
    // ../dist relative to its own location, so the running code is the
    // selected release's own. Without --yes the orchestration blocks with
    // re-run guidance and zero mutation.
    if (migrateFrom !== undefined) {
      try {
        const { runMigrateUpgrade, formatMigrateResult, migrateExitCode, runAriaSkillsRefreshPhase, runManagedAgentRegenPhase } = await import("../dist/upgrade.js");
        const { migrateAriaFromExact } = await import("../dist/aria-upgrade.js");
        const result = await runMigrateUpgrade(undefined, {
          migrateFrom,
          approval: { yes },
          migrateFn: (fromSpec, target, handoff) => migrateAriaFromExact(fromSpec, target, handoff),
          // T007: in-process post-handoff continuation refreshes a single
          // stale owned packaged skills path to the current release location
          // with the strict fail-closed phase (normalize, before regen).
          // T002: in-process post-handoff continuation reconciles managed
          // agents with the strict fail-closed phase (after normalization,
          // before doctor); conflicts stop as a failed phase. Third-party
          // components and sync stay skipped (ARIA-only).
          continuation: {
            components: ariaOnlyComponents,
            normalizeFn: (ctx) => runAriaSkillsRefreshPhase(ctx),
            regenFn: (ctx) => runManagedAgentRegenPhase(ctx),
            depsSyncFn: ariaOnlyDepsSync,
          },
        });
        console.log(formatMigrateResult(result));
        return migrateExitCode(result);
      } catch (err) {
        console.error(`Migrate: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    const {
      checkUpgradeInventory,
      formatUpgradeCheck,
      formatUpgradeResult,
      runUpgrade,
      upgradeExitCode,
    } = await import("../dist/upgrade.js");

    if (check) {
      try {
        const result = await checkUpgradeInventory();
        console.log(formatUpgradeCheck(result));
        return 0;
      } catch (err) {
        console.error(`Upgrade check: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    try {
      const { selfUpgradeAria } = await import("../dist/aria-upgrade.js");
      const result = await runUpgrade(undefined, {
        approval: { yes },
        selfUpgradeFn: (target, handoff) => selfUpgradeAria(target, handoff),
        // T002: production upgrade is ARIA-only — no dependenciesFn seam, so
        // the already-current path reports with zero mutation and the
        // handoff path replaces only the ARIA registration. Third-party
        // version upgrades belong exclusively to `aria deps --upgrade`.
      });
      console.log(formatUpgradeResult(result));
      return upgradeExitCode(result);
    } catch (err) {
      console.error(`Upgrade: [FAIL] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "routes") {
    console.error("aria routes is retired; use `aria models` (print resolved model routes for each ARIA role).");
    console.error("Usage: aria models [--config]");
    return 1;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run 'aria --help' for usage.");
  return 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
