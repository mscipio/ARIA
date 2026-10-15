import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentFileName,
  AgentReconciliationError,
  generateAgentFiles,
  parseManagedHeader,
  readPackageVersion,
  reconcileManagedAgents,
  ROLES,
} from "../src/agents.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";
import type { ModelDiscovery } from "../src/model-config.js";
import {
  applyArchivistRuntimeTransform,
  resolveArchivistRuntimeSystem,
} from "../src/project-overrides.js";
import { resolveAriaConfig } from "../src/overrides.js";
import {
  defaultGlobalConfigPath,
  ensureAriaSkillsRefreshFile,
  resolveSetupAriaConfig,
} from "../src/setup-config.js";
import { getPackageRoot } from "../src/defaults.js";
import { getPackageSkillsRoot, isAriaPackageSkillsPath, validateAriaSkillsConfig } from "../src/skills.js";
import { runAriaSkillsRefreshPhase } from "../src/upgrade.js";

/**
 * v1.0.14 T009 — deterministic isolated verification (temp dirs only, no
 * live workstation writes outside temp).
 *
 * Representative coverage for the T006–T008 forward fix, reusing the
 * isolated patterns from tests/managed-agent-regen.test.ts,
 * tests/t013-duplicate-dist-parity.test.ts, and the aria-upgrade fake
 * executor:
 * - two roots render identical canonical bytes+checksum (npx / checkout /
 *   extracted path-stable, no ephemeral root persisted, archivist
 *   path-stable via placeholders);
 * - runtime archivist/Wiki binding resolves in-memory without file writes;
 * - doctor agrees on canonical state and rejects tamper read-only;
 * - a representative isolated v1.0.13-style migration fixture (11 agents
 *   with the old root-baked archivist, stale v1.0.7 skills, sentinel +
 *   unrelated state) converges to the canonical 11-agent state with current
 *   skills, doctor passing, and unrelated state preserved;
 * - current state is idempotent and ambiguous ownership fails closed.
 *
 * Packed-candidate provenance (final local E2E uses the locally packed
 * tarball, not checkout dist) is verified outside this suite without a
 * version bump or commit; T010 owns the formal bump/stage/gate. Version
 * stays 1.0.14 in the tree here.
 */

const tempDirs: string[] = [];
let savedWikiDir: string | undefined;
let wikiDirSaved = false;

function saveEnv(): void {
  if (!wikiDirSaved) {
    savedWikiDir = process.env.WIKI_DIR;
    wikiDirSaved = true;
  }
}

afterEach(async () => {
  if (wikiDirSaved) {
    if (savedWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = savedWikiDir;
    wikiDirSaved = false;
  }
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  saveEnv();
  delete process.env.WIKI_DIR;
  return root;
}

/** Live-style stale npx skills root (v1.0.7-shaped, positively owned). */
function staleNpxSkills(prefix: string): string {
  return join(prefix, "_npx", "aaaa1111", "node_modules", "aria", "skills");
}

/** Executor whose read-only doctor probes all succeed (mirrors managed-agent-regen). */
function healthyDoctorExecutor(): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: "opencode 2.0.23", stderr: "" };
    if (invocation === "engram version") return { stdout: "engram v2.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph v1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return {
        stdout: [
          "opencode v1.2.3",
          "mcp:",
          "  engram     connected",
          "  context7   connected",
          "  codegraph  connected",
        ].join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: `unexpected probe: ${invocation}` };
  };
}

/** Every packaged default route model, with observable variant metadata. */
const DEFAULT_DOCTOR_MODELS: ModelDiscovery = {
  models: [
    { id: "opencode-go/muse-spark-1.3-contributor", providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", variants: ["xhigh", "high"], variantsObservable: true },
    { id: "openai/gpt-6-luna", providerID: "openai", modelID: "gpt-6-luna", name: "GPT 6 Luna", variants: ["xhigh"], variantsObservable: true },
    { id: "openai/gpt-6.1-sol", providerID: "openai", modelID: "gpt-6.1-sol", name: "GPT 6.1 Sol", variants: ["high", "medium"], variantsObservable: true },
  ],
};

/** Sandboxed global config (tests/setup.ts isolates HOME/XDG): healthy Context7 MCP plus a skills value. */
async function writeSandboxGlobalConfig(skills: unknown): Promise<string> {
  const configPath = defaultGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } }, skills }),
  );
  return configPath;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("v1.0.14 T009 deterministic isolated verification", () => {
  it("two roots render identical canonical bytes+checksum; npx/checkout/extracted path-stable, no ephemeral root persisted", async () => {
    const root = await tempRoot("aria-t009-tworoot-");
    const worktree = join(root, "worktree");
    const version = readPackageVersion();
    expect(version).toBe("1.0.14");

    // Three representative install roots whose ephemeral prefixes must never
    // persist in canonical bytes (npx cache, checkout, extracted package).
    const npxRoot = join(root, "npx-cache", "_npx", "2f5c0f11", "node_modules", "aria");
    const checkoutRoot = join(root, "aria-checkout");
    const extractedRoot = join(root, "extracted", "node_modules", "aria");

    // Same version+config renders byte-identical canonical bytes regardless
    // of WIKI_DIR (the old code baked it into archivist.md).
    process.env.WIKI_DIR = join(root, "wiki-live");
    const withWiki = resolveSetupAriaConfig(worktree);
    delete process.env.WIKI_DIR;
    const withoutWiki = resolveSetupAriaConfig(worktree);
    const first = generateAgentFiles(withWiki, version);
    const second = generateAgentFiles(withoutWiki, version);
    expect(Object.keys(first)).toHaveLength(11);
    for (const role of ROLES) {
      expect(second[role], `${role} identical across WIKI_DIR`).toBe(first[role]);
      expect(sha256(second[role]!), `${role} checksum stable`).toBe(sha256(first[role]!));
      expect(parseManagedHeader(second[role]!)?.version, `${role} version`).toBe(version);
    }

    // Archivist stays path-stable via placeholders; no ephemeral root is
    // baked into any of the 11 canonical files.
    expect(first.archivist).toContain("{{WIKI_DIR}}");
    expect(first.archivist).toContain("{{packageRoot}}");
    for (const role of ROLES) {
      for (const ephemeral of [npxRoot, checkoutRoot, extractedRoot, "/_npx/", process.env.WIKI_DIR ?? ""]) {
        if (ephemeral.length === 0) continue;
        expect(first[role], `${role} carries no ephemeral ${ephemeral}`).not.toContain(ephemeral);
      }
    }
    // The other 10 roles never carry placeholders (narrow archivist-only scope).
    for (const role of ROLES) {
      if (role === "archivist") continue;
      expect(first[role], `${role} has no placeholders`).not.toContain("{{packageRoot}}");
      expect(first[role], `${role} has no placeholders`).not.toContain("{{WIKI_DIR}}");
    }
    // Coder routing still resolves (shared renderer intact).
    expect(first.coder).toContain("Configured routes:");
  });

  it("runtime archivist/Wiki binding resolves placeholders in-memory with no file writes", async () => {
    const root = await tempRoot("aria-t009-runtime-");
    const worktree = join(root, "worktree");
    const canonical = resolveAriaConfig(worktree);
    const system = canonical.roles.archivist.promptText;
    expect(system).toContain("{{packageRoot}}");

    // Pure resolver: placeholders become live paths.
    const resolved = resolveArchivistRuntimeSystem(system, {
      packageRoot: "/pkg/live",
      wikiDir: "/wiki/live",
    });
    expect(resolved).toContain("WIKI_DIR: `/wiki/live`");
    expect(resolved).toContain("PACKAGE_ROOT: `/pkg/live`");
    expect(resolved).not.toContain("{{");

    // Narrow transform: only archivist is patched, scoped permissions apply
    // when WIKI_DIR is set; nothing is written to disk.
    const agentsDir = join(root, "agents");
    await mkdir(agentsDir, { recursive: true });
    const beforeNames: string[] = await readdir(agentsDir).catch(() => []);
    const store = new Map<string, Record<string, unknown>>([
      ["archivist", { system }],
      ["coder", { system: "coder system" }],
    ]);
    const updated: string[] = [];
    const patched = applyArchivistRuntimeTransform(
      {
        get: (id) => store.get(id),
        update: (id, fn) => {
          updated.push(id);
          fn(store.get(id)!);
        },
      },
      worktree,
      { packageRoot: "/pkg/live", wikiDir: "/wiki/live" },
    );
    expect(patched).toBe(true);
    expect(updated).toEqual(["archivist"]);
    expect(store.get("archivist")?.system).toBe(resolved);
    expect(store.get("archivist")).toHaveProperty("permissions");
    expect(store.get("coder")).toEqual({ system: "coder system" });
    expect(await readdir(agentsDir).catch(() => [])).toEqual(beforeNames);

    // Unset WIKI_DIR keeps the deny-by-default base (no scoped permissions).
    const plain = new Map<string, Record<string, unknown>>([["archivist", { system }]]);
    applyArchivistRuntimeTransform(
      {
        get: (id) => plain.get(id),
        update: (id, fn) => fn(plain.get(id)!),
      },
      worktree,
      { packageRoot: "/pkg/live", wikiDir: "" },
    );
    expect(plain.get("archivist")?.system).not.toContain("{{");
    expect(plain.get("archivist")).not.toHaveProperty("permissions");
  });

  it("doctor agrees on canonical state and rejects tamper read-only", async () => {
    const root = await tempRoot("aria-t009-doctor-");
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const agentsDir = join(root, "agents");
    await mkdir(agentsDir, { recursive: true });
    const resolved = resolveSetupAriaConfig(worktree);
    const version = readPackageVersion();
    const canonical = generateAgentFiles(resolved, version);
    for (const role of ROLES) {
      await writeFile(join(agentsDir, agentFileName(role)), canonical[role]);
    }
    await writeSandboxGlobalConfig([getPackageSkillsRoot()]);

    const report = await runDoctor({
      worktree,
      agentsDir,
      executor: healthyDoctorExecutor(),
      discovery: async () => DEFAULT_DOCTOR_MODELS,
    });
    const managed = report.findings.find(
      (finding) => finding.area === "config" && finding.title === "managed agent files",
    );
    expect(managed?.severity).toBe("PASS");
    expect(managed?.detail).toContain("11 of 11");
    const skills = report.findings.find(
      (finding) => finding.area === "skills" && finding.title === "configured skills",
    );
    expect(skills?.severity).toBe("PASS");

    // Tamper is rejected: one flipped byte fails the managed gate, and the
    // read-only doctor changes nothing.
    const archivistPath = join(agentsDir, agentFileName("archivist"));
    const before = await readFile(archivistPath, "utf8");
    await writeFile(archivistPath, `${before}# tamper\n`);
    const tampered = await runDoctor({
      worktree,
      agentsDir,
      executor: healthyDoctorExecutor(),
      discovery: async () => DEFAULT_DOCTOR_MODELS,
    });
    const failed = tampered.findings.find(
      (finding) => finding.area === "config" && finding.title === "managed agent files",
    );
    expect(failed?.severity).toBe("FAIL");
    expect(failed?.detail).toContain("archivist");
    expect(doctorExitCode(tampered.findings)).toBe(1);
    expect(await readFile(archivistPath, "utf8")).toBe(`${before}# tamper\n`);
  });

  it("representative isolated migration converges stale v1.0.13 state to canonical (skills reconcile, idempotent, unrelated preserved)", async () => {
    const root = await tempRoot("aria-t009-migrate-");
    // Live-style global dir: opencode.json plus the managed agents/ directory.
    const configDir = join(root, "config", "opencode");
    const agentsDir = join(configDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });

    // Live-style v1.0.13 state: 11 managed files where only the archivist
    // carries the old root-baked bytes (PACKAGE_ROOT/WIKI_DIR interpolated
    // at generation time, exactly what T005 diagnosed); stale v1.0.7 npx
    // skills alongside an unrelated user path; sentinel keys; Engram/Quota
    // prose preserved in config; unrelated agent files.
    const version = readPackageVersion();
    const resolved = resolveSetupAriaConfig(worktree);
    const canonical = generateAgentFiles(resolved, version);
    const staleBakedArchivist = canonical.archivist
      .replaceAll("{{packageRoot}}", join(root, "stale-npx", "_npx", "eab1cbf372b87bc2", "node_modules", "aria"))
      .replaceAll("{{WIKI_DIR}}", join(root, "wiki-live"));
    expect(staleBakedArchivist).not.toBe(canonical.archivist);
    for (const role of ROLES) {
      await writeFile(
        join(agentsDir, agentFileName(role)),
        role === "archivist" ? staleBakedArchivist : canonical[role],
      );
    }
    const staleSkills = staleNpxSkills(join(root, "stale-npx"));
    const configPath = join(configDir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" }, keep: true },
          sentinel: "kept",
          engramNote: "engram 3.4.0 connected (report-only, untouched)",
          quotaNote: "quota moving-tag report-only (untouched)",
          skills: ["/user/skills", staleSkills],
        },
        null,
        2,
      ),
    );
    await writeFile(join(agentsDir, "my-helper.md"), "user content\n");
    const staleCacheDir = join(root, "stale-npx", "_npx", "aaaa1111");
    await mkdir(staleCacheDir, { recursive: true });
    await writeFile(join(staleCacheDir, "sentinel.txt"), "old cache must survive");

    // Pre-migration doctor disagrees on the baked archivist (live T003
    // check-9 shape), proving the fixture reproduces the diagnosed drift.
    await writeSandboxGlobalConfig([staleSkills]);
    const before = await runDoctor({
      worktree,
      agentsDir,
      executor: healthyDoctorExecutor(),
      discovery: async () => DEFAULT_DOCTOR_MODELS,
    });
    const beforeManaged = before.findings.find(
      (finding) => finding.area === "config" && finding.title === "managed agent files",
    );
    expect(beforeManaged?.severity).toBe("FAIL");
    expect(beforeManaged?.detail).toContain("archivist");

    // Current-tree candidate continuation (live-style order: normalize stale
    // owned skills, then regen managed agents; Engram/Quota stay stubbed
    // report-only and are never reinstalled).
    const skillsPhase = await runAriaSkillsRefreshPhase({
      target: { tag: "v0.0.0", version: "0.0.0", spec: "github:mscipio/ARIA#v0.0.0" },
      executor: async () => ({ stdout: "", stderr: "" }),
      configDir,
    });
    expect(skillsPhase.ok).toBe(true);
    expect(skillsPhase.mutated).toBe(true);
    const regen = await reconcileManagedAgents(resolved, { dir: agentsDir, version });
    expect(regen.written).toEqual(["archivist"]);
    expect(regen.unchanged).toHaveLength(10);

    // Converged: canonical 11-agent bytes with placeholders restored, current
    // skills in place, sentinel + unrelated + old caches preserved.
    const expected = generateAgentFiles(resolveSetupAriaConfig(worktree), version);
    for (const role of ROLES) {
      expect(await readFile(join(agentsDir, agentFileName(role)), "utf8"), `${role} canonical`).toBe(
        expected[role],
      );
    }
    expect(expected.archivist).toContain("{{packageRoot}}");
    const afterConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(afterConfig.skills).toEqual(["/user/skills", getPackageSkillsRoot()]);
    expect(validateAriaSkillsConfig(afterConfig, getPackageSkillsRoot())).toEqual([]);
    expect(afterConfig.sentinel).toBe("kept");
    expect(afterConfig.engramNote).toContain("untouched");
    expect(afterConfig.quotaNote).toContain("untouched");
    expect((afterConfig.mcp as Record<string, unknown>).keep).toBe(true);
    expect(await readFile(join(agentsDir, "my-helper.md"), "utf8")).toBe("user content\n");
    expect(await readFile(join(staleCacheDir, "sentinel.txt"), "utf8")).toBe("old cache must survive");

    // Current state is idempotent: no writes, mtimes preserved.
    const beforeBytes = await Promise.all(
      ROLES.map((role) => readFile(join(agentsDir, agentFileName(role)), "utf8")),
    );
    const beforeMtime = await Promise.all(
      ROLES.map((role) => stat(join(agentsDir, agentFileName(role))).then((entry) => entry.mtimeMs)),
    );
    const againSkills = await ensureAriaSkillsRefreshFile({
      configPath,
      skillsRoot: getPackageSkillsRoot(),
    });
    expect(againSkills.changed).toBe(false);
    const againRegen = await reconcileManagedAgents(resolved, { dir: agentsDir, version });
    expect(againRegen.written).toHaveLength(0);
    expect(againRegen.unchanged).toEqual([...ROLES]);
    for (const [index, role] of ROLES.entries()) {
      expect(await readFile(join(agentsDir, agentFileName(role)), "utf8"), `${role} stable`).toBe(
        beforeBytes[index],
      );
      expect((await stat(join(agentsDir, agentFileName(role)))).mtimeMs, `${role} mtime`).toBe(
        beforeMtime[index],
      );
    }

    // Post-migration doctor agrees on both gates.
    await writeSandboxGlobalConfig([getPackageSkillsRoot()]);
    const after = await runDoctor({
      worktree,
      agentsDir,
      executor: healthyDoctorExecutor(),
      discovery: async () => DEFAULT_DOCTOR_MODELS,
    });
    expect(
      after.findings.find((finding) => finding.area === "config" && finding.title === "managed agent files")
        ?.severity,
    ).toBe("PASS");
    expect(
      after.findings.find((finding) => finding.area === "skills" && finding.title === "configured skills")
        ?.severity,
    ).toBe("PASS");
  });

  it("ambiguous ownership fails closed with zero mutation (skills + agents)", async () => {
    const root = await tempRoot("aria-t009-closed-");
    const current = getPackageSkillsRoot();

    // Ambiguous skills: two positively owned packaged paths; nothing is
    // written and no backup is left behind.
    const ambiguousPath = join(root, "ambiguous.json");
    const ambiguousOriginal = JSON.stringify({
      keep: true,
      skills: [staleNpxSkills(join(root, "old-a")), staleNpxSkills(join(root, "old-b"))],
    });
    await writeFile(ambiguousPath, ambiguousOriginal);
    await expect(
      ensureAriaSkillsRefreshFile({ configPath: ambiguousPath, skillsRoot: current }),
    ).rejects.toThrow(/ambiguous/);
    expect(await readFile(ambiguousPath, "utf8")).toBe(ambiguousOriginal);
    expect((await readdir(root)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);

    // Stale alongside current is likewise ambiguous (never guessed).
    const mixedPath = join(root, "mixed.json");
    const mixedOriginal = JSON.stringify({ skills: [staleNpxSkills(join(root, "old-a")), current] });
    await writeFile(mixedPath, mixedOriginal);
    await expect(
      ensureAriaSkillsRefreshFile({ configPath: mixedPath, skillsRoot: current }),
    ).rejects.toThrow(/ambiguous/);
    expect(await readFile(mixedPath, "utf8")).toBe(mixedOriginal);

    // Checkout skills roots are unrelated (preserved, never guessed as owned).
    expect(isAriaPackageSkillsPath(resolve("/opt/aria-checkout", "skills"))).toBe(false);
    expect(isAriaPackageSkillsPath("/user/skills")).toBe(false);

    // Unowned agent content fails closed with every original byte preserved.
    const agentsDir = join(root, "agents");
    await mkdir(agentsDir, { recursive: true });
    const worktree = join(root, "worktree");
    const resolved = resolveSetupAriaConfig(worktree);
    const version = readPackageVersion();
    const canonical = generateAgentFiles(resolved, version);
    for (const role of ROLES) {
      await writeFile(join(agentsDir, agentFileName(role)), canonical[role]);
    }
    await writeFile(join(agentsDir, agentFileName("coder")), "user-owned coder agent\n");
    const beforeCoder = await readFile(join(agentsDir, agentFileName("coder")), "utf8");
    const beforeNames = (await readdir(agentsDir)).sort();
    const failure = await reconcileManagedAgents(resolved, { dir: agentsDir, version }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentReconciliationError);
    expect((failure as AgentReconciliationError).conflicts.map((conflict) => conflict.role)).toContain("coder");
    expect(await readFile(join(agentsDir, agentFileName("coder")), "utf8")).toBe(beforeCoder);
    expect((await readdir(agentsDir)).sort()).toEqual(beforeNames);
  });

  it("packed-candidate layout stays path-stable (extracted install owned, checkout unrelated)", async () => {
    // Lexical provenance for the packed E2E: an installed/extracted package
    // (`.../node_modules/aria/skills`, the npx cache and the packed install
    // alike) is positively owned, while a checkout tree (`<root>/skills`)
    // and user paths are unrelated and never guessed.
    const npxSkills = join("npx-cache", "_npx", "2f5c0f11", "node_modules", "aria", "skills");
    expect(isAriaPackageSkillsPath(resolve(tmpdir(), npxSkills))).toBe(true);
    expect(isAriaPackageSkillsPath(join(getPackageRoot(), "..", "extracted", "node_modules", "aria", "skills"))).toBe(
      true,
    );
    expect(isAriaPackageSkillsPath(join(getPackageRoot(), "skills"))).toBe(false);
    expect(getPackageSkillsRoot()).toBe(join(getPackageRoot(), "skills"));

    // The packed tarball ships the same canonical inputs (skills tree,
    // defaults, dist entry points); placeholders keep byte-stability.
    const pkg = JSON.parse(await readFile(resolve(getPackageRoot(), "package.json"), "utf8")) as {
      version?: unknown;
      files?: unknown;
    };
    expect(pkg.version).toBe("1.0.14");
    expect(pkg.files).toContain("skills");
    expect(pkg.files).toContain("defaults");
  });
});
