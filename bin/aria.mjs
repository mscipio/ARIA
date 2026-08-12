#!/usr/bin/env node

// ARIA CLI — dependency-free, Node standard library only.
// Supported: aria setup, aria update, aria deps sync, aria doctor, aria routes, aria --help

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
  aria setup       Register ARIA with OpenCode and synchronize dependencies
  aria update      Pull latest changes, reinstall, and re-sync dependencies
  aria deps sync   Synchronize required dependencies (Engram, Context7, CodeGraph)
  aria doctor      Report status of required dependencies
  aria routes      Print resolved model routes for each ARIA role
  aria --help      Show this help message
  aria -h          Show this help message
  aria --version   Show version
  aria -v          Show version`;
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
    const { doctor, formatDoctor, doctorExitCode } = await import("../dist/deps.js");
    const version = loadVersion();
    const status = await doctor();
    console.log(formatDoctor(version, status));
    return doctorExitCode(status);
  }

  if (command === "setup") {
    const { setup } = await import("../dist/lifecycle.js");
    const result = await setup(import.meta.url);

    if (result.setup) {
      const { registration, sync } = result.setup;

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
