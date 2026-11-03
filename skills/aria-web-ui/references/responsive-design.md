# Responsive Web Design

Use content-driven, fluid layouts that respond to the space and input modality the interface actually has. Use the product's established breakpoints and tokens when available; introduce or change them only when the approved scope and evidence justify it.

## Layout behavior

- Start from the content hierarchy and allow columns, navigation, and side panels to adapt as space narrows. Prefer flexible tracks, intrinsic sizing, wrapping, and bounded fluid widths over fixed viewport assumptions.
- Choose breakpoints where content or controls stop working well, not only to match named devices.
- Reflow lower-priority panels while preserving access to their content and actions. If a wide table or canvas needs two-dimensional scrolling, keep the scroll region clear and usable without forcing unrelated page content to scroll horizontally.
- Keep touch targets reachable, distinct, and sufficiently spaced. Avoid hover-only actions; ensure pointer, touch, keyboard, and assistive-technology access to the same essential operations.
- Account for browser chrome, safe areas, sticky elements, virtual keyboards, and reduced available height where they affect the actual workflow.

## Content and controls

- Test long titles, translated labels, validation messages, large text, empty results, and dense data. Allow text and controls to wrap or grow without overlap or clipped meaning.
- Keep primary actions discoverable at narrow widths. If an action moves into an overflow menu or drawer, retain a clear label, keyboard access, and state indication.
- Preserve context when a desktop multi-column layout becomes a narrow stacked flow. Keep headings and actions with their related content.
- Images and visualizations should fit their container without distorting meaning. Label any required pan/zoom or horizontal-scroll interaction.

## Viewport review

Review the actual page at a representative wide viewport and a narrow viewport relevant to the user task; include intermediate sizes when the layout has meaningful transitions. Record viewport dimensions and any state-specific limits. Check for clipped content, overlap, unexpected horizontal overflow, unreachable controls, and loss of information or task context.

No finite set of viewport captures proves responsive correctness at every size. Where available, combine browser inspection with deterministic layout tests and human review.
