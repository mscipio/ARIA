import { describe, expect, it } from "vitest";

import aria from "../src/index";

/**
 * T002 native V2 plugin foundation: identity, setup, and cleanup only.
 * Agent, permission, skill, and plan-tool wiring is owned by T003+.
 */
describe("aria V2 plugin foundation", () => {
  it("exposes the native V2 shape with no V1 server shim", () => {
    expect(aria.id).toBe("aria");
    expect(typeof aria.setup).toBe("function");
    expect(aria).not.toHaveProperty("server");
  });

  it("setup resolves a cleanup function and cleanup completes", async () => {
    const cleanup = await aria.setup({} as never);
    expect(typeof cleanup).toBe("function");
    await cleanup?.();
  });
});
