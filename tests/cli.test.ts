import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CLI-level coverage for bin/aria.mjs dispatch: the doctor branch must use
// the src/doctor.ts runner/formatter/exit-code contract, and the
// setup/update/deps-sync dispatch must remain unchanged.

const execFileAsync = promisify(execFile);

const binPath = fileURLToPath(new URL("../bin/aria.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const CLI_TIMEOUT_MS = 240_000;

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("bin/aria.mjs doctor dispatch", () => {
  it("help documents the read-only doctor contract while setup/update/deps-sync lines stay unchanged", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aria doctor                Read-only health check of ARIA");
    expect(result.stdout).toContain("aria setup                 Register ARIA with OpenCode and synchronize dependencies");
    expect(result.stdout).toContain("aria setup --configure     Then interactively configure ARIA role models");
    expect(result.stdout).toContain("aria update                Pull latest changes, reinstall, and re-sync dependencies");
    expect(result.stdout).toContain("aria deps sync             Synchronize required dependencies (Engram, Context7, CodeGraph)");
    expect(result.stdout).toContain("aria routes                Print resolved model routes for each ARIA role");
  });

  it("renders plain human output with literal severity labels and separate ZotPilot CLI/MCP findings, with the exit code exactly matching the FAIL contract", async () => {
    const result = await runCli(["doctor"]);

    // Exit code is 0 iff no finding is FAIL (environment-dependent probe
    // results, so assert the contract relation rather than a fixed code).
    expect([0, 1]).toContain(result.code);
    expect(result.code).toBe(result.stdout.includes("[FAIL]") ? 1 : 0);

    // Compact human-only report with literal severity labels.
    expect(result.stdout.startsWith("ARIA doctor\n")).toBe(true);
    expect(result.stdout).toMatch(/\[(PASS|WARN|FAIL|SKIP)\]/);
    for (const area of ["package:", "config:", "routes/models:", "dependencies:", "zotpilot:", "skills:", "wiki:"]) {
      expect(result.stdout).toContain(area);
    }

    // ZotPilot CLI availability/version and ZotPilot MCP connectivity are
    // clearly separate findings, and the standalone live-inventory
    // limitation is visible.
    expect(result.stdout).toMatch(/\[(PASS|WARN)\] ZotPilot CLI/);
    expect(result.stdout).toMatch(/\[(PASS|WARN)\] ZotPilot MCP/);
    if (result.stdout.includes("[PASS] ZotPilot CLI")) {
      expect(result.stdout).toContain("via zotpilot --version");
    }
    expect(result.stdout).toContain("[SKIP] live tool inventory");
    expect(result.stdout).toContain("standalone aria doctor cannot compare expected/present/missing/unexpected live ZotPilot tool IDs");

    // Plain text only: no ANSI escapes, no JSON payload, no repair/install hints.
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
    for (const forbidden of ["npm install", "npm ci", "mcp serve"]) {
      expect(result.stdout).not.toContain(forbidden);
    }
    expect(result.stderr).toBe("");
  });

  it("emits equally plain output under NO_COLOR", async () => {
    const result = await runCli(["doctor"], { NO_COLOR: "1" });

    expect(result.stdout.startsWith("ARIA doctor\n")).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(result.stderr).toBe("");
  });

  it("keeps the deps dispatch unchanged", async () => {
    const result = await runCli(["deps"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown deps subcommand");
    expect(result.stderr).toContain("Usage: aria deps sync");
  });
});
