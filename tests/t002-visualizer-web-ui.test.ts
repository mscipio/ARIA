import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generateAgentFile } from "../src/agents";
import { loadDefaultConfig } from "../src/defaults";

const root = process.cwd();
const visualizerPromptPath = resolve(root, "defaults/prompts/visualizer.md");
const webSkillRoot = resolve(root, "skills/aria-web-ui");

describe("framework-agnostic visualizer web UI specialization", () => {
  it("loads the visualizer prompt into the generated agent while retaining Qt guidance", () => {
    const prompt = readFileSync(visualizerPromptPath, "utf8");
    const role = loadDefaultConfig().roles.visualizer;
    const generated = generateAgentFile("visualizer", { ...role, promptText: prompt }, "test-version");

    expect(generated).toContain("Framework-agnostic UI/UX Engineer");
    expect(generated).toContain("Before analysis or implementation, identify the target platform");
    expect(generated).toContain("`aria-web-ui`");
    expect(generated).toContain("`aria-qt-ui`");
    expect(generated).toContain("Qt Widgets/PySide6 layouts");
    expect(generated).toContain("QML remains within `aria-qt-ui`");
    expect(generated).toContain("capture→inspect→refine→verify");
  });

  it("documents accessible responsive web UX and honest actual-browser critique/refinement", () => {
    const skill = readFileSync(resolve(webSkillRoot, "SKILL.md"), "utf8");
    const accessibility = readFileSync(resolve(webSkillRoot, "references/accessibility.md"), "utf8");
    const responsive = readFileSync(resolve(webSkillRoot, "references/responsive-design.md"), "utf8");
    const browser = readFileSync(resolve(webSkillRoot, "references/browser-validation.md"), "utf8");

    expect(skill).toContain("name: aria-web-ui");
    expect(skill).toContain("framework-agnostic");
    expect(skill).toContain("aria-qt-ui");
    expect(accessibility).toContain("operable using a keyboard");
    expect(accessibility).toContain("using color alone");
    expect(responsive).toContain("content-driven");
    expect(responsive).toContain("narrow viewport");
    expect(browser).toContain("actual application");
    expect(browser).toContain("Inspect the image itself");
    expect(browser).toContain("repeat the same capture and inspection");
    expect(browser).toContain("Do not claim browser validation");
    expect(browser).toContain("never install it");
  });
});
