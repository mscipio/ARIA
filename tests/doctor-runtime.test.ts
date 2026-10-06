import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatAgentModel, installAgentFiles } from "../src/agents.js";
import { loadDefaultConfig } from "../src/defaults.js";
import type { Executor } from "../src/deps.js";
import {
  runDoctor,
  snapshotFromContext,
  type DoctorOptions,
  type DoctorReport,
  type DoctorV2Snapshot,
} from "../src/doctor.js";
import { getPermissionsForRole } from "../src/permissions.js";
import { ROLES } from "../src/routes.js";
import { resolveSetupAriaConfig } from "../src/setup-config.js";
import { ARIA_SKILL_NAMES } from "../src/skills.js";

/**
 * T008 doctor runtime truth: V2 list findings (plugin/agents/skills/plan
 * tool/coexistence/session), the 2.0.23 pin, and managed-file verification.
 * Tested through the public `runDoctor` runner with mocked V2 snapshots —
 * no live session, no workstation changes.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function baseExecutor(opencodeVersion = "opencode 2.0.23"): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: opencodeVersion, stderr: "" };
    if (invocation === "engram version") return { stdout: "engram 3.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph 1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
    }
    if (invocation === "opencode debug config") return { stdout: "{}", stderr: "" };
    throw new Error(`Unexpected probe: ${invocation}`);
  };
}

/** Worktree whose eleven routes resolve to one discovered probe model. */
async function baseOptions(executor?: Executor): Promise<DoctorOptions & { worktree: string; agentsDir: string }> {
  const worktree = await mkdtemp(resolve(tmpdir(), "aria-doctor-runtime-wt-"));
  const agentsDir = await mkdtemp(resolve(tmpdir(), "aria-doctor-runtime-ag-"));
  tempDirs.push(worktree, agentsDir);
  await writeFile(
    join(worktree, "aria.json"),
    JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
  );
  // Global Context7 remote config so the shared base report is fully healthy.
  const { mkdir } = await import("node:fs/promises");
  const configDir = join(process.env.HOME as string, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "opencode.json"),
    JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }),
  );
  return {
    worktree,
    agentsDir,
    executor: executor ?? baseExecutor(),
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

/** Canonical live agents: real per-role mode/model/permissions. */
function healthyAgents(): DoctorV2Snapshot["agents"] {
  const defaults = loadDefaultConfig();
  return ROLES.map((role) => ({
    id: role,
    mode: defaults.roles[role].mode,
    model: formatAgentModel(defaults.roles[role].model, defaults.roles[role].variant),
    permissions: getPermissionsForRole(role),
  }));
}

function healthySnapshot(): DoctorV2Snapshot {
  return {
    plugins: [
      { id: "aria", state: { status: "active" } },
      { id: "other-plugin", state: { status: "active" } },
    ],
    agents: healthyAgents(),
    skills: ARIA_SKILL_NAMES.map((name) => ({ id: name, name })),
    tools: [
      { id: "plan", name: "plan" },
      { id: "other-tool", name: "other-tool" },
    ],
    sessionsObserved: 2,
  };
}

function runtimeFinding(report: DoctorReport, title: string) {
  return report.findings.find((finding) => finding.area === "runtime" && finding.title === title);
}

describe("T008 doctor V2 runtime truth", () => {
  it("passes a healthy snapshot: plugin/agents/skills/plan/coexistence", async () => {
    const report = await runDoctor({ ...(await baseOptions()), v2: healthySnapshot() });

    expect(runtimeFinding(report, "plugin aria")?.severity).toBe("PASS");
    expect(runtimeFinding(report, "agents (11)")?.severity).toBe("PASS");
    expect(runtimeFinding(report, "agents (11)")?.detail).toContain("11 of 11");
    expect(runtimeFinding(report, "skills (21 live)")?.severity).toBe("PASS");
    expect(runtimeFinding(report, "plan tool")?.severity).toBe("PASS");
    expect(runtimeFinding(report, "plan tool")?.detail).toContain("exactly once");
    const coexistence = runtimeFinding(report, "coexistence");
    expect(coexistence?.severity).toBe("PASS");
    expect(coexistence?.detail).toContain("UNKNOWN");
    expect(coexistence?.detail).toContain("no plugin ordering assumed");
    expect(runtimeFinding(report, "session/runtime inventory")?.severity).toBe("PASS");
    // Non-ARIA registrations coexist without judgment.
    expect(report.findings.filter((finding) => finding.severity === "FAIL")).toHaveLength(0);
  });

  it("fails a missing plugin, duplicated plan tool, and colliding IDs", async () => {
    const snapshot = healthySnapshot();
    snapshot.plugins = [{ id: "other-plugin", state: { status: "active" } }];
    snapshot.tools = [
      { id: "plan", name: "plan" },
      { id: "plan-clone", name: "plan" },
      { id: "dup", name: "dup-tool" },
      { id: "dup", name: "dup-tool" },
    ];
    const report = await runDoctor({ ...(await baseOptions()), v2: snapshot });

    expect(runtimeFinding(report, "plugin aria")?.severity).toBe("FAIL");
    expect(runtimeFinding(report, "plugin aria")?.detail).toContain("not in the V2 plugin list");
    expect(runtimeFinding(report, "plan tool")?.severity).toBe("FAIL");
    expect(runtimeFinding(report, "plan tool")?.detail).toContain("more than once");
    const coexistence = runtimeFinding(report, "coexistence");
    expect(coexistence?.severity).toBe("FAIL");
    expect(coexistence?.detail).toContain("duplicate tool id: dup");
    expect(coexistence?.detail).toContain("UNKNOWN");
  });

  it("fails missing agents, legacy permission actions, and missing skills", async () => {
    const snapshot = healthySnapshot();
    snapshot.agents = (healthyAgents() ?? []).filter((agent) => agent.id !== "scientist");
    const researcher = snapshot.agents.find((agent) => agent.id === "researcher");
    (researcher?.permissions as Array<{ action: string }>)?.push({ action: "bash" } as never);
    snapshot.skills = ARIA_SKILL_NAMES.slice(1).map((name) => ({ id: name, name }));
    const report = await runDoctor({ ...(await baseOptions()), v2: snapshot });

    const agents = runtimeFinding(report, "agents (11)");
    expect(agents?.severity).toBe("FAIL");
    expect(agents?.detail).toContain("missing: scientist");
    expect(agents?.detail).toContain("bash");
    const skills = runtimeFinding(report, "skills (21 live)");
    expect(skills?.severity).toBe("FAIL");
    expect(skills?.detail).toContain(`missing: ${ARIA_SKILL_NAMES[0]}`);
  });

  it("skips runtime truth outside a live session with documented gaps", async () => {
    const report = await runDoctor(await baseOptions());

    for (const title of ["plugin aria", "agents (11)", "skills (21 live)", "plan tool", "coexistence"]) {
      const finding = runtimeFinding(report, title);
      expect(finding?.severity).toBe("SKIP");
    }
    expect(runtimeFinding(report, "coexistence")?.detail).toContain("UNKNOWN");
    expect(runtimeFinding(report, "session/runtime inventory")?.severity).toBe("SKIP");
    // Managed files are also absent in the fresh temp dir: SKIP, never FAIL.
    const files = report.findings.find((finding) => finding.area === "config" && finding.title === "managed agent files");
    expect(files?.severity).toBe("SKIP");
    expect(report.findings.filter((finding) => finding.area === "runtime" && finding.severity === "FAIL")).toHaveLength(0);
  });

  it("fails a non-2.0.23 runtime with the pinned expectation", async () => {
    const report = await runDoctor({ ...(await baseOptions(baseExecutor("opencode 1.18.34"))), v2: healthySnapshot() });

    const opencode = report.findings.find((finding) => finding.area === "dependencies" && finding.title === "OpenCode");
    expect(opencode?.severity).toBe("FAIL");
    expect(opencode?.detail).toContain("2.0.23");
    expect(opencode?.detail).toContain("1.18.34");
  });

  it("verifies installed agent files match version/config and flags drift", async () => {
    const options = await baseOptions();
    await installAgentFiles(resolveSetupAriaConfig(options.worktree), { dir: options.agentsDir });

    const matching = await runDoctor(options);
    const pass = matching.findings.find((finding) => finding.area === "config" && finding.title === "managed agent files");
    expect(pass?.severity).toBe("PASS");
    expect(pass?.detail).toContain("11 of 11 match");

    await writeFile(join(options.agentsDir, "coder.md"), "hand-edited\n");
    const drifted = await runDoctor(options);
    const fail = drifted.findings.find((finding) => finding.area === "config" && finding.title === "managed agent files");
    expect(fail?.severity).toBe("FAIL");
    expect(fail?.detail).toContain("coder");
  });
});

describe("snapshotFromContext (pinned 2.0.23 domains)", () => {
  it("maps live domain lists and degrades throwing lists to unobserved", async () => {
    const ctx = {
      plugin: { list: async () => ({ data: [{ id: "aria", state: { status: "active" } }] }) },
      agent: {
        list: async () => ({
          data: [{ id: "coder", mode: "all", model: "m/x", permissions: [{ action: "read", resource: "*", effect: "allow" }] }],
        }),
      },
      skill: { list: async () => { throw new Error("unavailable"); } },
      tool: { list: async () => [{ id: "plan", name: "plan" }] },
      session: { list: async () => { throw new Error("unavailable"); } },
    };
    const snapshot = await snapshotFromContext(ctx as never);

    expect(snapshot.plugins).toEqual([{ id: "aria", state: { status: "active" } }]);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.skills).toBeUndefined();
    expect(snapshot.tools).toEqual([{ id: "plan", name: "plan" }]);
    expect(snapshot.sessionsObserved).toBeUndefined();
  });

  it("accepts session counts and returns empty for context-less hosts", async () => {
    const ctx = {
      session: { list: async () => ({ data: [{ id: "s1" }, { id: "s2" }] }) },
    };
    expect((await snapshotFromContext(ctx as never)).sessionsObserved).toBe(2);
    expect(await snapshotFromContext({})).toEqual({});
    expect(await snapshotFromContext(undefined)).toEqual({});
  });

  it("reads installed bytes back (sanity: expected generation is stable)", async () => {
    const options = await baseOptions();
    await installAgentFiles(resolveSetupAriaConfig(options.worktree), { dir: options.agentsDir });
    expect(await readFile(join(options.agentsDir, "scientist.md"), "utf8")).toContain("Scientific authority");
  });
});
