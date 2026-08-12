import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AriaDefaults } from "./types.js";

export function getPackageRoot(metaUrl: string = import.meta.url): string {
  const currentFile = fileURLToPath(metaUrl);
  return resolve(dirname(currentFile), "..");
}

export function loadDefaultConfig(metaUrl: string = import.meta.url): AriaDefaults {
  const packageRoot = getPackageRoot(metaUrl);
  const configPath = resolve(packageRoot, "defaults", "aria.defaults.json");

  return JSON.parse(readFileSync(configPath, "utf8")) as AriaDefaults;
}
