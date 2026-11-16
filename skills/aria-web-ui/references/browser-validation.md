# Browser Validation: Capture, Inspect, Refine, Verify

Visual validation is evidence gathered from the actual application, not an inference from source or a generated mockup. Capture only when the delegated task requires visual evidence. Keep captures and other transient/generated artifacts in your ARIA scratch directory (the exact path given in your context, in an activity subdirectory `YYYYMMDD-HHMMSS-short-kebab-description` made with plain `mkdir`). Deliverables and intentional source edits go in their proper place. Scratch is a convention, not an OS sandbox.

## 1. Establish a safe target

- Identify the project's documented or already-used start command, target route, representative state, and relevant viewport(s). Reuse the current project path and existing dependencies.
- Start or open the actual app only when the path and command are safe, feasible, and in scope. Do not invent seed data, bypass authentication, or access unrelated systems.
- Use the Playwright MCP (server `playwright`, tools `playwright_*`) when it is configured; each call may ask the user, and a refusal is final for this request. Otherwise use another suitable browser route only if it is already available and authorized. Never install browser tooling or configure global MCP as part of validation, and do not imply a browser tool exists when it does not.
- Browser tools may write their own output (snapshots, screenshots, profiles) to locations the tool chooses, possibly outside scratch. Say so instead of claiming scratch containment; where a tool takes an output path, point it into scratch.
- If the app cannot be launched safely or no suitable authorized browser route is available, state that limitation and mark browser validation blocked before substituting narrower functional checks. Do not claim browser validation.

## 2. Capture an explicit claim

For each capture, record the actual route or screen, state, viewport width/height, whether this is maintenance or an explicitly approved redesign, and the expected criterion. Capture the rendered application at the requested desktop and/or narrow viewport; add another size only when needed to inspect a responsive transition. Do not capture unrelated sensitive content.

### Maintenance or approved redesign

- For maintenance, assess against the established visual system and preserve the existing appearance, layout, and navigation except for approved changes.
- Only an explicitly approved redesign removes old-appearance/layout/navigation fidelity as a criterion. Continue to assess required user tasks, accessibility and interaction requirements, application state/data, and backend contracts. A request to polish the interface is not by itself redesign approval.

## 3. Inspect the captured image and interaction

Inspect the image itself, not only the DOM or screenshot metadata. Compare it to the acceptance criteria and note concrete observations:

- Is the page hierarchy clear, and is the primary action apparent?
- Do typography, spacing, proportions, and content density form a coherent hierarchy suited to the product, without imposing a particular framework or theme?
- Is navigation focused on useful destinations, with common tasks efficient and secondary destinations/context still discoverable?
- Are labels, values, and controls aligned and legible without clipping or overlap?
- Do loading, empty, error, success, disabled, and selected states communicate the right status when relevant?
- At narrow widths, does content reflow while essential content and actions remain available? Is unexpected horizontal overflow present?
- Are visible focus and interaction states inspectable? Which keyboard checks were actually performed separately?
- For maintenance, does the result respect the existing product design language and approved scope? For an explicitly approved redesign, does it meet the approved visual direction without requiring the old appearance, layout, or navigation to remain?

A screenshot alone does not prove keyboard accessibility, screen-reader announcements, working controls, responsive behavior at every size, or accessibility conformance.

## 4. Refine and verify

Keep the visual loop bounded: inspect the relevant current state, make the smallest approved correction, then recapture and recheck the affected criterion. Stop when the criterion is met or further work is out of scope; report remaining issues instead of expanding the iteration.

Turn each observed issue into a specific change. After refinement, repeat the same capture and inspection at the same route, state, and viewport to verify the criterion; capture additional sizes only for relevant responsive changes. Re-run the smallest relevant functional tests and keyboard checks. Keep the before/after claims limited to evidence actually observed.

## 5. Fallback and report

If browser access or safe launch is unavailable, do not fabricate screenshots or describe predictions as observations. Run deterministic project tests that are available and in scope, request human inspection where a screenshot can be provided safely, and clearly report what was not visually validated. Automated checks and model-generated opinions do not replace inspection of the actual capture.

If no verified, authorized image-capable reviewer is available, say so plainly; do not assume model vision or invent an alternate route. Where possible, provide actual captures for human review and pair that review with deterministic functional and keyboard checks. If no human or image-capable reviewer inspects the captures, visual findings remain unverified and the result is not visually validated. Any existing authorized model-vision route is supplemental, not a replacement for human inspection or deterministic checks.

Report the browser/tool used if known, actual route/state/viewports inspected, functional and keyboard checks performed, findings and refinements, and any limitations. Separate verified observation from prediction and interpretation.
