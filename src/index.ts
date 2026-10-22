import { Plugin } from "@opencode/plugin";

import { createPlanTool, resolvePlanRootFromLocation } from "./plan-tool.js";
import { readProjectAriaOverrides, resolveAriaConfig } from "./overrides.js";
import {
  applyArchivistRuntimeTransform,
  applyProjectModelTransforms,
  readProjectAgentModelOverrides,
  type ProjectModelOverlay,
} from "./project-overrides.js";

/**
 * ARIA native V2 plugin foundation (T002) with project model overlays (T005),
 * the native RDC plan tool (T006), and location-independent archivist runtime
 * binding (v1.0.14 T006).
 *
 * T005 production wiring: the real plugin setup path resolves the
 * project-local `opencode.json(c)` overlay with the accepted resolver and
 * applies only the resolved per-project agent changes via the supported V2
 * `agent.transform` → `agent.update` surface (existing ARIA role IDs only,
 * model/variant fields only). Prompts, permissions, modes, unrelated agents,
 * and global agent files are never touched; project overrides are read-only
 * here and never written to disk.
 *
 * T002 effective routing: the same transform first applies the local ARIA
 * project layer (`aria.json` roles) as resolved atomic model+variant pairs
 * via the accepted `resolveAriaConfig`/`readProjectAriaOverrides` resolvers
 * and the existing `applyProjectModelTransforms` helper (model-only clears
 * the inherited variant; variant-only keeps the resolved model). The
 * OpenCode-native `opencode.json(c)` overlay applies after, so its existing
 * precedence is preserved when both layers pin the same role.
 *
 * v1.0.14 T006 archivist runtime binding: canonical managed files keep
 * `{{packageRoot}}` / `{{WIKI_DIR}}` placeholders (byte-identical from any
 * install root); the same `agent.transform` resolves them in-memory for the
 * `archivist` agent only (`system` placeholders plus scoped permissions when
 * `WIKI_DIR` is set). No files are written; other roles are untouched except
 * via the T005 overlay above.
 *
 * T006 production wiring: the shared plan tool is registered natively via
 * `ctx.tool.transform(editor => editor.add(...))` — no command workaround,
 * no MCP sidecar. The runtime owns registration only; CAS, file locking,
 * and atomic `.aria/rdc/TASKS.md` persistence stay ARIA-owned in
 * `src/plans.ts`. The persistence root is the setup-time startup location
 * (`ctx.location`); V2 `Tool.Context` carries no per-invocation directory,
 * so per-invocation scoping is a V1-only semantic (see `src/plan-tool.ts`).
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
    // T006: register the native plan tool first so it is present even when
    // there is no project overlay (or no worktree at all). The root is the
    // setup-time startup location; execution validates meaningfulness.
    // Guarded for location/tool-less hosts (e.g. smoke `setup({})`).
    const location = (ctx as { location?: unknown } | undefined)?.location;
    const planRoot = resolvePlanRootFromLocation(location);
    const toolDomain = (ctx as { tool?: { transform?: unknown } } | undefined)?.tool;
    if (typeof toolDomain?.transform === "function") {
      await (toolDomain.transform as (callback: (editor: { add: (tool: never) => void }) => void) => Promise<unknown>)(
        (editor) => {
          editor.add(createPlanTool(planRoot) as never);
        },
      );
    }
    // Project/location evidence (@opencode/plugin@2.0.23
    // dist/promise/plugin.d.ts: Context.location is Location.Info, whose
    // project is `{ id, directory, canonical }` per @opencode/schema
    // location): the worktree comes from ctx — never process.cwd(). When
    // ctx carries no project/location directory there is nothing to
    // overlay (absent => no change).
    const worktree = projectDirectoryFromContext(ctx);
    if (!worktree) {
      return () => {
        // Plan tool (T006) already registered above when a tool domain exists.
      };
    }
    // Invalid project models throw per the accepted helper semantics
    // (ConfigValidationError/SyntaxError) — never silently reinterpreted.
    const overlay = readProjectAgentModelOverrides(worktree);
    const hasOverlay = Object.keys(overlay).length > 0;
    // T002: local ARIA project routes (`aria.json` roles) were missing from
    // the runtime — managed global files carry defaults+global only, and the
    // transform above applied just `opencode.json(c)`. Resolve the
    // project-touched roles to their accepted atomic model+variant pairs and
    // apply them first; `opencode.json(c)` still applies after so its
    // existing precedence wins on conflict. Only model/variant fields of
    // existing agents are patched; empty overrides touch nothing.
    const projectAriaRoles = readProjectAriaOverrides(worktree).roles ?? {};
    const ariaTouched = Object.entries(projectAriaRoles).filter(
      ([, override]) => override?.model !== undefined || override?.variant !== undefined,
    );
    const hasAriaOverlay = ariaTouched.length > 0;
    let ariaOverlay: ProjectModelOverlay = {};
    if (hasAriaOverlay) {
      const resolved = resolveAriaConfig(worktree);
      ariaOverlay = Object.fromEntries(
        ariaTouched.map(([role]) => {
          const route = resolved.roles[role as keyof typeof resolved.roles];
          return [
            role,
            route.variant === undefined ? { model: route.model } : { model: route.model, variant: route.variant },
          ];
        }),
      );
    }
    // Archivist runtime binding always runs when an agent domain exists (it
    // resolves location-independent placeholders in-memory); model overlays
    // run only when present. Guarded for agent-less hosts: with no overlay
    // and no agent domain there is nothing to patch.
    const agentDomain = (ctx as { agent?: { transform?: unknown } } | undefined)?.agent;
    if (!hasOverlay && !hasAriaOverlay && typeof agentDomain?.transform !== "function") {
      return () => {
        // Plan tool (T006) already registered above when a tool domain exists.
      };
    }
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
      if (hasAriaOverlay) {
        applyProjectModelTransforms(adapter, ariaOverlay);
      }
      if (hasOverlay) {
        applyProjectModelTransforms(adapter, overlay);
      }
      applyArchivistRuntimeTransform(adapter, worktree);
    });
    return () => {
      // No registrations yet beyond the narrow T005 transform; reserved for T003+ disposables.
    };
  },
});

export default aria;
