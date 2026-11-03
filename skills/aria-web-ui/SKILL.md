---
name: aria-web-ui
description: Framework-agnostic web UI/UX guidance for accessible, responsive application design, implementation, and honest browser-based visual validation.
compatibility: opencode
metadata:
  owner: aria
---

# ARIA Web UI

Use this skill when designing, reviewing, or implementing a web application UI. It is framework-agnostic: follow the repository's current stack, component system, and design conventions rather than introducing a new framework. This skill is complementary to `aria-qt-ui`, not a replacement for Qt Widgets, PySide6, or QML guidance.

## Workflow

1. **Understand the task and the running app.** Identify the target route, user goal, existing application path, framework, design system, and approved scope. Inspect the relevant UI and its existing states before proposing changes.
2. **Analyze UX before coding.** Describe the interaction model and information hierarchy, then state testable behavioral, accessibility, and visual acceptance criteria. Keep implementation-neutral requirements separate from implementation details.
3. **Design the information hierarchy.** Make the primary task and next action clear; group related content; use consistent headings, labels, and controls. See `references/ux-foundations.md`.
4. **Set a coherent visual direction.** Use purposeful typography, spacing, proportions, and density to support hierarchy, keep navigation uncluttered, and make common tasks efficient. Give concrete aesthetic critique and iterate; do not impose a framework, theme, or generic style. See `references/ux-foundations.md`.
5. **Design for access from the start.** Use semantic structure, keyboard-operable controls, clear focus, programmatic names and descriptions, perceivable state, and sufficient contrast. See `references/accessibility.md`.
6. **Plan for real content and changing viewports.** Prefer content-driven fluid layouts; adapt navigation, columns, and controls to available space without hiding essential content or functionality. See `references/responsive-design.md`.
7. **Implement only approved scope.** Reuse existing components and tokens. Preserve application state, data, and backend contracts. Give loading, empty, error, success, disabled, and validation states intentional behavior and presentation where relevant.
8. **Validate functionally and in a browser.** Run the smallest relevant existing tests. Prefer ARIA's managed Playwright MCP when available to the Visualizer. If an authorized browser/automation route and a safe, runnable application path are available, open the actual app, capture requested viewport(s), inspect the images, record specific issues, refine, and repeat the capture and inspection. See `references/browser-validation.md`.
9. **Report evidence honestly.** Separate observed behavior from predictions and interpretation. State which routes, viewports, states, checks, and captures were actually reviewed, and disclose anything that could not be run or inspected.

## Boundaries

- Framework-agnostic does not mean architecture-agnostic: preserve the project's stack and established patterns; do not add dependencies or rewrite unrelated logic.
- For maintenance, respect the established design system and preserve existing appearance, layout, and navigation except for approved changes. Only an explicitly approved redesign removes the requirement to match old appearance/layout/navigation; it must preserve required user tasks, accessibility and interaction requirements, app state/data, and backend contracts. A request to polish the UI alone is not redesign approval.
- Aesthetic direction is product-specific, not a required framework or theme. Critique concrete hierarchy, typography, spacing, proportions, navigation clutter, and task friction rather than relying only on subjective labels such as “modern.”
- Do not claim accessibility conformance from a checklist, automated scan, or screenshot alone. Treat WCAG 2.2 AA as a useful design target where applicable, and report the scope and limits of any actual audit.
- Do not infer browser rendering from source code, mockups, or component tests. A browser screenshot is evidence only for the captured app, route, state, and viewport.
- Browser automation is optional and must already be available and authorized. Prefer the ARIA-managed Playwright MCP where provided; do not install Playwright or other packages, configure global MCP, or fabricate an alternate route. If it is unavailable, use another suitable already-available authorized browser route, or report browser validation as blocked and use appropriate deterministic functional checks. Never claim screenshots or visual inspection that did not occur.
- Do not capture screenshots automatically on every task; capture only when the delegated work requires visual evidence.
- Keep captures and other transient/generated artifacts under a unique project-local `.aria/scratch/unplanned/<timestamp>-<description>/` activity directory, using local calendar date/time and a descriptive title. No task ID, approved Plan, or `scratch_task` allocation is required. Approvals are required, not an OS sandbox.
