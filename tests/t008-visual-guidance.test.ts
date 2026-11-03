import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const visualizer = read("defaults/prompts/visualizer.md");
const webSkill = read("skills/aria-web-ui/SKILL.md");
const uxFoundations = read("skills/aria-web-ui/references/ux-foundations.md");
const browserValidation = read("skills/aria-web-ui/references/browser-validation.md");
const qtValidation = read("skills/aria-qt-ui/references/visual-validation.md");

describe("T008 framework-neutral visual guidance", () => {
  it("distinguishes maintenance from approved redesign without losing functional contracts", () => {
    for (const text of [visualizer, webSkill, uxFoundations, browserValidation]) {
      expect(text).toMatch(/maintenance/i);
      expect(text).toMatch(/explicitly approved redesign/i);
      expect(text).toMatch(/backend contracts/i);
    }
    expect(visualizer).toMatch(/old appearance, layout, or navigation/i);
    expect(browserValidation).toMatch(/without requiring the old appearance, layout, or navigation/i);
  });

  it("calls for concrete, coherent visual critique without prescribing a framework or theme", () => {
    for (const text of [visualizer, webSkill, uxFoundations, browserValidation]) {
      expect(text).toMatch(/typography/i);
      expect(text).toMatch(/spacing/i);
      expect(text).toMatch(/proportions/i);
    }
    expect(uxFoundations).toMatch(/navigation focused on useful destinations/i);
    expect(uxFoundations).toMatch(/scoped refinements/i);
    expect(visualizer).toMatch(/Do not require a particular framework, theme/i);
    expect(webSkill).toMatch(/do not impose a framework, theme/i);
    expect(browserValidation).toMatch(/navigation focused on useful destinations, with common tasks efficient/i);
    expect(browserValidation).toMatch(/without imposing a particular framework or theme/i);
  });

  it("documents capture routes appropriate to Widgets and QML/Qt Quick", () => {
    expect(visualizer).toMatch(/Qt Widgets.*QWidget\.grab/s);
    expect(visualizer).toMatch(/QML\/Qt Quick.*QScreen\.grabWindow/s);
    expect(visualizer).toMatch(/do not assume `QWidget\.grab` captures a standalone Qt Quick window/i);
    expect(qtValidation).toMatch(/Qt Widgets\/PySide6.*QWidget\.grab/s);
    expect(qtValidation).toMatch(/QML\/Qt Quick.*QScreen\.grabWindow/s);
  });

  it("provides self-contained vision-unavailable reporting and retains optional browser validation", () => {
    expect(visualizer).toMatch(/If no verified, authorized image-capable reviewer is available/i);
    expect(visualizer).toMatch(/not visually validated/i);
    expect(browserValidation).toMatch(/If no verified, authorized image-capable reviewer is available/i);
    expect(qtValidation).toMatch(/When image-capable vision is unavailable/i);
    expect(qtValidation).toMatch(/not visually validated/i);
    expect(webSkill).toMatch(/If an authorized browser\/automation route .* available/i);
  });

  it("does not retain the ambiguous T001 fallback wording", () => {
    expect(visualizer).not.toMatch(/T001 fallback/i);
    expect(qtValidation).not.toMatch(/T001/i);
  });
});
