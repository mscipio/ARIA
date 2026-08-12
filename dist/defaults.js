import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function getPackageRoot(metaUrl = import.meta.url) {
    const currentFile = fileURLToPath(metaUrl);
    return resolve(dirname(currentFile), "..");
}
export function loadDefaultConfig(metaUrl = import.meta.url) {
    const packageRoot = getPackageRoot(metaUrl);
    const configPath = resolve(packageRoot, "defaults", "aria.defaults.json");
    return JSON.parse(readFileSync(configPath, "utf8"));
}
//# sourceMappingURL=defaults.js.map