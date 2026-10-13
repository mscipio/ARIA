import { describe, expect, it } from "vitest";

import { parseSubagentDepth } from "../src/deps.js";
import { runDoctor } from "../src/doctor.js";

// T005: `experimental.subagent_depth` is the V2 supported location observed
// live (`opencode debug config` nests per-source config under `info`);
// the legacy top-level field stays supported and true absence stays absent.
describe("T005 subagent-depth parsing", () => {
  it("reports experimental.subagent_depth=3 from a merged object", () => {
    expect(parseSubagentDepth('{"experimental": {"subagent_depth": 3}}')).toEqual({
      status: "value",
      depth: 3,
    });
  });

  it("reports experimental.subagent_depth=3 from live array documents nesting config under info", () => {
    const output = JSON.stringify([
      {
        type: "document",
        path: "/home/user/.config/opencode/opencode.json",
        info: { experimental: { subagent_depth: 3 } },
      },
      { type: "directory", path: "/home/user/.config/opencode" },
    ]);
    expect(parseSubagentDepth(output)).toEqual({ status: "value", depth: 3 });
  });

  it("keeps recognizing the existing top-level location", () => {
    expect(parseSubagentDepth('{"subagent_depth": 5}')).toEqual({ status: "value", depth: 5 });
  });

  it("keeps true absence distinct from a configured value", () => {
    expect(parseSubagentDepth("{}")).toEqual({ status: "absent" });
    expect(parseSubagentDepth('[{}, {"source": "project", "config": {}}]')).toEqual({
      status: "absent",
    });
  });

  it("surfaces the experimental value through doctor rather than absent", async () => {
    const report = await runDoctor({
      executor: (async (command: string, args: string[]) => {
        if (command === "opencode" && args.join(" ") === "debug config") {
          return { stdout: '{"experimental": {"subagent_depth": 3}}', stderr: "" };
        }
        throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
      }) as never,
      discovery: (async () => ({ models: [] })) as never,
    });
    const finding = report.findings.find(
      (entry) => entry.area === "config" && entry.title === "subagent depth",
    );
    expect(finding?.severity).toBe("PASS");
    expect(finding?.detail).toContain("effective value 3");
    expect(finding?.detail).not.toContain("absent");
  });
});
