export type RoleName =
  | "director"
  | "explorer"
  | "visualizer"
  | "planner"
  | "architect"
  | "implementer"
  | "reviewer";

export interface RoleDefaults {
  model: string;
  variant?: string;
  mode: "primary" | "subagent";
  promptFile: string;
}

export interface ReviewDrivenCodeDefaults {
  roles: Record<RoleName, RoleDefaults>;
}

export interface ReviewDrivenCodePluginOptions {
  configPath?: string;
}

export interface ReviewDrivenCodeProjectOverrides {
  models?: Partial<Record<RoleName, string>>;
  variants?: Partial<Record<RoleName, string>>;
}

export interface ResolvedRoleConfig extends RoleDefaults {
  promptText: string;
}

export interface ResolvedReviewDrivenCodeConfig {
  roles: Record<RoleName, ResolvedRoleConfig>;
}
