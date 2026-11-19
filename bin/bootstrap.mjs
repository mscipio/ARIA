#!/usr/bin/env node
// First-install bootstrap: verifies and installs an ARIA release tarball before any npm packages
// exist (Node built-ins only), writes the `aria` launcher, then runs that release's own setup.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`ARIA needs Node.js >= 22.18 (found ${process.versions.node}).`);
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { bootstrap } = await import(pathToFileURL(join(root, "src", "manager", "bootstrap.ts")).href);
process.exitCode = await bootstrap(process.argv.slice(2));
