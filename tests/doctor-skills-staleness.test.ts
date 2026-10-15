import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps.js";
import { doctorExitCode, runDoctor, type DoctorOptions, type DoctorReport } from "../src/doctor.js";
import { ROLES } from "../src/routes.js";
import { defaultGlobalConfigPath } from "../src/setup-config.js";
import { getPackageSkillsRoot } from "../src/skills.js";

/**
 * T008 doctor configured-skills staleness: read-only FAIL on a positively
 * owned stale path, PASS when current or unowned, SKIP when ambiguous or
 * undeterminable — never written, never guessed.
 * Tested through the public `runDoctor` runner against the sandboxed global
 * config (`tests/setup.ts` isolates HOME/XDG_*_HOME); no live state.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Stale-shaped owned path (v1.0.7-style npx cache), never the current root. */
const STALE_SKILLS_ROOT = resolve(tmpdir(), "aria-stale-npx/_npx/aaaa1111/node_modules/aria/skills");

function stubExecutor(): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (invocation === "engram version") return { stdout: "engram 3.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph 1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return {
        stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: `unexpected probe: ${invocation}` };
  };
}

/** Worktree whose eleven routes resolve to one discovered probe model. */
async function baseOptions(): Promise<DoctorOptions & { worktree: string; agentsDir: string }> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-doctor-skills-wt-"));
  const agentsDir = await mkdtemp(resolve(tmpdir(), "aria-doctor-skills-ag-"));
  tempDirs.push(worktree, agentsDir);
  await writeFile(
    join(worktree, "aria.json"),
    JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
  );
  return {
    worktree,
    agentsDir,
    executor: stubExecutor(),
    discovery: async () => ({
      models: [{
        id: "test/probe",
        providerID: "test",
        modelID: "probe",
        name: "Probe",
        variants: [],
        variantsObservable: true,
      }],
    }),
  };
}

/** Write the sandboxed global config (healthy Context7 MCP plus a skills value). */
async function writeGlobalConfig(skills: unknown): Promise<string> {
  const configPath = defaultGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } }, skills }),
  );
  return configPath;
}

function configuredSkillsFinding(report: DoctorReport) {
  return report.findings.find((finding) => finding.area === "skills" && finding.title === "configured skills");
}

describe("T008 doctor configured-skills staleness", () => {
  it("FAILs a single positively owned stale path and changes nothing", async () => {
    const configPath = await writeGlobalConfig([STALE_SKILLS_ROOT]);
    const before = await readFile(configPath, "utf8");

    const report = await runDoctor(await baseOptions());

    const finding = configuredSkillsFinding(report);
    expect(finding?.severity).toBe("FAIL");
    expect(finding?.detail).toContain(STALE_SKILLS_ROOT);
    expect(finding?.detail).toContain(getPackageSkillsRoot());
    expect(doctorExitCode(report.findings)).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("PASSes when the current root is registered (idempotent)", async () => {
    await writeGlobalConfig([getPackageSkillsRoot()]);

    const report = await runDoctor(await baseOptions());

    const finding = configuredSkillsFinding(report);
    expect(finding?.severity).toBe("PASS");
    expect(finding?.detail).toContain("current");
  });

  it("PASSes when no owned entry exists (unrelated user paths untouched)", async () => {
    await writeGlobalConfig(["/user/skills", "https://example.com/skills"]);

    const report = await runDoctor(await baseOptions());

    const finding = configuredSkillsFinding(report);
    expect(finding?.severity).toBe("PASS");
    expect(finding?.detail).toContain("nothing stale");
  });

  it("SKIPs ambiguous ownership (stale alongside current), never guessed", async () => {
    await writeGlobalConfig([STALE_SKILLS_ROOT, getPackageSkillsRoot()]);

    const report = await runDoctor(await baseOptions());

    const finding = configuredSkillsFinding(report);
    expect(finding?.severity).toBe("SKIP");
    expect(finding?.detail).toContain("never guessed");
  });

  it("SKIPs a legacy non-array skills shape (migration-owned, never guessed)", async () => {
    await writeGlobalConfig({ paths: [STALE_SKILLS_ROOT] });

    const report = await runDoctor(await baseOptions());

    expect(configuredSkillsFinding(report)?.severity).toBe("SKIP");
  });

  it("SKIPs a missing global config (setup owns creation)", async () => {
    const configPath = defaultGlobalConfigPath();
    await rm(configPath, { force: true });
    await rm(join(dirname(configPath), "opencode.jsonc"), { force: true });

    const report = await runDoctor(await baseOptions());

    expect(configuredSkillsFinding(report)?.severity).toBe("SKIP");
  });
});
