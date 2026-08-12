import { ariaPlugin } from "./register.js";

const plugin = {
  id: "aria",
  server: ariaPlugin,
};

export default plugin;
export { plugin, plugin as ariaPlugin };
export type { Plugin } from "@opencode-ai/plugin";
