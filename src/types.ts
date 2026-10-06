export type RoleName =
  | "coder"
  | "explorer"
  | "visualizer"
  | "planner"
  | "architect"
  | "implementer"
  | "reviewer"
  | "researcher"
  | "archivist"
  | "writer"
  | "scientist";

export interface RoleDefaults {
  model: string;
  variant?: string;
  mode: "primary" | "subagent" | "all";
  promptFile: string;
}

export interface AriaDefaults {
  roles: Record<RoleName, RoleDefaults>;
}

export interface RoleOverride {
  model?: string;
  variant?: string;
}

export interface AriaPluginOptions {
  configPath?: string;
  /**
   * T008: skip project-local overrides (global-only resolution). Setup and
   * doctor file verification resolve defaults plus global overrides only, so
   * a CWD project's models never bake into global managed agent files (T005:
   * project overlays are runtime-only).
   */
  skipProject?: boolean;
}

export interface AriaProjectOverrides {
  roles?: Partial<Record<RoleName, RoleOverride>>;
}

export interface ResolvedRoleConfig extends RoleDefaults {
  promptText: string;
}

export interface ResolvedAriaConfig {
  roles: Record<RoleName, ResolvedRoleConfig>;
}
