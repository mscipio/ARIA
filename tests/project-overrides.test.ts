import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentFiles, readPackageVersion } from "../src/agents";
import aria from "../src/index";
import { resolveAriaConfig, ROLES } from "../src/overrides";
import {
  applyProjectModelOverlay,
  applyProjectModelTransforms,
  parseProjectAgentOverrides,
  parseProjectModelValue,
  readProjectAgentModelOverrides,
  toRuntimeModelRef,
} from "../src/project-overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "aria-project-overrides-"));
  tempDirs.push(root);
  return root;
}

describe("T005 project overrides", () => {
  it("parses the string form with and without a variant", () => {
    expect(parseProjectModelValue("openai/gpt-5.6-terra#xhigh", "opencode.json", "agents.planner.model")).toEqual({
      model: "openai/gpt-5.6-terra",
      variant: "xhigh",
    });
    expect(parseProjectModelValue("opencode-go/deepseek-v4-pro", "opencode.json", "agents.coder.model")).toEqual({
      model: "opencode-go/deepseek-v4-pro",
    });
  });

  it("parses the object form with and without a variant", () => {
    expect(
      parseProjectModelValue(
        { providerID: "openai", model: "gpt-5.6-terra", variant: "xhigh" },
        "opencode.json",
        "agents.planner.model",
      ),
    ).toEqual({ model: "openai/gpt-5.6-terra", variant: "xhigh" });
    expect(
      parseProjectModelValue(
        { providerID: "opencode-go", model: "deepseek-v4-pro" },
        "opencode.json",
        "agents.coder.model",
      ),
    ).toEqual({ model: "opencode-go/deepseek-v4-pro" });
  });

  it("keeps the model+variant pair intact: model-only clears the inherited variant", async () => {
    const root = await worktree();
    const resolved = resolveAriaConfig(root);
    expect(resolved.roles.planner.variant).toBe("xhigh");

    const cleared = applyProjectModelOverlay(resolved, { planner: { model: "openai/gpt-5.4-mini" } });
    expect(cleared.roles.planner.model).toBe("openai/gpt-5.4-mini");
    expect(cleared.roles.planner.variant).toBeUndefined();

    const kept = applyProjectModelOverlay(resolved, {
      planner: { model: "openai/gpt-5.4-mini", variant: "high" },
    });
    expect(kept.roles.planner).toMatchObject({ model: "openai/gpt-5.4-mini", variant: "high" });
    expect(toRuntimeModelRef({ model: "openai/gpt-5.4-mini", variant: "high" })).toEqual({
      providerID: "openai",
      id: "gpt-5.4-mini",
      variant: "high",
    });
  });

  it("absent agents/model retains defaults and leaves globals untouched", async () => {
    const root = await worktree();
    const resolved = resolveAriaConfig(root);
    const untouched = applyProjectModelOverlay(resolved, {});
    expect(untouched).toEqual(resolved);
    expect(untouched).not.toBe(resolved);

    expect(parseProjectAgentOverrides({})).toEqual({});
    expect(parseProjectAgentOverrides({ agents: {} })).toEqual({});
    expect(parseProjectAgentOverrides({ agents: { planner: {} } })).toEqual({});
    // Unrelated top-level keys and agents without a model never overlay.
    expect(parseProjectAgentOverrides({ mcp: {}, agents: { planner: { description: "x" } } })).toEqual({});

    // No project opencode.json(c) is an empty overlay, never a failure.
    expect(readProjectAgentModelOverrides(root)).toEqual({});
  });

  it("reads opencode.json over opencode.jsonc and tolerates jsonc comments", async () => {
    const root = await worktree();
    await writeFile(
      resolve(root, "opencode.jsonc"),
      `{\n// project models\n"agents": { "planner": { "model": "openai/from-jsonc#xhigh" } }\n}\n`,
    );
    expect(readProjectAgentModelOverrides(root).planner).toEqual({
      model: "openai/from-jsonc",
      variant: "xhigh",
    });

    await writeFile(
      resolve(root, "opencode.json"),
      JSON.stringify({ agents: { planner: { model: "openai/from-json" } } }),
    );
    expect(readProjectAgentModelOverrides(root).planner).toEqual({ model: "openai/from-json" });
  });

  it("rejects invalid roles by ignoring unknown agents and invalid fields by throwing", () => {
    // Unknown agent IDs are user agents: ignored, never overlaid.
    expect(parseProjectAgentOverrides({ agents: { "my-helper": { model: "openai/gpt-5.6-terra" } } })).toEqual(
      {},
    );
    // Unsupported V2 model schemas stop instead of coercing.
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: "gpt-5" } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: 42 } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: null } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: { providerID: "openai" } } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: { id: "x", providerID: "openai" } } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: { planner: { model: { providerID: "openai", model: "m", variant: 1 } } } })).toThrow();
    expect(() => parseProjectAgentOverrides({ agents: "bad" })).toThrow();
  });

  it("patches only overlaid agents via agent.update and never touches globals", async () => {
    const overlay = {
      planner: { model: "openai/gpt-5.4-mini", variant: "high" },
      reviewer: { model: "opencode-go/custom-reviewer" },
    } as const;

    const store = new Map<string, Record<string, unknown>>([
      ["planner", { model: { providerID: "openai", id: "old" } }],
      ["reviewer", { model: { providerID: "x", id: "y", variant: "z" } }],
      ["coder", { model: { providerID: "keep", id: "keep" } }],
    ]);
    const updated: string[] = [];
    const patched = applyProjectModelTransforms(
      {
        get: (id) => store.get(id),
        update: (id, fn) => {
          updated.push(id);
          fn(store.get(id)!);
        },
      },
      overlay,
    );
    expect(patched).toEqual(["planner", "reviewer"]);
    expect(updated).toEqual(["planner", "reviewer"]);
    expect(store.get("planner")).toEqual({
      model: { providerID: "openai", id: "gpt-5.4-mini", variant: "high" },
    });
    // Model-only overlay clears the stale variant as an intact pair.
    expect(store.get("reviewer")).toEqual({ model: { providerID: "opencode-go", id: "custom-reviewer" } });
    // Globals untouched: roles without an overlay are never updated.
    expect(store.get("coder")).toEqual({ model: { providerID: "keep", id: "keep" } });

    // Missing agents are skipped, never materialized.
    const skipped = applyProjectModelTransforms(
      { get: () => undefined, update: () => { throw new Error("must not update"); } },
      overlay,
    );
    expect(skipped).toEqual([]);
  });

  it("production setup applies project opencode.json overrides via agent.transform only", async () => {
    const root = await worktree();
    await writeFile(
      resolve(root, "opencode.json"),
      JSON.stringify({
        agents: {
          planner: { model: "openai/gpt-5.4-mini#high" },
          reviewer: { model: { providerID: "opencode-go", model: "custom-reviewer" } },
        },
      }),
    );
    const canonical = resolveAriaConfig(root);
    const version = readPackageVersion();
    const globalDefs = generateAgentFiles(canonical, version);

    // Seed the effective V2 agent surface from canonical defaults.
    const store = new Map<string, Record<string, unknown>>();
    for (const role of ROLES) {
      const route = canonical.roles[role];
      const slash = route.model.indexOf("/");
      store.set(role, {
        model: route.variant === undefined
          ? { providerID: route.model.slice(0, slash), id: route.model.slice(slash + 1) }
          : { providerID: route.model.slice(0, slash), id: route.model.slice(slash + 1), variant: route.variant },
      });
    }
    const coderBefore = JSON.parse(JSON.stringify(store.get("coder")));
    const transforms: Array<(editor: never) => void> = [];
    const updated: string[] = [];
    const editor = {
      get: (id: string) => store.get(id),
      update: (id: string, fn: (agent: Record<string, unknown>) => void) => {
        updated.push(id);
        fn(store.get(id)!);
      },
    };

    const cleanup = await aria.setup({
      location: { project: { directory: root } },
      agent: {
        transform: (callback: (editor: never) => void) => {
          transforms.push(callback);
          return Promise.resolve({ dispose: async () => {} });
        },
      },
    } as never);
    expect(typeof cleanup).toBe("function");

    // Plugin setup executed the override path.
    expect(transforms).toHaveLength(1);
    for (const transform of transforms) transform(editor as never);

    // Effective V2 agent surface shows the expected model+variant for both
    // the string form (planner) and the object form (reviewer).
    expect(store.get("planner")).toEqual({
      model: { providerID: "openai", id: "gpt-5.4-mini", variant: "high" },
    });
    // Model-only object form clears the inherited variant as an intact pair.
    expect(store.get("reviewer")).toEqual({ model: { providerID: "opencode-go", id: "custom-reviewer" } });
    // Only overlaid roles were patched, in canonical role order.
    expect(updated).toEqual(["planner", "reviewer"]);
    // Non-overridden roles retain their canonical defaults.
    expect(store.get("coder")).toEqual(coderBefore);
    // Global generated defs are unchanged and setup wrote no files.
    expect(generateAgentFiles(canonical, version)).toEqual(globalDefs);
    expect(await readdir(root)).toEqual(["opencode.json"]);
    await cleanup?.();
  });
});
