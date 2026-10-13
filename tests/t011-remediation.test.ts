import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatAgentModel } from "../src/agents.js";
import { loadDefaultConfig } from "../src/defaults.js";
import type { Executor } from "../src/deps.js";
import { runDoctor, type DoctorOptions, type DoctorReport, type DoctorV2Snapshot } from "../src/doctor.js";
import { getPermissionsForRole } from "../src/permissions.js";
import { ROLES } from "../src/routes.js";
import { ARIA_SKILL_NAMES } from "../src/skills.js";
import {
  PROCESS_LOCAL_GIT_ENV,
  buildExactUpgradeApprovalArgv,
  formatApprovalGuidance,
  formatBlockedApprovalDetail,
  formatExactUpgradeApprovalCommand,
  formatUpgradeCheck,
  type AriaAvailableTarget,
} from "../src/upgrade.js";

// ---------------------------------------------------------------------------
// T011 remediation: displayed exact-package guidance carries the approved
// per-invocation process-local Git allowance (never global/`.npmrc`), and
// newer-runtime compat PASS requires every necessary V2 capability domain
// (a single observed list stays WARN).
// ---------------------------------------------------------------------------

const INSTALLED_106 = "github:mscipio/ARIA#v1.0.6";
const TARGET_107: AriaAvailableTarget = {
  tag: "v1.0.7",
  version: "1.0.7",
  spec: "github:mscipio/ARIA#v1.0.7",
};

describe("T011 displayed guidance carries the per-invocation Git allowance", () => {
  it("prefixes the exact-package invocation with NPM_CONFIG_ALLOW_GIT=all (no global/`.npmrc`)", () => {
    const hadGitKey = "NPM_CONFIG_ALLOW_GIT" in process.env;
    const command = formatExactUpgradeApprovalCommand(INSTALLED_106);

    // Exact display contract: per-invocation env prefix + exact package selection.
    expect(command).toBe(`NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${INSTALLED_106} -- aria upgrade --yes`);
    expect(command.startsWith("NPM_CONFIG_ALLOW_GIT=all npm exec")).toBe(true);
    expect(command).toContain(`--package ${INSTALLED_106} -- aria upgrade --yes`);
    // Never a bare PATH lookup and never a global allowance.
    expect(command).not.toContain("run `aria upgrade --yes`");
    expect(command).not.toContain(".npmrc");
    expect(command).not.toContain("npm config set");
    expect(command).not.toContain("export ");
    // Pure: formatting never touches the ambient environment.
    expect("NPM_CONFIG_ALLOW_GIT" in process.env).toBe(hadGitKey);
  });

  it("carries the allowance through approval/check guidance without global changes", () => {
    const approval = formatApprovalGuidance("1.0.6", TARGET_107.spec);
    expect(approval).toContain(`NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${INSTALLED_106} -- aria upgrade --yes`);
    expect(approval).toContain(TARGET_107.spec);
    expect(approval).not.toContain(".npmrc");

    const blocked = formatBlockedApprovalDetail("1.0.6", TARGET_107.spec);
    expect(blocked).toContain(`NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${INSTALLED_106} -- aria upgrade --yes`);
    expect(blocked).not.toContain(".npmrc");

    const text = formatUpgradeCheck({
      currentVersion: "1.0.6",
      available: { kind: "known", target: TARGET_107 } as const,
      selfUpgradeBlocked: false,
      blockReason: null,
      components: [{ component: "aria", installed: "1.0.6", available: "v1.0.7", status: "upgrade-available", detail: "x" }],
    } as never);
    expect(text).toContain(`NPM_CONFIG_ALLOW_GIT=all npm exec --yes --package ${INSTALLED_106} -- aria upgrade --yes`);
    expect(text).not.toContain("run `aria upgrade --yes`");
  });

  it("keeps the npm argv boundary contract while the allowance travels per-call only", () => {
    // The argv itself stays the npm boundary contract; the allowance travels
    // via the Executor `env` seam (`PROCESS_LOCAL_GIT_ENV`), never as argv.
    expect(buildExactUpgradeApprovalArgv(INSTALLED_106)).toEqual([
      "exec",
      "--yes",
      "--package",
      INSTALLED_106,
      "--",
      "aria",
      "upgrade",
      "--yes",
    ]);
    expect(PROCESS_LOCAL_GIT_ENV).toEqual({ NPM_CONFIG_ALLOW_GIT: "all" });
  });
});

// ---------------------------------------------------------------------------
// T011 capability evidence: a newer runtime PASSes only with every necessary
// V2 domain observed; a single plugin list (or any partial set) is WARN.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function baseExecutor(opencodeVersion = "opencode 2.0.26"): Executor {
  return async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "opencode --version") return { stdout: opencodeVersion, stderr: "" };
    if (invocation === "engram version") return { stdout: "engram 3.0.0", stderr: "" };
    if (invocation === "codegraph --version") return { stdout: "codegraph 1.0.0", stderr: "" };
    if (invocation === "opencode mcp list") {
      return { stdout: ["engram connected", "context7 connected", "codegraph connected"].join("\n"), stderr: "" };
    }
    if (invocation === "opencode debug config") return { stdout: "{}", stderr: "" };
    if (invocation === "opencode plugin list") return { stdout: "No plugins found", stderr: "" };
    if (command === "zotpilot") throw new Error("zotpilot: command not found");
    throw new Error(`Unexpected probe: ${invocation}`);
  };
}

async function compatOptions(
  opencodeVersion: string,
  v2?: DoctorV2Snapshot,
): Promise<DoctorOptions & { worktree: string; agentsDir: string }> {
  const xdg = await mkdtemp(resolve(tmpdir(), "aria-t011-xdg-"));
  tempDirs.push(xdg);
  const configDir = resolve(xdg, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(configDir, "opencode.json"),
    JSON.stringify({ mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } }),
  );
  process.env.XDG_CONFIG_HOME = xdg;

  const worktree = await mkdtemp(resolve(tmpdir(), "aria-t011-wt-"));
  const agentsDir = await mkdtemp(resolve(tmpdir(), "aria-t011-ag-"));
  tempDirs.push(worktree, agentsDir);
  await writeFile(
    join(worktree, "aria.json"),
    JSON.stringify({ roles: Object.fromEntries(ROLES.map((role) => [role, { model: "test/probe" }])) }),
  );
  return {
    worktree,
    agentsDir,
    executor: baseExecutor(opencodeVersion),
    discovery: async () => ({
      models: [
        {
          id: "test/probe",
          providerID: "test",
          modelID: "probe",
          name: "Probe",
          variants: [],
          variantsObservable: true,
        },
      ],
    }),
    ...(v2 === undefined ? {} : { v2 }),
  };
}

function compatFinding(report: DoctorReport) {
  return report.findings.find((finding) => finding.area === "dependencies" && finding.title === "OpenCode");
}

function healthySnapshot(): DoctorV2Snapshot {
  const defaults = loadDefaultConfig();
  return {
    plugins: [{ id: "aria", state: { status: "active" } }],
    agents: ROLES.map((role) => ({
      id: role,
      mode: defaults.roles[role].mode,
      model: formatAgentModel(defaults.roles[role].model, defaults.roles[role].variant),
      permissions: getPermissionsForRole(role),
    })),
    skills: ARIA_SKILL_NAMES.map((name) => ({ id: name, name })),
    tools: [
      { id: "plan", name: "plan" },
      { id: "other-tool", name: "other-tool" },
    ],
  };
}

describe("T011 newer-runtime compat requires every necessary V2 capability", () => {
  it("WARNs (never PASSes) 2.0.26 with only v2:{plugins:[]} observed", async () => {
    const report = await runDoctor(await compatOptions("opencode 2.0.26", { plugins: [] }));

    const opencode = compatFinding(report);
    expect(opencode?.severity).toBe("WARN");
    expect(opencode?.detail).toContain("2.0.26");
    expect(opencode?.detail).toContain("insufficient");
    expect(opencode?.detail).toContain("missing");
    expect(opencode?.detail).toContain("not presumed compatible");
    expect(opencode?.detail).not.toContain("positively observed");
    // No overall-health assertion here: an empty plugin list correctly FAILs
    // the runtime `plugin aria` finding; this regression only proves compat
    // itself stays WARN on a single observed list.
  });

  it("WARNs a partial set (plugins/agents only) as insufficient", async () => {
    const snapshot = healthySnapshot();
    const partial: DoctorV2Snapshot = { plugins: snapshot.plugins, agents: snapshot.agents };
    const report = await runDoctor(await compatOptions("opencode 2.0.26", partial));

    const opencode = compatFinding(report);
    expect(opencode?.severity).toBe("WARN");
    expect(opencode?.detail).toContain("insufficient");
    expect(opencode?.detail).toContain("missing");
    expect(opencode?.detail).toContain("skills");
    expect(opencode?.detail).toContain("tools");
    expect(opencode?.detail).toContain("not presumed compatible");
    expect(opencode?.detail).not.toContain("positively observed");
  });

  it("PASSes 2.0.26 only with all necessary domains observed", async () => {
    const report = await runDoctor(await compatOptions("opencode 2.0.26", healthySnapshot()));

    const opencode = compatFinding(report);
    expect(opencode?.severity).toBe("PASS");
    expect(opencode?.detail).toContain("2.0.26");
    expect(opencode?.detail).toContain("positively observed");
    expect(opencode?.detail).toContain("plugins/agents/skills/tools");
  });
});
