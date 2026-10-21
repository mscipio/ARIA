import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCommandsDir, generateCommandFiles, installCommandFiles, isAriaManaged, parseManagedHeader, reconcileManagedCommands, verifyManagedContent } from "../src/commands.js";
import { createUniqueScratchDir } from "../src/scratch.js";
import { setup } from "../src/lifecycle.js";
import { runDoctor } from "../src/doctor.js";
import type { Executor } from "../src/deps.js";

const dirs: string[] = [];
async function temp(): Promise<string> { const dir = await createUniqueScratchDir(process.cwd(), "tests/fixtures", "commands"); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("managed commands", () => {
  it("ships valid versioned templates with coder metadata and arguments", async () => {
    const files = generateCommandFiles();
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string; files: string[] };
    for (const [name, text] of Object.entries(files)) {
      const frontmatter = text.split("---")[1] ?? "";
      expect(frontmatter).toContain("description:"); expect(frontmatter).toContain("agent: coder");
      expect(frontmatter).not.toMatch(/^template:/m); expect(text.slice(text.lastIndexOf("---") + 3)).toContain("$ARGUMENTS");
      expect(isAriaManaged(text)).toBe(true); expect(verifyManagedContent(text)).toBe(true);
      expect(parseManagedHeader(text)?.version).toBe(pkg.version); expect(name).toMatch(/^aria-/);
    }
    expect(existsSync(resolve("defaults/commands/aria-push.md"))).toBe(true);
    expect(existsSync(resolve("defaults/commands/aria-release.md"))).toBe(true);
    expect(pkg.files).toContain("defaults");
  });

  it("installs idempotently, backs up unmanaged files, refreshes managed files, and preserves other commands", async () => {
    const dir = await temp();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "aria-push.md"), "user command");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const occupiedBackup = join(dir, `aria-push.md.aria-backup-${stamp}`);
    await writeFile(occupiedBackup, "older backup must survive");
    await writeFile(join(dir, "my-review.md"), "untouched");
    const first = await installCommandFiles({ dir, version: "test" });
    expect(first.written).toHaveLength(2);
    const backup = first.backups["aria-push"];
    expect(backup).toBeTruthy(); expect(await readFile(backup!, "utf8")).toBe("user command");
    expect(backup).not.toBe(occupiedBackup);
    expect(await readFile(occupiedBackup, "utf8")).toBe("older backup must survive");
    const before = await readFile(join(dir, "aria-release.md"), "utf8");
    const second = await installCommandFiles({ dir, version: "test" });
    expect(second.unchanged).toHaveLength(2); expect(await readFile(join(dir, "aria-release.md"), "utf8")).toBe(before);
    await writeFile(join(dir, "aria-release.md"), before.replace("Prepare a release", "Edited release"));
    const refreshed = await installCommandFiles({ dir, version: "test" });
    expect(refreshed.tampered).toContain("aria-release"); expect(refreshed.previousContents["aria-release"]).toContain("Edited release");
    await reconcileManagedCommands({ dir, version: "test" });
    expect(await readFile(join(dir, "my-review.md"), "utf8")).toBe("untouched");
  });

  it("strict reconciliation rejects unowned files without touching them", async () => {
    const dir = await temp(); await writeFile(join(dir, "aria-push.md"), "user-owned");
    await expect(reconcileManagedCommands({ dir, version: "test" })).rejects.toThrow(/unowned/);
    expect(await readFile(join(dir, "aria-push.md"), "utf8")).toBe("user-owned");
  });
  it("rolls back earlier writes when an install fails part-way", async () => {
    const dir = await temp();
    await mkdir(join(dir, "aria-release.md"));
    await expect(installCommandFiles({ dir, version: "test" })).rejects.toThrow();
    expect(existsSync(join(dir, "aria-push.md"))).toBe(false);
    expect(existsSync(join(dir, "aria-release.md"))).toBe(true);
  });
  it("uses the OpenCode commands directory default", () => { expect(defaultCommandsDir()).toContain("commands"); });

  it("setup installs both commands through its files seam", async () => {
    const dir = await temp();
    const files = { globalConfigPath: join(dir,"opencode.json"), agentsDir: join(dir,"agents"), commandsDir: join(dir,"commands"), skillsRoot: join(dir,"skills") };
    const checkout = process.cwd();
    const executor: Executor = async (command,args) => {
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "opencode plugin list") return { stdout:"No plugins found", stderr:"" };
      if (invocation === `opencode plugin add ${checkout}`) return { stdout:"registered", stderr:"" };
      throw new Error(`Unexpected command: ${invocation}`);
    };
    const sync = async () => ({ ok:true, engram:{action:"ok"}, context7:{action:"ok"}, codegraph:{action:"ok"}, health:undefined });
    const result = await setup(new URL(`file://${join(checkout,"bin","aria.mjs")}`).href, executor, sync, { files });
    expect(result.ok).toBe(true);
    const installed = await installCommandFiles({ dir:files.commandsDir });
    expect(installed.unchanged).toHaveLength(2);
    expect(await readFile(join(files.commandsDir,"aria-push.md"),"utf8")).toBe(generateCommandFiles()["aria-push"]);
    expect(await readFile(join(files.commandsDir,"aria-release.md"),"utf8")).toBe(generateCommandFiles()["aria-release"]);
  });

  it("doctor checks commands read-only and fails read-only on tampering", async () => {
    const dir=await temp(), commandsDir=join(dir,"commands"), worktree=join(dir,"worktree");
    await mkdir(worktree,{recursive:true});
    await installCommandFiles({dir:commandsDir});
    const options={worktree,commandsDir,executor:async () => ({stdout:"",stderr:""}), discovery:async () => ({models:[]})};
    const file=join(commandsDir,"aria-push.md"), canonical=await readFile(file,"utf8");
    const pass=await runDoctor(options);
    expect(pass.findings.find((f)=>f.area==="commands"&&f.title==="managed command files")?.severity).toBe("PASS");
    expect(await readFile(file,"utf8")).toBe(canonical);
    const edited=canonical.replace("Perform the requested push workflow", "Edited workflow"); await writeFile(file,edited);
    const fail=await runDoctor(options);
    expect(fail.findings.find((f)=>f.area==="commands"&&f.title==="managed command files")?.severity).toBe("FAIL");
    expect(await readFile(file,"utf8")).toBe(edited);
  });
});
