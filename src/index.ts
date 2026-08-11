import { reviewDrivenCodePlugin } from "./register.js";

const plugin = {
  id: "review-driven-code",
  server: reviewDrivenCodePlugin,
};

export default plugin;
export { plugin, plugin as reviewDrivenCodePlugin };
export type { Plugin } from "@opencode-ai/plugin";
