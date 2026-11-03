import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard for the Phase 4B removal: the legacy `.aria/rdc/TASKS.md` plan engine
 * and its V1 registration layer must not return as executable code. Matches
 * import/export/dynamic-import specifiers and direct `plan` tool registration.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DELETED_MODULES = ["plan-tool", "plan-premise-recovery-tool", "plans", "register", "present"];
const SPECIFIER = new RegExp(
  `(?:from\\s+|import\\s*\\(\\s*|import\\s+)["'][^"']*/(${DELETED_MODULES.join("|")})(?:\\.js|\\.ts)?["']`,
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("Phase 4B legacy plan orchestration removal", () => {
  it("deleted legacy modules are absent from the source tree", () => {
    for (const name of ["plans.ts", "plan-tool.ts", "plan-premise-recovery-tool.ts", "present.ts", "register.ts"]) {
      expect(existsSync(join(REPO_ROOT, "src", name))).toBe(false);
    }
  });

  it("no source, test, or script imports a deleted legacy module", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(REPO_ROOT, "src")), ...sourceFiles(join(REPO_ROOT, "tests")), ...sourceFiles(join(REPO_ROOT, "scripts"))]) {
      if (file.endsWith("legacy-removal.test.ts")) continue;
      if (SPECIFIER.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the native plan_id_new tool is the only plan-related tool registered at setup", () => {
    const index = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
    expect(index).toContain("createPlanIdTool()");
    expect(index).not.toMatch(/createPlanTool|createPlanPremiseRecoveryTool|resolvePlanRootFromLocation/);
  });
});
