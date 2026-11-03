import { describe, expect, it } from "vitest";

import { ROLES } from "../src/overrides.js";
import { PLAN_ID_PATTERN } from "../src/scratch.js";
import { createPlanIdTool, PLAN_ID_TOOL_NAME } from "../src/plan-id-tool.js";
import { evaluatePermission, getPermissionsForRole } from "../src/permissions.js";

describe("plan_id_new native tool", () => {
  it("returns one lowercase RFC 4122 UUIDv4 per call from node's CSPRNG and reads or writes no files", async () => {
    const tool = createPlanIdTool();
    expect(tool.name).toBe(PLAN_ID_TOOL_NAME);
    expect(tool.input).toMatchObject({ type: "object", additionalProperties: false });
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const result = await tool.execute({});
      const { id } = JSON.parse(result.content) as { id: string };
      expect(id).toMatch(PLAN_ID_PATTERN);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });

  it("is granted to the Planner only; every other role falls back to ask", () => {
    for (const role of ROLES) {
      const decision = evaluatePermission(getPermissionsForRole(role), PLAN_ID_TOOL_NAME, "*");
      expect(decision).toBe(role === "planner" ? "allow" : "ask");
    }
  });

  it("rejects any input fields (no caller-supplied identity)", () => {
    const tool = createPlanIdTool();
    expect(tool.input.additionalProperties).toBe(false);
    expect(tool.input.properties).toEqual({});
  });
});
