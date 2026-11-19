import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./env.ts";
import type { Step } from "./types.ts";

/**
 * Playwright browser readiness for the ARIA-managed `@playwright/mcp` copy, resolved through that
 * copy's own `playwright-core` (never a global one), with ARIA's browser directory:
 *
 *   package    the managed copy has playwright-core and its browsers.json
 *   files      <browsers>/chromium-<revision> exists, for the revision that playwright-core pins
 *   install    Playwright's own INSTALLATION_COMPLETE marker is in that directory
 *   executable the path playwright-core resolves exists and is executable
 *   launch     (optional) a headless launch with channel `chrome-for-testing`, which is what
 *              `playwright-mcp --browser chromium` uses, then a clean close
 *
 * A directory whose name starts with "chromium" is not evidence of anything on its own.
 */

export interface BrowserCheck {
  readonly ok: boolean;
  /** The last level reached. */
  readonly level: "none" | "package" | "files" | "install" | "executable" | "launch";
  readonly steps: readonly Step[];
  readonly revision?: string;
  readonly executable?: string;
}

const RESOLVE = `
const core = process.argv[1];
const mode = process.argv[2];
(async () => {
  const pw = require(core);
  const out = { executable: pw.chromium.executablePath() };
  if (mode === "launch") {
    const b = await pw.chromium.launch({ headless: true, channel: "chrome-for-testing", timeout: 30000 });
    out.version = b.version();
    await b.close();
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.message || e).split("\\n").slice(0, 3).join(" ")); process.exit(1); });
`;

/** Static part of the check (no process started): revision pinned, directory present, marker present. */
export function browserInstalled(toolPath: string, browsersDir: string): { ok: boolean; detail: string } {
  try {
    const browsers = JSON.parse(readFileSync(join(toolPath, "node_modules", "playwright-core", "browsers.json"), "utf8")) as { browsers?: { name?: string; revision?: string }[] };
    const revision = browsers.browsers?.find((b) => b.name === "chromium")?.revision;
    if (!revision) return { ok: false, detail: "playwright-core names no chromium revision" };
    const dir = join(browsersDir, `chromium-${revision}`);
    if (!existsSync(dir)) return { ok: false, detail: `chromium ${revision} not downloaded` };
    if (!existsSync(join(dir, "INSTALLATION_COMPLETE"))) return { ok: false, detail: `chromium ${revision} download incomplete (no INSTALLATION_COMPLETE)` };
    return { ok: true, detail: `chromium ${revision} installed in ${dir}` };
  } catch (error) {
    return { ok: false, detail: `managed Playwright copy unreadable: ${(error as Error).message}` };
  }
}

export async function checkBrowser(toolPath: string, browsersDir: string, opts: { launch: boolean; timeoutMs?: number }): Promise<BrowserCheck> {
  const steps: Step[] = [];
  const done = (level: BrowserCheck["level"], ok: boolean, extra: Partial<BrowserCheck> = {}): BrowserCheck => ({ ok, level, steps, ...extra });
  const core = join(toolPath, "node_modules", "playwright-core");
  let revision: string | undefined;
  try {
    const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers?: { name?: string; revision?: string }[] };
    revision = browsers.browsers?.find((b) => b.name === "chromium")?.revision;
    if (!revision) throw new Error("browsers.json names no chromium revision");
    steps.push({ name: "playwright-core in the managed copy", status: "done", detail: `${core} pins chromium revision ${revision}` });
  } catch (error) {
    steps.push({ name: "playwright-core in the managed copy", status: "failed", detail: `${core}: ${(error as Error).message}` });
    return done("none", false);
  }
  const dir = join(browsersDir, `chromium-${revision}`);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory");
    steps.push({ name: "browser files", status: "done", detail: dir });
  } catch (error) {
    steps.push({ name: "browser files", status: "failed", detail: `${dir}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "not downloaded" : (error as Error).message}` });
    return done("package", false, { revision });
  }
  if (!existsSync(join(dir, "INSTALLATION_COMPLETE"))) {
    steps.push({ name: "browser installation complete", status: "failed", detail: `no INSTALLATION_COMPLETE marker in ${dir}: the download was interrupted or is still running` });
    return done("files", false, { revision });
  }
  steps.push({ name: "browser installation complete", status: "done", detail: "INSTALLATION_COMPLETE present" });
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };
  const resolved = await run(process.execPath, ["-e", RESOLVE, core, "resolve"], { env, timeoutMs: 30_000 });
  let executable: string | undefined;
  try {
    executable = (JSON.parse(resolved.stdout) as { executable?: string }).executable || undefined;
  } catch {
    /* reported below */
  }
  if (!resolved.ok || !executable) {
    steps.push({ name: "browser executable", status: "failed", detail: `playwright-core could not resolve it: ${(resolved.stderr || resolved.error || "no answer").trim().slice(0, 200)}` });
    return done("install", false, { revision });
  }
  try {
    accessSync(executable, constants.X_OK);
    if (!executable.startsWith(dir)) throw new Error(`resolves outside ${dir}`);
    steps.push({ name: "browser executable", status: "done", detail: executable });
  } catch (error) {
    steps.push({ name: "browser executable", status: "failed", detail: `${executable}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (error as Error).message}` });
    return done("install", false, { revision, executable });
  }
  if (!opts.launch) return done("executable", true, { revision, executable });
  const launched = await run(process.execPath, ["-e", RESOLVE, core, "launch"], { env, timeoutMs: opts.timeoutMs ?? 60_000 });
  if (!launched.ok) {
    const why = (launched.stderr || launched.error || "").trim().slice(0, 300);
    const host = /shared librar|libnss|libatk|cannot open shared object|sandbox/i.test(why) ? " (the host lacks something the browser needs; this is an environment limitation, not a broken download)" : "";
    steps.push({ name: "headless launch", status: "failed", detail: `${why || "launch failed"}${host}` });
    return done("executable", false, { revision, executable });
  }
  let version = "";
  try {
    version = (JSON.parse(launched.stdout) as { version?: string }).version ?? "";
  } catch {
    /* version is informative only */
  }
  steps.push({ name: "headless launch", status: "done", detail: `launched and closed ${version ? `Chromium ${version}` : "the browser"}` });
  return done("launch", true, { revision, executable });
}
