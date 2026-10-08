import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ROLES,
  agentFileName,
  formatAgentModel,
  generateAgentFile,
  generateAgentFiles,
  installAgentFiles,
  isAriaManaged,
  parseManagedHeader,
  readPackageVersion,
  rollbackAgentInstall,
} from "../src/agents";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions";
import { resolveAriaConfig } from "../src/overrides";
import type { RoleName } from "../src/types";
// Pinned 2.0.23 loaded-agent behavior (pinned via `@opencode/plugin@2.0.23`
// in package.json, which depends on `@opencode/schema@2.0.23`): the tests
// below decode generated frontmatter through the real Agent/Model schemas
// instead of asserting on strings, so accidental builtin inheritance would
// fail the suite.
import { Agent, Model } from "@opencode/schema";

// T008 transient-rollback fault injection (adversarial regression only).
// Passthrough mock for `node:fs/promises`: real FS unless a one-shot
// predicate matches. Lets one test inject a post-move write failure plus a
// transient immediate-restore failure without directory-read tricks.
const fsFault = vi.hoisted(() => ({
  writeFileFailWhen: null as null | ((target: string) => boolean),
  renameFailWhen: null as null | ((src: string, dst: string) => boolean),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (...args: unknown[]) => {
      const target = String((args as unknown[])[0]);
      if (fsFault.writeFileFailWhen?.(target)) {
        fsFault.writeFileFailWhen = null;
        const error = new Error(`injected transient write failure for ${target}`) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return (actual.writeFile as (...callArgs: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.writeFile,
    rename: (async (...args: unknown[]) => {
      const src = String((args as unknown[])[0]);
      const dst = String((args as unknown[])[1]);
      if (fsFault.renameFailWhen?.(src, dst)) {
        fsFault.renameFailWhen = null;
        const error = new Error(`injected transient rename failure ${src} -> ${dst}`) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return (actual.rename as (...callArgs: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.rename,
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  fsFault.writeFileFailWhen = null;
  fsFault.renameFailWhen = null;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aria-agents-"));
  tempDirs.push(root);
  return root;
}

describe("T003 agent installation", () => {
  it("generates exactly the eleven canonical agents with preserved modes/models/variants", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const files = generateAgentFiles(resolved, readPackageVersion());

    expect(Object.keys(files)).toEqual([
      "coder",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
      "writer",
      "scientist",
    ]);
    expect(files.coder).toContain("mode: all");
    expect(files.explorer).toContain("mode: subagent");
    expect(files.planner).toContain("mode: subagent");
    expect(files.archivist).toContain("mode: all");
    expect(files.scientist).toContain("mode: all");
    // V2 model selector: provider/model with #variant appended.
    expect(files.coder).toContain('model: "opencode-go/muse-spark-1.3-contributor#xhigh"');
    expect(files.explorer).toContain('model: "opencode-go/muse-spark-1.3-contributor#high"');
    expect(files.planner).toContain('model: "openai/gpt-6-luna#xhigh"');
    expect(files.researcher).toContain('model: "openai/gpt-6.1-sol#medium"');
    expect(files.scientist).toContain('model: "openai/gpt-6.1-sol#medium"');
    // Preserved V1 description intent.
    expect(files.coder).toContain("Coordinates planning, implementation, and review.");
    expect(files.researcher).toContain("external literature and evidence research");
    expect(files.scientist).toContain("Scientific authority for question specification");
    expect(files.writer).toContain("Primary scientific, academic, and professional writing agent.");
    expect(files.archivist).toContain("curated Wiki lookup and maintenance");
  });

  it("formats V2 model selectors without approximating the variant separator", () => {
    expect(formatAgentModel("opencode-go/deepseek-v4-pro", undefined)).toBe("opencode-go/deepseek-v4-pro");
    expect(formatAgentModel("opencode-go/deepseek-v4-flash", "high")).toBe("opencode-go/deepseek-v4-flash#high");
  });

  it("is deterministic and carries verifiable ownership markers", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const version = readPackageVersion();
    const first = generateAgentFiles(resolved, version);
    const second = generateAgentFiles(resolved, version);
    expect(second).toEqual(first);

    const content = generateAgentFile("explorer", resolved.roles.explorer, version);
    expect(isAriaManaged(content)).toBe(true);
    const header = parseManagedHeader(content);
    expect(header?.version).toBe(version);
    expect(header?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(isAriaManaged("unrelated user agent")).toBe(false);
    expect(parseManagedHeader("unrelated user agent")).toBeNull();
  });

  it("emits real parity Rule[] with no legacy V1 actions (T004 replaces deny-all placeholder)", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const files = generateAgentFiles(resolved, readPackageVersion());
    // Canonical source is per-role: coder differs from explorer (skill
    // allow+deny vs deny+allow) and researcher differs from scientist.
    expect(getPermissionsForRole("coder")).not.toEqual(getPermissionsForRole("explorer"));
    expect(getPermissionsForRole("researcher")).not.toEqual(getPermissionsForRole("scientist"));
    for (const [role, content] of Object.entries(files)) {
      // Every security-relevant field is explicit in frontmatter.
      expect(content).toContain("description: ");
      expect(content).toContain("model: ");
      expect(content).toContain("mode: ");
      expect(content).toContain("permissions:");
      // V1 permission names must never leak into V2 rules (T001 evidence
      // gate): bash->shell, task->subagent, and plan/todowrite/list/lsp/
      // doom_loop have no 2.0.23 evidence so are never emitted.
      for (const legacy of [
        "action: bash",
        "action: task",
        "action: plan",
        "action: todowrite",
        "action: list",
        "action: lsp",
        "action: doom_loop",
      ]) {
        expect(content, `${role} emits legacy ${legacy}`).not.toContain(legacy);
      }
      // Explicit first-position fallback overriding the native builtin
      // allow-all; later specific rules still prevail under last-match-wins,
      // so no later blanket allow may appear.
      const actionLines = content.split("\n").filter((line) => line.includes("action:"));
      expect(actionLines[0], `${role} first rule is fallback ask`).toContain('action: "*"');
      expect(content, `${role} fallback is ask`).toContain('- action: "*"');
      const blanketAllows = (content.match(/- action: "\*"\n\s+resource: "\*"\n\s+effect: allow/g) ?? []).length;
      expect(blanketAllows, `${role} has no blanket allow`).toBe(0);
    }
    // Spot-check V2 renames in file bytes: shell (not bash), subagent (not task).
    expect(files.implementer).toContain('action: "shell"');
    expect(files.coder).toContain('action: "subagent"');
    expect(files.coder).toContain('resource: "explorer"');
  });

  it("passes the resolved system prompt through as the Markdown body", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const files = generateAgentFiles(resolved, readPackageVersion());
    for (const role of Object.keys(files) as RoleName[]) {
      const lines = files[role].split("\n");
      const closing = lines.indexOf("---", 1);
      expect(closing).toBeGreaterThan(0);
      // File layout is `---` frontmatter, one blank line, then the body.
      expect(lines[closing + 1]).toBe("");
      // The body carries exactly one trailing newline, so the split leaves
      // one trailing empty element to drop during reconstruction.
      const body = `${lines.slice(closing + 2, -1).join("\n")}\n`;
      const wanted = resolved.roles[role].promptText.endsWith("\n")
        ? resolved.roles[role].promptText
        : `${resolved.roles[role].promptText}\n`;
      expect(body).toBe(wanted);
    }
  });

  it("installs idempotently and never touches unrelated user agents", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");
    await installAgentFiles(resolved, { dir, version: "0.6.0" });
    expect((await readdir(dir)).sort()).toEqual(
      (Object.keys(generateAgentFiles(resolved, "0.6.0")) as RoleName[]).map(agentFileName).sort(),
    );

    // Unrelated user agent present before regeneration.
    await writeFile(join(dir, "my-helper.md"), "user content\n");
    const second = await installAgentFiles(resolved, { dir, version: "0.6.0" });
    expect(second.unchanged).toHaveLength(11);
    expect(second.written).toHaveLength(0);
    expect(await readFile(join(dir, "my-helper.md"), "utf8")).toBe("user content\n");
  });

  it("backs up unmanaged incumbents instead of overwriting and rolls back", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "coder.md"), "user-owned coder agent\n");

    const installed = await installAgentFiles(resolved, { dir, version: "0.6.0" });
    expect(installed.written).toContain("coder");
    expect(installed.written).toHaveLength(11);
    expect(installed.unchanged).toHaveLength(0);
    const backupPath = installed.backups.coder;
    expect(backupPath).toBeDefined();
    expect(await readFile(backupPath!, "utf8")).toBe("user-owned coder agent\n");
    expect(isAriaManaged(await readFile(join(dir, "coder.md"), "utf8"))).toBe(true);

    await rollbackAgentInstall(dir, installed);
    expect(await readFile(join(dir, "coder.md"), "utf8")).toBe("user-owned coder agent\n");
  });

  it("rolls back accumulated files when a later step fails (partial-install atomicity)", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");
    await mkdir(dir, { recursive: true });
    const originalCoder = "user-owned coder agent\n";
    await writeFile(join(dir, "coder.md"), originalCoder);
    // explorer.md as a directory makes the second install step throw after
    // coder was already replaced + backed up.
    await mkdir(join(dir, "explorer.md"), { recursive: true });

    await expect(installAgentFiles(resolved, { dir, version: "0.6.0" })).rejects.toThrow();
    // Accumulated change rolled back, including the backup-moved case.
    expect(await readFile(join(dir, "coder.md"), "utf8")).toBe(originalCoder);
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
  });

  it("recovers when post-move replacement fails and the immediate restore is transient (T008 adversarial)", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");
    await mkdir(dir, { recursive: true });
    const originalCoder = "user-owned coder agent\n";
    const originalExplorer = "user-owned explorer agent\n";
    await writeFile(join(dir, "coder.md"), originalCoder);
    await writeFile(join(dir, "explorer.md"), originalExplorer);
    await writeFile(join(dir, "my-helper.md"), "user content\n");

    // Post-move failure (not a directory-read failure): explorer is moved to
    // backup, then its replacement write fails. The immediate restore of
    // explorer then hits a transient FS error. Both are one-shot so the
    // accumulated + defensive retries can succeed.
    fsFault.writeFileFailWhen = (target) => target.includes("explorer.md.") && target.endsWith(".tmp");
    fsFault.renameFailWhen = (src, dst) =>
      src.includes("explorer.md.aria-backup-") && dst.endsWith("explorer.md");

    let thrown: unknown;
    try {
      await installAgentFiles(resolved, { dir, version: "0.6.0" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const partial = (thrown as { partialResult?: import("../src/agents").AgentInstallResult })
      .partialResult;
    expect(partial).toBeDefined();
    // Rollback obligation recorded before the replacement could fail.
    expect(partial!.written).toContain("coder");
    expect(partial!.written).toContain("explorer");
    expect(partial!.backups.coder).toBeDefined();
    expect(partial!.backups.explorer).toBeDefined();

    // Accumulated rollback already retried explorer: both originals are back,
    // no stale managed replacement, no orphaned backup, unrelated untouched.
    expect(await readFile(join(dir, "coder.md"), "utf8")).toBe(originalCoder);
    expect(await readFile(join(dir, "explorer.md"), "utf8")).toBe(originalExplorer);
    expect(isAriaManaged(await readFile(join(dir, "coder.md"), "utf8"))).toBe(false);
    expect(isAriaManaged(await readFile(join(dir, "explorer.md"), "utf8"))).toBe(false);
    expect(await readFile(join(dir, "my-helper.md"), "utf8")).toBe("user content\n");
    expect((await readdir(dir)).some((entry) => entry.includes(".aria-backup-"))).toBe(false);
    expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

    // Defensive second retry: already-restored (consumed) coder must not
    // block explorer, and must not throw or touch unrelated files.
    await rollbackAgentInstall(dir, partial!);
    expect(await readFile(join(dir, "coder.md"), "utf8")).toBe(originalCoder);
    expect(await readFile(join(dir, "explorer.md"), "utf8")).toBe(originalExplorer);
    expect(await readFile(join(dir, "my-helper.md"), "utf8")).toBe("user content\n");
  });

  it("restores replaced managed files byte-for-byte on rollback (upgrade reversibility)", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const dir = resolve(await worktree(), "agents");

    const oldInstall = await installAgentFiles(resolved, { dir, version: "0.6.0" });
    expect(oldInstall.written).toHaveLength(11);
    expect(oldInstall.previousContents).toEqual({});
    const oldContents = Object.fromEntries(
      await Promise.all(
        ROLES.map(async (role) => [role, await readFile(join(dir, agentFileName(role)), "utf8")] as const),
      ),
    ) as Record<RoleName, string>;

    const upgrade = await installAgentFiles(resolved, { dir, version: "0.6.1" });
    expect(upgrade.written).toHaveLength(11);
    expect(upgrade.unchanged).toHaveLength(0);
    // Replaced managed files retain their prior bytes on the result.
    for (const role of ROLES) {
      expect(upgrade.previousContents[role], `${role} retains prior managed bytes`).toBe(oldContents[role]);
    }
    // The upgrade actually changed bytes (version marker), and no stray
    // temp files leak from atomic writes.
    for (const role of ROLES) {
      expect(await readFile(join(dir, agentFileName(role)), "utf8")).not.toBe(oldContents[role]);
    }
    expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")).sort()).toEqual([]);

    await rollbackAgentInstall(dir, upgrade);
    for (const role of ROLES) {
      expect(await readFile(join(dir, agentFileName(role)), "utf8"), `${role} restored`).toBe(
        oldContents[role],
      );
    }
    expect((await readdir(dir)).sort()).toEqual(ROLES.map(agentFileName).sort());
  });

  it("loads explicit security fields through pinned 2.0.23 Agent.Info without builtin inheritance", async () => {
    const resolved = resolveAriaConfig(await worktree());
    const content = generateAgentFile("explorer", resolved.roles.explorer, readPackageVersion());

    // Parse the actual file bytes (not constants) the way a loader would.
    const lines = content.split("\n");
    const closing = lines.indexOf("---", 1);
    expect(closing).toBeGreaterThan(0);
    const frontmatter = lines.slice(1, closing);
    const descriptionLine = frontmatter.find((line) => line.startsWith("description: "));
    const modelLine = frontmatter.find((line) => line.startsWith("model: "));
    const modeLine = frontmatter.find((line) => line.startsWith("mode: "));
    expect(descriptionLine).toBeDefined();
    expect(modelLine).toBeDefined();
    expect(modeLine).toBeDefined();
    const description = JSON.parse(descriptionLine!.slice("description: ".length)) as string;
    const model = JSON.parse(modelLine!.slice("model: ".length)) as string;
    const mode = modeLine!.slice("mode: ".length).trim();
    const permissions: { action: string; resource: string; effect: string }[] = [];
    for (let index = 0; index < frontmatter.length; index += 1) {
      const actionMatch = frontmatter[index]?.match(/^\s*-\s*action:\s*(.*)$/);
      if (!actionMatch) continue;
      const resourceLine = frontmatter[index + 1];
      const effectLine = frontmatter[index + 2];
      expect(resourceLine).toMatch(/resource:/);
      expect(effectLine).toMatch(/effect:/);
      permissions.push({
        action: JSON.parse(actionMatch[1]!.trim()) as string,
        resource: JSON.parse(resourceLine!.split("resource:")[1]!.trim()) as string,
        effect: effectLine!.split("effect:")[1]!.trim(),
      });
    }

    // Pinned 2.0.23 loader behavior: the V2 model selector parses, the
    // explicit parity permissions decode, and the full Agent.Info loads with
    // our explicit rules rather than the builtin permissive defaults.
    const modelRef = Model.Ref.parse(model);
    expect(modelRef.providerID).toBe("opencode-go");
    expect(modelRef.id).toBe("muse-spark-1.3-contributor");
    const loaded = Agent.Info.make({
      id: Agent.ID.make("explorer"),
      name: Agent.Name.make("explorer"),
      request: { settings: {}, headers: {}, body: {} },
      mode: mode as "subagent",
      hidden: false,
      permissions: permissions as [{ action: string; resource: string; effect: "deny" }],
      description,
      model: {
        providerID: modelRef.providerID,
        id: modelRef.id,
        ...(modelRef.variant ? { variant: modelRef.variant } : {}),
      },
    });
    expect(loaded.permissions).toEqual(getPermissionsForRole("explorer"));
    // Explorer carries V2 shell/subagent denies (never legacy bash/task) and
    // explicit read allows; no legacy actions leak into file bytes.
    expect(loaded.permissions.some((rule) => rule.action === "shell" && rule.effect === "deny")).toBe(true);
    expect(loaded.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny")).toBe(true);
    expect(loaded.permissions.some((rule) => rule.action === "bash" || rule.action === "task")).toBe(false);
    expect(loaded.permissions.some((rule) => rule.action === "read" && rule.effect === "allow")).toBe(true);
    expect(loaded.mode).toBe("subagent");
    expect(loaded.description).toBe(description);

    // The 2.0.23 builtin fallback is permissive: proving our loaded agent
    // differs proves no accidental inheritance.
    const builtin = Agent.Info.default(Agent.ID.make("explorer"));
    expect(builtin.permissions.some((rule) => rule.effect === "allow")).toBe(true);
    expect(loaded.permissions).not.toEqual(builtin.permissions);
    // File bytes carry the explicit first-position fallback.
    expect(loaded.permissions[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    // Native merged evaluation (builtin + file-byte rules): unmatched
    // operations must ask, not inherit the builtin allow-all, while intended
    // allows/denies still prevail.
    const merged = [...builtin.permissions, ...loaded.permissions] as {
      action: string;
      resource: string;
      effect: "allow" | "deny" | "ask";
    }[];
    expect(evaluatePermission(merged, "totally_unknown_action", "whatever")).toBe("ask");
    // Explorer carries the coding MCP grants, so Engram access is an intended
    // merged allow (not an unintended inheritance).
    expect(evaluatePermission(merged, "engram_mem_save", "*")).toBe("allow");
    expect(evaluatePermission(merged, "read", "src/app.ts")).toBe("allow");
    expect(evaluatePermission(merged, "edit", "src/app.ts")).toBe("deny");
    // Scientist boundary from file bytes: no MCP authority, so merged
    // ZotPilot/Engram access stays ask, never allow.
    const scientistContent = generateAgentFile("scientist", resolved.roles.scientist, readPackageVersion());
    expect(scientistContent).toContain('- action: "*"');
    const scientistRules = getPermissionsForRole("scientist");
    const scientistMerged = [
      ...Agent.Info.default(Agent.ID.make("scientist")).permissions,
      ...scientistRules,
    ];
    expect(evaluatePermission(scientistMerged, "engram_mem_save", "*")).toBe("ask");
    expect(evaluatePermission(scientistMerged, "zotpilot_search_papers", "*")).toBe("ask");
    expect(evaluatePermission(scientistMerged, "totally_unknown_action", "whatever")).toBe("ask");

    // Permissions are required by the schema: omitting them is rejected, so
    // an explicit field can never silently fall back to builtins.
    expect(() =>
      Agent.Info.make({
        id: Agent.ID.make("explorer"),
        name: Agent.Name.make("explorer"),
        request: { settings: {}, headers: {}, body: {} },
        mode: "subagent",
        hidden: false,
        description,
      } as unknown as Parameters<typeof Agent.Info.make>[0]),
    ).toThrow();
  });
});
