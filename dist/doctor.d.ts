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
}
export declare function runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
/**
 * Expanded-report exit code: exactly 0 when no finding is FAIL, otherwise 1.
 */
export declare function doctorExitCode(findings: readonly DoctorFinding[]): number;
/** Compact plain-text rendering with literal PASS/WARN/FAIL/SKIP labels. */
export declare function formatDoctorReport(report: DoctorReport): string;
//# sourceMappingURL=doctor.d.ts.map