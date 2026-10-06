#!/usr/bin/env node

// ARIA CLI — dependency-free, Node standard library only.
// Supported: aria setup [--configure], aria configure, aria update, aria deps sync, aria doctor, aria routes, aria --help

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
  aria setup                 Register ARIA with OpenCode and synchronize dependencies
  aria setup --configure     Then interactively configure ARIA role models
  aria setup --plugin-spec <spec>  Register a Git package specifier (e.g. github:mscipio/ARIA#<SHA>) instead of the local checkout
  aria configure             Interactively configure ARIA role models only (no registration or sync)
  aria update                Pull latest changes, reinstall, and re-sync dependencies
  aria deps sync             Synchronize required dependencies (Engram, Context7, CodeGraph)
  aria doctor                Read-only health check of ARIA (package, config, routes/models, integrations, skills, ZotPilot, Wiki)
  aria routes                Print resolved model routes for each ARIA role
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
    const subcommand = args[1];
    if (subcommand !== "sync") {
      console.error(`Unknown deps subcommand: ${subcommand}`);
      console.error("Usage: aria deps sync");
      return 1;
    }

    const { depsSync, formatSyncResult } = await import("../dist/deps.js");
    const result = await depsSync();
    console.log(formatSyncResult(result));
    return result.ok ? 0 : 1;
  }

  if (command === "doctor") {
    const { runDoctor, formatDoctorReport, doctorExitCode } = await import("../dist/doctor.js");
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    return doctorExitCode(report.findings);
  }

  if (command === "configure") {
    // Configure-only: no trailing operands or options. Runs model
    // configuration directly without registration or dependency sync.
    const unexpected = args.slice(1);
    if (unexpected.length > 0) {
      console.error(`Unknown configure option: ${unexpected.join(" ")}`);
      console.error("Usage: aria configure");
      return 1;
    }

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
    const result = await setup(import.meta.url, undefined, undefined, {
      configure: configureRequested,
      pluginSpec,
      worktree: process.cwd(),
      input: process.stdin,
      output: process.stdout,
      tty: process.stdin.isTTY === true,
    });

    if (result.setup) {
      const { registration, sync, config, agents, model } = result.setup;

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
    const { update } = await import("../dist/lifecycle.js");
    const result = await update(import.meta.url);

    if (result.update) {
      const { git, npm, handoff } = result.update;

      // Git operations
      if (git.ok) {
        console.log("git: [OK]");
      } else {
        const label = result.stage === "git_pull" ? "git pull --ff-only" : "git precondition";
        console.error(`${label}: [FAIL] ${git.error || "git operation failed"}`);
      }

      // npm ci --omit=dev
      if (npm.ok) {
        console.log("npm ci --omit=dev: [OK]");
      } else {
        console.error(`npm ci --omit=dev: [FAIL] ${npm.error || "npm install failed"}`);
      }

      // Handoff — aria deps sync in updated checkout
      if (handoff.ok) {
        console.log(`handoff (aria deps sync): [OK] exit=0`);
        if (handoff.stdout) console.log(handoff.stdout);
      } else if (handoff.error) {
        console.error(`handoff (aria deps sync): [FAIL] exit=${handoff.exitCode ?? "?"}`);
        if (handoff.stderr) console.error(handoff.stderr);
        // Also show sync subprocess exit status and output when available
        if (handoff.exitCode !== null) {
          console.error(`  sync subprocess exit code: ${handoff.exitCode}`);
        }
        if (handoff.stdout) {
          console.error(`  sync subprocess output: ${handoff.stdout}`);
        }
      }
    }

    if (!result.ok) {
      console.error(`Stage failed: ${result.stage}`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === "routes") {
    try {
      const { formatRoutes } = await import("../dist/routes.js");
      console.log(formatRoutes());
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run 'aria --help' for usage.");
  return 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
