import { Plugin } from "@opencode/plugin";

import { createScratchTaskTool } from "./scratch-tool.js";
import { createPlanIdTool } from "./plan-id-tool.js";
import { createGitReadTool } from "./git-tool.js";
import { createShipTool } from "./ship.js";
import { createReleaseTool } from "./release.js";
import { getPackageRoot } from "./defaults.js";
import { ROLES, resolveAriaConfig } from "./overrides.js";
import {
  applyArchivistRuntimeTransform,
  applyProjectModelTransforms,
  readProjectAgentModelOverrides,
  type ProjectModelOverlay,
} from "./project-overrides.js";

/**
 * ARIA native V2 plugin foundation (T002) with project model overlays (T005),
 * location-independent archivist runtime
 * binding (v1.0.14 T006).
 *
 * T005 production wiring: the real plugin setup path resolves the
 * project-local `opencode.json(c)` overlay with the accepted resolver and
 * seeds every canonical ARIA route via the supported V2 `agent.transform` →
 * `agent.update` surface, then applies project `opencode.json(c)` model
 * overrides. Only model/variant fields are changed; other agent metadata,
 * unrelated agents, and global agent files are untouched. Project overrides
 * are read-only here and never written to disk.
 *
 * Effective routing uses `resolveAriaConfig` for defaults, global and project
 * ARIA layers across all canonical roles. The OpenCode-native
 * `opencode.json(c)` overlay applies after, preserving its higher precedence.
 *
 * v1.0.14 T006 archivist runtime binding: canonical managed files keep
 * `{{packageRoot}}` / `{{WIKI_DIR}}` placeholders (byte-identical from any
 * install root); the same `agent.transform` resolves them in-memory for the
 * `archivist` agent only (`system` placeholders plus scoped permissions when
 * `WIKI_DIR` is set). No files are written; other roles are untouched except
 * via the T005 overlay above.
 *
  * Production wiring: native plan-id, task-scratch, Git-read, and scoped ship/release
  * tools are registered via
 * `ctx.tool.transform(editor => editor.add(...))` — no command workaround or
 * MCP sidecar. Scratch allocation uses the setup-time `ctx.location` project directory. Missing location evidence never
 * falls back to `process.cwd()`.
 */
function projectDirectoryFromContext(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const location = (ctx as { location?: unknown }).location;
  if (!location || typeof location !== "object") return undefined;
  const record = location as { project?: unknown; directory?: unknown };
  const project = record.project;
  if (project && typeof project === "object") {
    const directory = (project as { directory?: unknown }).directory;
    if (typeof directory === "string" && directory.length > 0) return directory;
  }
  if (typeof record.directory === "string" && record.directory.length > 0) return record.directory;
  return undefined;
}

const aria = Plugin.define({
  id: "aria",
  async setup(ctx) {
    const worktree = projectDirectoryFromContext(ctx);
    // T006/T021: register the native plan and scratch tools before project
    // overlays, including when no worktree exists. Each tool validates its
    // own setup-time location at execution (scratch allocation fails closed).
    // Guarded for location/tool-less hosts (e.g. smoke `setup({})`).
    const toolDomain = (ctx as { tool?: { transform?: unknown } } | undefined)?.tool;
    if (typeof toolDomain?.transform === "function") {
      await (toolDomain.transform as (callback: (editor: { add: (tool: never) => void }) => void) => Promise<unknown>)(
        (editor) => {
          editor.add(createScratchTaskTool(worktree) as never);
          editor.add(createPlanIdTool() as never);
          editor.add(createGitReadTool(worktree) as never);
          editor.add(createShipTool(getPackageRoot(), worktree) as never);
          editor.add(createReleaseTool(getPackageRoot(), worktree) as never);
        },
      );
    }
    // Project/location evidence (@opencode/plugin@2.0.23
    // dist/promise/plugin.d.ts: Context.location is Location.Info, whose
    // project is `{ id, directory, canonical }` per @opencode/schema
    // location): the worktree comes from ctx — never process.cwd(). When
    // ctx carries no project/location directory there is nothing to
    // overlay (absent => no change).
    if (!worktree) {
      return () => {
        // Native tools (T006/T021) were already registered when a tool domain exists.
      };
    }
    // Invalid project models throw per the accepted helper semantics
    // (ConfigValidationError/SyntaxError) — never silently reinterpreted.
    const overlay = readProjectAgentModelOverrides(worktree);
    const hasOverlay = Object.keys(overlay).length > 0;
    const agentDomain = (ctx as { agent?: { transform?: unknown } } | undefined)?.agent;
    if (typeof agentDomain?.transform !== "function") {
      return () => {
        // Native tools (T006/T021) were already registered when a tool domain exists.
      };
    }
    // Resolve defaults + global + project ARIA layers for every canonical role.
    // Seed those routes first, then apply OpenCode-native project agent models
    // as the higher-precedence overlay.
    const resolved = resolveAriaConfig(worktree);
    const ariaOverlay: ProjectModelOverlay = Object.fromEntries(
      ROLES.map((role) => {
        const route = resolved.roles[role];
        return [
          role,
          route.variant === undefined ? { model: route.model } : { model: route.model, variant: route.variant },
        ];
      }),
    );
    // Archivist runtime binding follows route seeding and project model overrides.
    await ctx.agent.transform((editor) => {
      const adapter = {
        get: (id: string) =>
          editor.get(id) as unknown as { model?: unknown; system?: unknown; permissions?: unknown } | undefined,
        update: (id: string, update: (agent: Record<string, unknown>) => void) => {
          editor.update(id, (agent) => {
            update(agent as unknown as Record<string, unknown>);
          });
        },
      };
      applyProjectModelTransforms(adapter, ariaOverlay);
      if (hasOverlay) {
        applyProjectModelTransforms(adapter, overlay);
      }
      applyArchivistRuntimeTransform(adapter, worktree);
    });
    return () => {
      // No additional setup-time resources require disposal.
    };
  },
});

export default aria;
