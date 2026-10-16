import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentReconciliationError,
  agentFileName,
  generateAgentFiles,
  parseManagedHeader,
  reconcileManagedAgents,
  ROLES,
} from "../src/agents.js";
import {
  buildUpgradeHandoff,
  checkUpgradeInventory,
  continueUpgradeInNewRelease,
  runManagedAgentRegenPhase,
  type AriaAvailableTarget,
} from "../src/upgrade.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import { resolveSetupAriaConfig } from "../src/setup-config.js";
import { openCodeGlobalDir } from "../src/paths.js";
import type { Executor } from "../src/deps.js";
import type { ModelDiscovery } from "../src/model-config.js";
import type { RoleName } from "../src/types.js";

// ---------------------------------------------------------------------------
// T003 — managed-agent regeneration regression coverage.
//
// Deterministic, isolated (temp dirs only, no live state): every case seeds
// fixture agent bytes, exercises the real T001 strict reconciliation
// (`reconcileManagedAgents` in src/agents.ts) and the real T002 post-handoff
// phase (`runManagedAgentRegenPhase` in src/upgrade.ts), then asserts on
// file bytes. No src behavior is changed here.
// Required cases: (a) stale v1.0.7 regeneration, (b) byte/mtime
// idempotence, (c) missing-file creation, (d) unrelated/sentinel
// preservation, (e) fail-closed conflicts, (f) post-handoff ordering and
// regen-failure gating, (g) doctor managed-agent gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T002 deterministic version fixture: behavioral regen results must not
// branch on the checkout's release version. Every simulated current/target
// version below is explicit; the package-version read is pinned to the same
// fixture so doctor's internal managed-agent gate agrees with the seeded
// bytes (cross-module importers observe the mock; same-module bodies use
// FIXTURE_VERSION directly).
// ---------------------------------------------------------------------------

const { FIXTURE_VERSION } = vi.hoisted(() => ({ FIXTURE_VERSION: "9.9.9" }));

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    readPackageVersion: () => FIXTURE_VERSION,
    // The post-handoff regen phase reaches reconciliation through the
    // model-config wrapper without an explicit version (production resolves
    // the new release's own version there); default it to the fixture so the
    // phase converges to the same explicit bytes the test seeds and expects.
    reconcileManagedAgents: (
      ...args: Parameters<typeof actual.reconcileManagedAgents>
    ): ReturnType<typeof actual.reconcileManagedAgents> => {
      const [resolved, options] = args;
      return actual.reconcileManagedAgents(resolved, { version: FIXTURE_VERSION, ...options });
    },
  };
});

const tempDirs: string[] = [];
let originalWikiDir: string | undefined;

afterEach(async () => {
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  // Doctor treats an absent WIKI_DIR as SKIP; pin that so ambient state
  // cannot flip the (g) gate (mirrors tests/doctor.test.ts).
  originalWikiDir = process.env.WIKI_DIR;
  delete process.env.WIKI_DIR;
  return root;
}

/** Stale managed generation every upgrade test seeds from (pre-regen state). */
const STALE_VERSION = "1.0.7";

async function seedVersionedAgents(
  dir: string,
  worktree: string,
  version: string,
): Promise<Record<RoleName, string>> {
  const resolved = resolveSetupAriaConfig(worktree);
  const files = generateAgentFiles(resolved, version);
  await mkdir(dir, { recursive: true });
  for (const role of ROLES) {
    await writeFile(join(dir, agentFileName(role)), files[role]);
  }
  return files;
}

async function readBytes(dir: string, name: string): Promise<string> {
  return readFile(join(dir, name), "utf8");
}

describe("T003 managed-agent regeneration", () => {
  it("(a) regenerates all 11 stale v1.0.7 managed files to the current package version", async () => {
    const root = await tempRoot("aria-regen-a-");
    const worktree = join(root, "worktree");
    const dir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    const current = FIXTURE_VERSION;
    const stale = await seedVersionedAgents(dir, worktree, STALE_VERSION);
    expect(Object.keys(stale)).toHaveLength(11);

    const result = await reconcileManagedAgents(resolved, { dir, version: current });

    expect(result.written).toEqual([...ROLES]);
    expect(result.unchanged).toHaveLength(0);
    // Prior managed bytes are retained for rollback, and every file now
    // matches the current generation byte-for-byte with the new marker.
    const expected = generateAgentFiles(resolved, current);
    for (const role of ROLES) {
      expect(await readBytes(dir, agentFileName(role)), `${role} converges`).toBe(expected[role]);
      expect(result.previousContents[role], `${role} retains prior bytes`).toBe(stale[role]);
      expect(parseManagedHeader(await readBytes(dir, agentFileName(role)))?.version).toBe(current);
    }
  });

  it("(b) leaves current generated files byte- and mtime-idempotent on re-run", async () => {
    const root = await tempRoot("aria-regen-b-");
    const worktree = join(root, "worktree");
    const dir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    const current = FIXTURE_VERSION;
    await seedVersionedAgents(dir, worktree, current);

    const beforeBytes = await Promise.all(ROLES.map((role) => readBytes(dir, agentFileName(role))));
    const beforeMtime = await Promise.all(
      ROLES.map((role) => stat(join(dir, agentFileName(role))).then((entry) => entry.mtimeMs)),
    );

    const second = await reconcileManagedAgents(resolved, { dir, version: current });

    expect(second.unchanged).toEqual([...ROLES]);
    expect(second.written).toHaveLength(0);
    for (const [index, role] of ROLES.entries()) {
      expect(await readBytes(dir, agentFileName(role)), `${role} bytes stable`).toBe(beforeBytes[index]);
      expect((await stat(join(dir, agentFileName(role)))).mtimeMs, `${role} mtime preserved`).toBe(
        beforeMtime[index],
      );
    }
  });

  it("(c) creates missing expected files while leaving present ones unchanged", async () => {
    const root = await tempRoot("aria-regen-c-");
    const worktree = join(root, "worktree");
    const dir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    const current = FIXTURE_VERSION;
    // Seed all but two roles; the absent role paths must be created.
    const present = ROLES.filter((role) => role !== "explorer" && role !== "scientist");
    const files = generateAgentFiles(resolved, current);
    await mkdir(dir, { recursive: true });
    for (const role of present) {
      await writeFile(join(dir, agentFileName(role)), files[role]);
    }

    const result = await reconcileManagedAgents(resolved, { dir, version: current });

    expect(result.written).toEqual(["explorer", "scientist"]);
    expect(result.unchanged).toEqual(present);
    expect(result.backups).toEqual({});
    for (const role of ROLES) {
      expect(await readBytes(dir, agentFileName(role)), `${role} present`).toBe(files[role]);
    }
  });

  it("(d) leaves unrelated and sentinel files byte-identical", async () => {
    const root = await tempRoot("aria-regen-d-");
    const worktree = join(root, "worktree");
    const dir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    const current = FIXTURE_VERSION;
    await seedVersionedAgents(dir, worktree, current);
    const extras: Record<string, string> = {
      "my-helper.md": "user content\n",
      "notes.aria-backup-2024": "stale backup-like sentinel\n",
      "stale.tmp": "stale tmp sentinel\n",
    };
    for (const [name, content] of Object.entries(extras)) {
      await writeFile(join(dir, name), content);
    }

    const result = await reconcileManagedAgents(resolved, { dir, version: current });

    expect(result.unchanged).toEqual([...ROLES]);
    expect(result.written).toHaveLength(0);
    for (const [name, content] of Object.entries(extras)) {
      expect(await readBytes(dir, name), `${name} preserved`).toBe(content);
    }
  });

  it("(e) fails closed on unowned/ambiguous conflicts with zero mutation and an actionable report", async () => {
    const root = await tempRoot("aria-regen-e-");
    const worktree = join(root, "worktree");
    const dir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    const current = FIXTURE_VERSION;
    await seedVersionedAgents(dir, worktree, current);
    // Unowned incumbent (no ARIA marker) plus an ambiguous role path.
    await writeFile(join(dir, agentFileName("coder")), "user-owned coder agent\n");
    await rm(join(dir, agentFileName("explorer")));
    await mkdir(join(dir, agentFileName("explorer")), { recursive: true });
    await writeFile(join(dir, "my-helper.md"), "user content\n");
    const beforeNames = (await readdir(dir)).sort();
    const beforeCoder = await readBytes(dir, agentFileName("coder"));

    const failure = await reconcileManagedAgents(resolved, { dir, version: current }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AgentReconciliationError);
    const conflicts = (failure as AgentReconciliationError).conflicts;
    expect(conflicts.map((conflict) => conflict.kind).sort()).toEqual(["ambiguous", "unowned"]);
    expect(conflicts.map((conflict) => conflict.role).sort()).toEqual(["coder", "explorer"]);
    const message = (failure as Error).message;
    expect(message).toContain("coder");
    expect(message).toContain("explorer");
    expect(message).toContain("Move each listed path aside");
    // Zero mutation: every original byte preserved, nothing created,
    // renamed, or backed up, unrelated file untouched.
    expect(await readBytes(dir, agentFileName("coder"))).toBe(beforeCoder);
    expect((await stat(join(dir, agentFileName("explorer")))).isDirectory()).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(beforeNames);
    expect(beforeNames.some((name) => name.includes(".aria-backup-") || name.endsWith(".tmp"))).toBe(false);
    expect(await readBytes(dir, "my-helper.md")).toBe("user content\n");
  });

  it("(f) post-handoff continuation runs real regen between normalize and deps-sync/doctor in order", async () => {
    const root = await tempRoot("aria-regen-f-");
    const configDir = join(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    const agentsDir = join(configDir, "agents");
    // Seed exactly what the real phase resolves: packaged defaults plus the
    // supported global overlay anchored at the new release CWD.
    const stale = await seedVersionedAgents(agentsDir, process.cwd(), STALE_VERSION);
    expect(Object.keys(stale)).toHaveLength(11);

    const inventoryCalls: string[] = [];
    const inventoryDir = join(root, "inventory", "opencode");
    await mkdir(inventoryDir, { recursive: true });
    const before = await checkUpgradeInventory(
      probeUpgradeExecutor(inventoryCalls),
      { configDir: inventoryDir, currentVersion: "1.0.6" },
    );
    const target: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };
    const handoff = buildUpgradeHandoff(target, before);
    const order: string[] = [];
    const throwingExecutor: Executor = async (command, args) => {
      throw new Error(`live execution forbidden in test: ${command} ${args.join(" ")}`);
    };

    const result = await continueUpgradeInNewRelease(
      handoff,
      target,
      before.components.map((row) => row.component),
      {
        executor: throwingExecutor,
        configDir,
        components: {
          engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
          context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
          codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
          zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
          quota: async () => ({ component: "quota", status: "skipped", detail: "stubbed", mutated: false }),
        },
        normalizeFn: async () => {
          order.push("normalize");
          return { ok: true, detail: "normalized", mutated: false };
        },
        regenFn: async (ctx) => {
          order.push("regen");
          return runManagedAgentRegenPhase(ctx);
        },
        depsSyncFn: async () => {
          order.push("deps-sync");
          return { ok: true, detail: "synced", mutated: false };
        },
        doctorFn: async () => {
          order.push("doctor");
          return { ok: true, detail: "healthy", mutated: false };
        },
      },
    );

    expect(result.stage).toBe("complete");
    expect(result.ok).toBe(true);
    expect(order).toEqual(["normalize", "regen", "deps-sync", "doctor"]);
    // The real phase converged the seeded stale files to the current bytes.
    const current = FIXTURE_VERSION;
    const expected = generateAgentFiles(resolveSetupAriaConfig(process.cwd()), current);
    for (const role of ROLES) {
      expect(await readBytes(agentsDir, agentFileName(role)), `${role} regenerated`).toBe(expected[role]);
    }
  });

  it("(f) failed regen stops the continuation before deps-sync and doctor with the conflict preserved", async () => {
    const root = await tempRoot("aria-regen-fail-");
    const configDir = join(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    const agentsDir = join(configDir, "agents");
    await seedVersionedAgents(agentsDir, process.cwd(), FIXTURE_VERSION);
    await writeFile(join(agentsDir, agentFileName("coder")), "user-owned coder agent\n");
    const beforeCoder = await readBytes(agentsDir, agentFileName("coder"));

    const inventoryCalls: string[] = [];
    const inventoryDir = join(root, "inventory", "opencode");
    await mkdir(inventoryDir, { recursive: true });
    const before = await checkUpgradeInventory(
      probeUpgradeExecutor(inventoryCalls),
      { configDir: inventoryDir, currentVersion: "1.0.6" },
    );
    const target: AriaAvailableTarget = { tag: "v1.0.7", version: "1.0.7", spec: "github:mscipio/ARIA#v1.0.7" };
    const handoff = buildUpgradeHandoff(target, before);
    let depsSyncCalls = 0;
    let doctorCalls = 0;
    const throwingExecutor: Executor = async (command, args) => {
      throw new Error(`live execution forbidden in test: ${command} ${args.join(" ")}`);
    };

    const result = await continueUpgradeInNewRelease(
      handoff,
      target,
      before.components.map((row) => row.component),
      {
        executor: throwingExecutor,
        configDir,
        components: {
          engram: async () => ({ component: "engram", status: "skipped", detail: "stubbed", mutated: false }),
          context7: async () => ({ component: "context7", status: "skipped", detail: "stubbed", mutated: false }),
          codegraph: async () => ({ component: "codegraph", status: "skipped", detail: "stubbed", mutated: false }),
          zotpilot: async () => ({ component: "zotpilot", status: "skipped", detail: "stubbed", mutated: false }),
          quota: async () => ({ component: "quota", status: "skipped", detail: "stubbed", mutated: false }),
        },
        normalizeFn: async () => ({ ok: true, detail: "normalized", mutated: false }),
        regenFn: (ctx) => runManagedAgentRegenPhase(ctx),
        depsSyncFn: async () => {
          depsSyncCalls += 1;
          return { ok: true, detail: "must not run", mutated: false };
        },
        doctorFn: async () => {
          doctorCalls += 1;
          return { ok: true, detail: "must not run", mutated: false };
        },
      },
    );

    expect(result.stage).toBe("phase-stopped");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("regen");
    expect(depsSyncCalls).toBe(0);
    expect(doctorCalls).toBe(0);
    expect(await readBytes(agentsDir, agentFileName("coder"))).toBe(beforeCoder);
  });

  it("(g) doctor passes the managed-agent gate on the reconciled directory", async () => {
    const root = await tempRoot("aria-regen-g-");
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const agentsDir = join(root, "agents");
    const resolved = resolveSetupAriaConfig(worktree);
    await seedVersionedAgents(agentsDir, worktree, STALE_VERSION);
    const reconciled = await reconcileManagedAgents(resolved, { dir: agentsDir, version: FIXTURE_VERSION });
    expect(reconciled.written).toHaveLength(11);
    // Healthy doctor fixtures: global OpenCode config carries the Context7
    // remote MCP, and every packaged default route model is discoverable.
    const globalDir = openCodeGlobalDir();
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      resolve(globalDir, "opencode.json"),
      JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }),
    );

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
    expect(doctorExitCode(report.findings)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Local fixtures (mirrors tests/upgrade.test.ts inventory probes and
// tests/doctor.test.ts healthy doctor options; read-only, no live state).
// ---------------------------------------------------------------------------

const UPGRADE_LS_REMOTE = [
  "aaa111\trefs/tags/v1.0.6",
  "bbb222\trefs/tags/v1.0.7",
  "bbb222\trefs/tags/v1.0.7^{}",
  "ccc333\trefs/heads/main",
  "",
].join("\n");

const UPGRADE_MCP_LIST = ["MCP Servers", "engram connected", "context7 connected", "codegraph connected"].join(
  "\n",
);

/** Read-only upgrade inventory executor; anything else throws. */
function probeUpgradeExecutor(calls: string[]): Executor {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "ls-remote") return { stdout: UPGRADE_LS_REMOTE, stderr: "" };
    if (command === "opencode" && args[0] === "plugin" && args[1] === "list") {
      return { stdout: "No plugins found", stderr: "" };
    }
    if (command === "opencode" && args[0] === "mcp" && args[1] === "list") {
      return { stdout: UPGRADE_MCP_LIST, stderr: "" };
    }
    throw new Error(`unexpected call in test: ${command} ${args.join(" ")}`);
  };
}

/** Executor whose read-only doctor probes all succeed. */
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
