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
