# Web Accessibility

Accessibility is part of the interaction contract, not a final styling pass. Prefer native HTML semantics and controls, and verify the actual rendered experience. WCAG 2.2 AA can be a design target; do not claim conformance without a clearly scoped audit.

## Structure and names

- Use headings in a meaningful hierarchy, landmarks for major page regions, lists for grouped items, and native buttons, links, inputs, selects, and form elements for their intended actions.
- Give every control a visible label or an appropriate programmatic name. Do not use placeholder text as the only label. Associate hints and error messages with their fields.
- Give informative images concise alternatives; mark decorative images so they do not add redundant announcements. Provide a non-color explanation for meaningful chart or status information.
- Use accessible names that describe the action or destination, not generic text such as “click here.”

## Keyboard and focus

- Every interactive action must be operable using a keyboard, with a logical focus order and a clearly visible focus indicator.
- Keep focus behavior predictable when opening/closing dialogs, menus, disclosures, tabs, and dynamic content. Do not create keyboard traps; restore focus appropriately when a transient surface closes.
- Do not use positive `tabindex` values to simulate reading order. Use native semantics and DOM order.
- Shortcuts must not conflict with browser or assistive-technology commands and must have a clear discoverable alternative.

## Perceivable state and feedback

- Do not convey state using color alone. Pair color with text, shape, iconography, or another perceivable cue.
- Maintain readable text and control contrast against actual backgrounds; verify tokens and state combinations, not only the default state. Do not certify contrast based on visual impression alone.
- Announce important asynchronous updates and validation results appropriately without making every keystroke noisy. Preserve context and focus when status changes.
- Respect reduced-motion preferences and avoid flashing, unnecessary motion, or motion that blocks task completion.
- Ensure controls have usable target sizes and spacing, including touch input; don't rely on hover-only disclosure.

## Verification

- Test key flows with keyboard only: navigate, operate controls, dismiss transient UI, submit forms, and recover from errors.
- Inspect accessible names, roles, states, and relationships in the rendered application when suitable tools are available.
- Automated accessibility tools can reveal some issues but cannot verify all keyboard, screen-reader, content, or task-flow behavior. Report exactly which checks ran.
- Test zoom/reflow and user preferences that are relevant to the product. Do not interpret an unobstructed screenshot as proof of accessibility.
