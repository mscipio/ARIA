import { type Executor } from "./deps.js";
import { type ModelDiscoverFn } from "./model-config.js";
/**
 * Read-only ARIA doctor: aggregates package, config, routes/models, skills,
 * required integrations, and optional ZotPilot/Wiki probes into
 * PASS/WARN/FAIL/SKIP findings. Probe and config errors are aggregated into
 * findings rather than thrown, and nothing is written, installed, or
 * repaired.
 */
export type DoctorFindingSeverity = "PASS" | "WARN" | "FAIL" | "SKIP";
export interface DoctorFinding {
    severity: DoctorFindingSeverity;
    /** Finding group: "package", "config", "routes/models", "dependencies", "skills", "zotpilot", "wiki". */
    area: string;
    title: string;
    detail?: string;
}
export interface DoctorReport {
    findings: DoctorFinding[];
}
/** Read-only stat result used for non-mutating metadata checks. */
export interface DoctorFileStat {
    isDirectory(): boolean;
    isFile(): boolean;
}
/** Read-only filesystem seam used for package/skill/wiki validation. */
export interface DoctorFileOps {
    readText(path: string): Promise<string>;
    /** Non-mutating metadata check (defaults to node:fs stat). */
    stat?(path: string): Promise<DoctorFileStat>;
    /** Non-mutating accessibility check (defaults to node:fs access). */
    access?(path: string, mode: number): Promise<void>;
}
export interface DoctorOptions {
    /** Command execution seam for the composed dependency doctor. */
    executor?: Executor;
    /** Model discovery seam (defaults to `discoverAvailableModels`). */
    discovery?: ModelDiscoverFn;
    /** Worktree whose config and resolved routes are inspected. */
    worktree?: string;
    /** Read-only filesystem seam for package validation (defaults to node:fs). */
    fileOps?: DoctorFileOps;
    /**
     * T008 V2 runtime snapshot (plugin/agent/skill/tool lists, session count).
     * Built from a live plugin `Context` via `snapshotFromContext`; absent
     * outside a live 2.0.23 session, where runtime findings report SKIP with
     * the documented gap (the standalone CLI never guesses live state).
     */
    v2?: DoctorV2Snapshot;
    /** Managed agent directory verified by the file finding (defaults to global). */
    agentsDir?: string;
}
/**
 * Pinned `@opencode/plugin@2.0.23` Context domain inspection
 * (`dist/promise/plugin.d.ts`):
 * - `plugin: Pick<PluginApi, "list">` — V2 plugin inventory (used).
 * - `agent: AgentDomain extends AgentApi` — `list()` carries full
 *   `Agent.Info` (id/mode/model/permissions); per-agent `get()` adds
 *   nothing, so only `list()` is used.
 * - `skill: SkillDomain extends SkillApi` — `list()` carries `Skill.Info`
 *   (id/name); used. `ctx.skill.transform` stays unused (T007 single
 *   source is config discovery).
 * - `tool: ToolDomain` — `list()` returns the effective post-transform
 *   tools (plugin-local); used for the plan-tool-once check. There is no
 *   `tool` HTTP client API, so this list is runtime-only.
 * - `session: SessionDomain extends SessionApi` — `list()` observes live
 *   sessions; informational only (sessions carry no ARIA registration
 *   state), best-effort.
 *
 * Documented gaps (no guessing): Context has no `config` domain
 * (`config.get` is unavailable to plugins), so merged-config state is
 * verified through the global files setup wrote plus the advisory
 * read-only `debug config` probe — never as authoritative truth. There is
 * no `debug` domain. Permission saved/request lists add nothing beyond the
 * agent permissions observed directly. `ctx.*.list` is unreachable from the
 * standalone CLI, which reports SKIP (never FAIL) for runtime findings.
 */
/** Pinned OpenCode runtime target (plan T001 audit gate + exact dep pin). */
export declare const SUPPORTED_OPENCODE_VERSION = "2.0.23";
/** Structural V2 agent entry (only the fields findings inspect). */
export interface DoctorV2AgentEntry {
    id: string;
    mode?: unknown;
    model?: unknown;
    permissions?: unknown;
}
/** Structural V2 plugin entry (`PluginInfo.id` is optional upstream). */
export interface DoctorV2PluginEntry {
    id?: unknown;
    state?: unknown;
}
/** Structural V2 skill entry (`Skill.Info` id/name). */
export interface DoctorV2SkillEntry {
    id?: unknown;
    name?: unknown;
}
/** Structural V2 tool entry (effective name plus id). */
export interface DoctorV2ToolEntry {
    id?: unknown;
    name?: unknown;
}
/**
 * V2 runtime snapshot: the primary truth for setup verification. Every
 * field is optional; absent fields mean "unobserved" (SKIP), never healthy
 * or broken.
 */
export interface DoctorV2Snapshot {
    plugins?: DoctorV2PluginEntry[] | undefined;
    agents?: DoctorV2AgentEntry[] | undefined;
    skills?: DoctorV2SkillEntry[] | undefined;
    tools?: DoctorV2ToolEntry[] | undefined;
    /** Live session count when a runtime session list was observed. */
    sessionsObserved?: number | undefined;
}
/**
 * Build a V2 snapshot from a live plugin `Context`. Every domain list is
 * attempted independently and defensively: a missing domain or a throwing
 * list degrades that field to unobserved (SKIP downstream), never to a
 * failure. Client lists return `{data: [...]}` while `ctx.tool.list()`
 * returns the entry array directly; both shapes are accepted.
 */
export declare function snapshotFromContext(ctx: unknown): Promise<DoctorV2Snapshot>;
export declare function runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
/**
 * Expanded-report exit code: exactly 0 when no finding is FAIL, otherwise 1.
 */
export declare function doctorExitCode(findings: readonly DoctorFinding[]): number;
/** Compact plain-text rendering with literal PASS/WARN/FAIL/SKIP labels. */
export declare function formatDoctorReport(report: DoctorReport): string;
//# sourceMappingURL=doctor.d.ts.map