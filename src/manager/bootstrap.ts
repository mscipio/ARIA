import { join } from "node:path";
import { existingRelease, finalize, inspect, installPackages, smokeTest, stage, removeStaging, readCurrent, writeCurrent, writeLaunchers, type Source } from "./release.ts";
import { ariaHome, run } from "./env.ts";
import { readState, withLock, writeState } from "./state.ts";
import { IDENTITY_ALGORITHM } from "./inventory.ts";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/**
 * First install from a release tarball, before any ARIA npm packages exist. Uses only Node built-ins
 * (release.ts, archive.ts, state.ts, env.ts), so it runs from a freshly unpacked package:
 *
 *   node bin/bootstrap.mjs --from aria-<v>.tgz [--sha256 <hex>] [setup options…] [--yes]
 *
 * It verifies and installs the release into ARIA_HOME/releases/<v> (sha256, member validation,
 * `npm ci` from the lockfile, smoke test, compatibility check by the release itself), writes the
 * `aria` launcher, and then hands over to that release's own `aria setup --release`, which
 * registers the plugin and handles --with. Without --yes it stops after printing the plan.
 */

const help = `node bin/bootstrap.mjs --from <aria-<version>.tgz|dir> [--sha256 <hex>] [--scope global|project] [--with ids] [--link-bin] [--yes]`;

export async function bootstrap(argv: string[]): Promise<number> {
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = at("--from");
  if (!from) {
    console.error(help);
    return 2;
  }
  const yes = argv.includes("--yes");
  let source: Source;
  try {
    source = inspect(from, at("--sha256"));
  } catch (error) {
    console.error(`bootstrap: ${(error as Error).message}`);
    return 1;
  }
  const rest = argv.filter((a, i) => !["--from", "--sha256"].includes(a) && !["--from", "--sha256"].includes(argv[i - 1] ?? ""));
  console.log(`ARIA ${source.version} from ${source.path} (${source.integrity})`);
  console.log(`  1. stage and verify into ${join(ariaHome(), "releases", source.version)} (npm ci from lockfile: network)`);
  console.log(`  2. launcher ${join(ariaHome(), "bin", "aria")} -> that release`);
  console.log(`  3. aria setup --release ${rest.join(" ")}`);
  if (!yes) {
    console.log("\nPreview only. Re-run with --yes to install.");
    return 3;
  }
  const progress = (m: string) => console.error(`  … ${m}`);
  let dir: string;
  try {
    dir = await withLock(async () => {
      const existing = existingRelease(source); // identical → reuse; different content → conflict
      if (existing) {
        progress(`release ${source.version} already installed with identical content`);
        if (!readCurrent()) writeCurrent(existing);
        writeLaunchers();
        return existing;
      }
      const staged = stage(source, progress);
      try {
        await installPackages(staged.staging.path, progress);
        await smokeTest(staged.staging.path, staged.version);
        const r = await run(process.execPath, [join(staged.staging.path, "bin", "aria.mjs"), "reconcile", "--json"], { timeoutMs: 60_000, env: { ...process.env, ARIA_NO_UI: "1" } });
        const rec = JSON.parse(r.stdout || '{"blocking":["no answer"],"advisory":[]}') as { blocking: string[]; advisory: string[] };
        if (rec.blocking.length && !argv.includes("--force")) throw new Error(`release ${source.version} does not fit this environment: ${rec.blocking.join("; ")}`);
        for (const a of rec.advisory) console.error(`  advisory: ${a}`);
        const final = finalize(staged, progress);
        const s = readState().state;
        if (!s.releases.some((x) => x.version === source.version)) s.releases.push({ version: source.version, path: final, installedAt: new Date().toISOString(), source: source.path, digest: staged.digest, identityAlgorithm: IDENTITY_ALGORITHM, ...(source.sha256 ? { sha256: source.sha256 } : {}) });
        writeState(s);
        if (!readCurrent()) writeCurrent(final);
        writeLaunchers();
        return final;
      } catch (error) {
        if (existsSync(staged.staging.path)) {
          try {
            removeStaging(staged.staging.path);
          } catch {
            /* aria repair */
          }
        }
        throw error;
      }
    });
  } catch (error) {
    console.error(`bootstrap: ${(error as Error).message}`);
    return (error as Error).name === "BlockedError" ? 4 : 1;
  }
  console.log(`installed ${basename(dir)} at ${dir}; continuing with its own setup`);
  const r = await run(process.execPath, [join(dir, "bin", "aria.mjs"), "setup", "--release", "--from", dir, ...rest], { timeoutMs: 3_600_000, env: { ...process.env, ARIA_NO_UI: "1" }, onLine: (l) => console.log(l) });
  if (r.stderr.trim()) console.error(r.stderr.trim());
  return r.code ?? 1;
}
