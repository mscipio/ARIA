import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackageRoot } from "./defaults.js";
import { openCodeGlobalDir } from "./paths.js";
const NAMES = ["aria-push", "aria-release"];
function hash(body) { return createHash("sha256").update(body).digest("hex"); }
function bodyOf(text) { return text.split("---").slice(2).join("---").replace(/^\n/, ""); }
export function parseManagedHeader(text) {
    const version = text.match(/^# aria-version: (.+)$/m)?.[1];
    const checksum = text.match(/^# aria-checksum: ([0-9a-f]{64})$/m)?.[1];
    return text.includes("# ARIA-managed command") && version && checksum ? { version, checksum } : null;
}
export function isAriaManaged(text) { return parseManagedHeader(text) !== null; }
export function verifyManagedContent(text) {
    const header = parseManagedHeader(text);
    return !!header && header.checksum === hash(bodyOf(text));
}
export function generateCommandFiles(version = readPackageVersion()) {
    const root = getPackageRoot(import.meta.url);
    return Object.fromEntries(NAMES.map((name) => {
        const source = readFileSync(join(root, "defaults", "commands", `${name}.md`), "utf8");
        const body = bodyOf(source);
        const rendered = source.replace(/^# aria-version: .*$/m, `# aria-version: ${version}`).replace(/^# aria-checksum: .*$/m, `# aria-checksum: ${hash(body)}`);
        return [name, rendered];
    }));
}
function readPackageVersion() { return JSON.parse(readFileSync(join(getPackageRoot(import.meta.url), "package.json"), "utf8")).version; }
export function defaultCommandsDir(explicit) { return join(openCodeGlobalDir(explicit), "commands"); }
async function atomic(path, text) { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; try {
    await writeFile(tmp, text, { flag: "wx" });
    await rename(tmp, path);
}
catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
} }
async function existing(path) { try {
    return await readFile(path, "utf8");
}
catch (e) {
    if (e.code === "ENOENT")
        return undefined;
    throw e;
} }
export async function rollbackCommandInstall(dir, r) { for (const name of r.written) {
    const path = join(dir, `${name}.md`);
    if (r.backups[name])
        await rename(r.backups[name], path);
    else if (r.previousContents[name] !== undefined)
        await atomic(path, r.previousContents[name]);
    else
        await unlink(path).catch(() => undefined);
} }
export async function installCommandFiles(options = {}) { const dir = options.dir ?? defaultCommandsDir(); const version = options.version ?? readPackageVersion(); const wanted = generateCommandFiles(version); await mkdir(dir, { recursive: true }); const r = { dir, version, written: [], unchanged: [], tampered: [], backups: {}, previousContents: {} }; try {
    for (const name of NAMES) {
        const path = join(dir, `${name}.md`), old = await existing(path);
        if (old === wanted[name]) {
            r.unchanged.push(name);
            continue;
        }
        if (old !== undefined && isAriaManaged(old)) {
            if (!verifyManagedContent(old))
                r.tampered.push(name);
            r.previousContents[name] = old;
        }
        else if (old !== undefined) {
            const backup = `${path}.aria-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
            await rename(path, backup);
            r.backups[name] = backup;
        }
        r.written.push(name);
        await atomic(path, wanted[name]);
    }
}
catch (e) {
    await rollbackCommandInstall(dir, r).catch(() => undefined);
    e.partialResult = r;
    throw e;
} return r; }
export async function reconcileManagedCommands(options = {}) {
    const dir = options.dir ?? defaultCommandsDir(), version = options.version ?? readPackageVersion(), wanted = generateCommandFiles(version);
    for (const name of NAMES) {
        const path = join(dir, `${name}.md`);
        try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error(`Managed-command conflict at ${path}: not a regular file`);
            const old = await readFile(path, "utf8");
            if (old !== wanted[name] && !isAriaManaged(old))
                throw new Error(`Managed-command conflict at ${path}: unowned file`);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
    }
    return installCommandFiles({ dir, version });
}
//# sourceMappingURL=commands.js.map