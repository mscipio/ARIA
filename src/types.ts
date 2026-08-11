export type RoleName =
  | "director"
  | "explorer"
  | "visualizer"
  | "planner"
  | "architect"
  | "implementer"
  | "reviewer"
  | "wiki-compiler";

export interface RoleDefaults {
  model: string;
  variant?: string;
  mode: "primary" | "subagent";
  promptFile: string;
}

export interface ReviewDrivenCodeDefaults {
  roles: Record<RoleName, RoleDefaults>;
}

export interface RoleOverride {
  model?: string;
  variant?: string;
}

export interface ReviewDrivenCodePluginOptions {
  configPath?: string;
}

export interface ReviewDrivenCodeProjectOverrides {
  roles?: Partial<Record<RoleName, RoleOverride>>;
}

export interface ResolvedRoleConfig extends RoleDefaults {
  promptText: string;
}

export interface ResolvedReviewDrivenCodeConfig {
  roles: Record<RoleName, ResolvedRoleConfig>;
}
