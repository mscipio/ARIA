import { Plugin } from "@opencode/plugin";
import { createPlanTool, resolvePlanRootFromLocation } from "./plan-tool.js";
import { applyProjectModelTransforms, readProjectAgentModelOverrides, } from "./project-overrides.js";
/**
 * ARIA native V2 plugin foundation (T002) with project model overlays (T005)
 * and the native RDC plan tool (T006).
 *
 * T005 production wiring: the real plugin setup path resolves the
 * project-local `opencode.json(c)` overlay with the accepted resolver and
 * applies only the resolved per-project agent changes via the supported V2
 * `agent.transform` → `agent.update` surface (existing ARIA role IDs only,
 * model/variant fields only). Prompts, permissions, modes, unrelated agents,
 * and global agent files are never touched; project overrides are read-only
 * here and never written to disk.
 *
 * T006 production wiring: the shared plan tool is registered natively via
 * `ctx.tool.transform(editor => editor.add(...))` — no command workaround,
 * no MCP sidecar. The runtime owns registration only; CAS, file locking,
 * and atomic `.aria/rdc/TASKS.md` persistence stay ARIA-owned in
 * `src/plans.ts`. The persistence root is the setup-time startup location
 * (`ctx.location`); V2 `Tool.Context` carries no per-invocation directory,
 * so per-invocation scoping is a V1-only semantic (see `src/plan-tool.ts`).
 */
function projectDirectoryFromContext(ctx) {
    if (!ctx || typeof ctx !== "object")
        return undefined;
    const location = ctx.location;
    if (!location || typeof location !== "object")
        return undefined;
    const record = location;
    const project = record.project;
    if (project && typeof project === "object") {
        const directory = project.directory;
        if (typeof directory === "string" && directory.length > 0)
            return directory;
    }
    if (typeof record.directory === "string" && record.directory.length > 0)
        return record.directory;
    return undefined;
}
const aria = Plugin.define({
    id: "aria",
    async setup(ctx) {
        // T006: register the native plan tool first so it is present even when
        // there is no project overlay (or no worktree at all). The root is the
        // setup-time startup location; execution validates meaningfulness.
        // Guarded for location/tool-less hosts (e.g. smoke `setup({})`).
        const location = ctx?.location;
        const planRoot = resolvePlanRootFromLocation(location);
        const toolDomain = ctx?.tool;
        if (typeof toolDomain?.transform === "function") {
            await toolDomain.transform((editor) => {
                editor.add(createPlanTool(planRoot));
            });
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
        // Absent => no change: with no overlaid roles there is nothing to
        // patch, so no transform is registered.
        if (Object.keys(overlay).length === 0) {
            return () => {
                // Plan tool (T006) already registered above when a tool domain exists.
            };
        }
        await ctx.agent.transform((editor) => {
            applyProjectModelTransforms({
                get: (id) => editor.get(id),
                update: (id, update) => {
                    editor.update(id, (agent) => {
                        update(agent);
                    });
                },
            }, overlay);
        });
        return () => {
            // No registrations yet beyond the narrow T005 transform; reserved for T003+ disposables.
        };
    },
});
export default aria;
//# sourceMappingURL=index.js.map