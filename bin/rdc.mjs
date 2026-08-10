#!/usr/bin/env node

// Review-Driven Coding CLI — dependency-free, Node standard library only.
// Supported: rdc deps sync, rdc doctor, rdc routes, rdc --help

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
  return `Review-Driven Coding CLI v${version}

Usage:
  rdc deps sync   Synchronize required dependencies (Engram, Context7, CodeGraph)
  rdc doctor      Report status of required dependencies
  rdc routes      Print resolved model routes for each RDC role
  rdc --help      Show this help message
  rdc -h          Show this help message
  rdc --version   Show version
  rdc -v          Show version`;
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
      console.error("Usage: rdc deps sync");
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
  console.error("Run 'rdc --help' for usage.");
  return 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
