import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { resolveAriaConfig, ROLES } from "../src/overrides";
import { applyPending, emptyPending, resolveEffective, type PendingChanges } from "../src/model-manager-state";
import {
  formatModelAssignments,
  loadModelManagerSnapshot,
  persistAssignments,
} from "../src/model-manager-store";

let root: string;
let globalDir: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aria-mm-store-"));
  globalDir = join(root, "xdg", "opencode");
  worktree = join(root, "project");
  await mkdir(globalDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function snapshotNow() {
  return loadModelManagerSnapshot(worktree, { globalDir });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("snapshot", () => {
  it("reports the sources and write targets for both scopes", async () => {
    await writeFile(join(globalDir, "aria.json"), JSON.stringify({ roles: { coder: { model: "openai/gpt-6-luna" } } }));
    const snapshot = snapshotNow();
    expect(snapshot.saved.global).toEqual({ coder: { model: "openai/gpt-6-luna" } });
    expect(snapshot.saved.project).toEqual({});
    expect(snapshot.paths.global.source).toBe(join(globalDir, "aria.json"));
    expect(snapshot.paths.global.target).toBe(join(globalDir, "aria.json"));
    expect(snapshot.paths.project.source).toBeUndefined();
    expect(snapshot.paths.project.target).toBe(join(worktree, "aria.json"));
  });

  it("fails before presenting anything when a configuration file is invalid", async () => {
    await writeFile(join(worktree, "aria.json"), JSON.stringify({ roles: { coder: { model: "no-slash" } } }));
    expect(() => snapshotNow()).toThrow(/roles\.coder\.model/);
  });
});

describe("persistAssignments", () => {
  it("writes only the changed global role, preserves other roles and legacy alias keys, and regenerates agents", async () => {
    const original = {
      roles: {
        reviewer: { model: "openai/gpt-6-luna" },
        architect: { model: "openai/gpt-6.1-sol", variant: "low" },
      },
    };
    await writeFile(join(globalDir, "aria.json"), JSON.stringify(original));
    const pending: PendingChanges = {
      global: { coder: { model: "openai/gpt-6.1-sol", variant: "high" } },
      project: {},
    };
    const regenerate = vi.fn(async () => ({}));

    const outcome = await persistAssignments(snapshotNow(), pending, { regenerate });

    expect(outcome).toMatchObject({ status: "saved", regenerated: true, changed: { global: ["coder"], project: [] } });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledWith(worktree);
    expect(await readJson(join(globalDir, "aria.json"))).toEqual({
      roles: {
        reviewer: { model: "openai/gpt-6-luna" },
        architect: { model: "openai/gpt-6.1-sol", variant: "low" },
        coder: { model: "openai/gpt-6.1-sol", variant: "high" },
      },
    });
    expect(existsSync(join(worktree, "aria.json"))).toBe(false);
  });

  it("writes a project override without touching global files or regenerating agents", async () => {
    const regenerate = vi.fn(async () => ({}));
    const pending: PendingChanges = { global: {}, project: { planner: { model: "openai/gpt-6-luna" } } };

    const outcome = await persistAssignments(snapshotNow(), pending, { regenerate });

    expect(outcome).toMatchObject({ status: "saved", regenerated: false, changed: { global: [], project: ["planner"] } });
    expect(regenerate).not.toHaveBeenCalled();
    expect(await readJson(join(worktree, "aria.json"))).toEqual({ roles: { planner: { model: "openai/gpt-6-luna" } } });
    expect(existsSync(join(globalDir, "aria.json"))).toBe(false);
  });

  it("replaces a legacy alias key when its canonical role is edited", async () => {
    await writeFile(join(worktree, "aria.json"), JSON.stringify({ roles: { architect: { model: "openai/gpt-6-luna" } } }));
    const pending: PendingChanges = { global: {}, project: { reviewer: { model: "openai/gpt-6.1-sol" } } };

    await persistAssignments(snapshotNow(), pending);

    expect(await readJson(join(worktree, "aria.json"))).toEqual({ roles: { reviewer: { model: "openai/gpt-6.1-sol" } } });
  });

  it("removes a project override and leaves the file with the remaining roles", async () => {
    await writeFile(
      join(worktree, "aria.json"),
      JSON.stringify({ roles: { coder: { model: "openai/gpt-6.1-sol", variant: "low" }, planner: { model: "openai/gpt-6-luna" } } }),
    );
    const pending: PendingChanges = { global: {}, project: { coder: null } };

    const outcome = await persistAssignments(snapshotNow(), pending);

    expect(outcome.status).toBe("saved");
    expect(await readJson(join(worktree, "aria.json"))).toEqual({ roles: { planner: { model: "openai/gpt-6-luna" } } });
  });

  it("reports unchanged and writes nothing when pending edits match the saved layers", async () => {
    await writeFile(join(globalDir, "aria.json"), JSON.stringify({ roles: { coder: { model: "openai/gpt-6-luna" } } }));
    const before = await readFile(join(globalDir, "aria.json"), "utf8");
    const pending: PendingChanges = { global: { coder: { model: "openai/gpt-6-luna" } }, project: {} };

    const outcome = await persistAssignments(snapshotNow(), pending, { regenerate: async () => ({}) });

    expect(outcome.status).toBe("unchanged");
    expect(await readFile(join(globalDir, "aria.json"), "utf8")).toBe(before);
  });

  it("writes nothing when another scope cannot be prepared", async () => {
    const snapshot = snapshotNow();
    // A directory where the project file belongs makes its preparation fail (after the snapshot was read).
    await mkdir(join(worktree, "aria.json"));
    const pending: PendingChanges = {
      global: { coder: { model: "openai/gpt-6.1-sol" } },
      project: { planner: { model: "openai/gpt-6-luna" } },
    };

    const outcome = await persistAssignments(snapshot, pending, { regenerate: async () => ({}) });

    expect(outcome.status).toBe("failed");
    expect(existsSync(join(globalDir, "aria.json"))).toBe(false);
  });

  it("restores both files byte-for-byte when managed-agent regeneration fails", async () => {
    const globalBefore = JSON.stringify({ roles: { explorer: { model: "openai/gpt-6-luna" } } });
    const projectBefore = JSON.stringify({ roles: { planner: { model: "openai/gpt-6.1-sol" } } });
    await writeFile(join(globalDir, "aria.json"), globalBefore);
    await writeFile(join(worktree, "aria.json"), projectBefore);
    const pending: PendingChanges = {
      global: { coder: { model: "openai/gpt-6.1-sol", variant: "high" } },
      project: { planner: null },
    };

    const outcome = await persistAssignments(snapshotNow(), pending, {
      regenerate: async () => {
        throw new Error("agent directory is read-only");
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toContain("configuration was restored");
    expect(await readFile(join(globalDir, "aria.json"), "utf8")).toBe(globalBefore);
    expect(await readFile(join(worktree, "aria.json"), "utf8")).toBe(projectBefore);
    expect((await readdir(globalDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes a newly created global file when regeneration fails", async () => {
    const pending: PendingChanges = { global: { coder: { model: "openai/gpt-6.1-sol" } }, project: {} };

    const outcome = await persistAssignments(snapshotNow(), pending, {
      regenerate: async () => {
        throw new Error("disk full");
      },
    });

    expect(outcome.status).toBe("failed");
    expect(existsSync(join(globalDir, "aria.json"))).toBe(false);
  });

  it("keeps the persisted effective routing identical to the runtime resolver after regeneration", async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    try {
      const pending: PendingChanges = {
        global: { coder: { model: "openai/gpt-6.1-sol", variant: "high" }, visualizer: { model: "openai/gpt-6-luna" } },
        project: { planner: { model: "opencode-go/muse-spark-1.3-contributor", variant: "xhigh" } },
      };
      const outcome = await persistAssignments(loadModelManagerSnapshot(worktree), pending);
      expect(outcome).toMatchObject({ status: "saved", regenerated: true });

      // Managed agent files carry no `model:` field (routes are applied at runtime from
      // resolveAriaConfig). Regeneration does rewrite the coder's routing table from the
      // new global layer, so the global route must appear there.
      const coderFile = await readFile(join(root, "xdg", "opencode", "agents", "coder.md"), "utf8");
      expect(coderFile).not.toMatch(/^model:/m);
      expect(coderFile).toContain("openai/gpt-6.1-sol [high]");

      // Runtime resolution (global + project) equals the manager's effective preview.
      const runtime = resolveAriaConfig(worktree);
      const saved = loadModelManagerSnapshot(worktree, { globalDir: join(root, "xdg", "opencode") });
      const preview = resolveEffective(loadDefaultConfig(), saved.saved);
      for (const role of ROLES) {
        const route = preview.find((entry) => entry.role === role);
        expect(runtime.roles[role].model).toBe(route?.model);
        expect(runtime.roles[role].variant).toBe(route?.variant);
      }
      expect(runtime.roles.planner).toMatchObject({ model: "opencode-go/muse-spark-1.3-contributor", variant: "xhigh" });
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("leaves no temporary files behind after a successful save", async () => {
    const pending: PendingChanges = { global: {}, project: { writer: { model: "openai/gpt-6-luna" } } };
    await persistAssignments(snapshotNow(), pending);
    expect((await readdir(worktree)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("read-only table", () => {
  it("lists effective assignments, variants, and where each came from", async () => {
    await writeFile(join(globalDir, "aria.json"), JSON.stringify({ roles: { coder: { model: "openai/gpt-6.1-sol", variant: "high" } } }));
    await writeFile(join(worktree, "aria.json"), JSON.stringify({ roles: { planner: { model: "openai/gpt-6-luna" } } }));
    const table = formatModelAssignments(snapshotNow());
    expect(table).toContain("read-only");
    const rowFor = (role: string) => table.split("\n").find((line) => line.startsWith(`${role} `)) ?? "";
    expect(rowFor("coder")).toMatch(/openai\/gpt-6\.1-sol\s+high\s+global$/);
    expect(rowFor("planner")).toMatch(/openai\/gpt-6-luna\s+-\s+project$/);
    expect(rowFor("explorer")).toMatch(/default$/);
  });

  it("the pending overlay is a pure preview that never mutates the saved layers", () => {
    const saved = snapshotNow().saved;
    const applied = applyPending(saved, { ...emptyPending(), project: { coder: { model: "openai/gpt-6-luna" } } });
    expect(applied.project.coder).toEqual({ model: "openai/gpt-6-luna" });
    expect(saved.project.coder).toBeUndefined();
  });
});
