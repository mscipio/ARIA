# Web UX Foundations

Use these checks to turn a request into a coherent, testable interaction design. Adapt to the product and existing system; do not impose a generic page template.

## Hierarchy and task flow

- Name the page or task in a clear, concise heading. Make the primary action visually and semantically distinct without making secondary actions disappear.
- Group information by user meaning and sequence. Keep related labels, values, controls, help, and validation feedback close together.
- Prefer familiar, specific action labels. Make destructive or irreversible consequences clear before the action; offer a clear cancel or recovery path when appropriate.
- Avoid requiring users to remember information across distant regions or steps when it can be shown in context.
- Preserve orientation in multi-step work: current step, completed steps, and the next available action should be distinguishable.

## Interaction and state

For each important flow, specify the initial state, user action, resulting state, and recovery path. Cover the states that the feature actually has, including:

- loading or pending work, with progress and cancellation where appropriate;
- no data yet versus a filtered search with no matches;
- validation errors, including which field needs attention and how to fix it;
- recoverable and blocking errors, with retry or next steps where available;
- success confirmation and the next useful action;
- disabled, read-only, permission-limited, or stale data states where relevant.

Do not use color, animation, hover, or icon alone to communicate meaning. Preserve submitted values after recoverable failures. Prevent duplicate submissions where the operation is pending, and do not imply success before the underlying operation completes.

## Visual system and content

- For maintenance, reuse the established type, spacing, color, border, elevation, and control tokens and preserve the existing visual language. Respect current layout and navigation unless their change is approved. Only an explicitly approved redesign relaxes fidelity to the old appearance, layout, or navigation; preserve the required tasks, accessible interactions, application state/data, and backend contracts. A request to polish or improve the UI does not itself approve a redesign.
- Create a coherent visual direction that fits the product without prescribing a framework, theme, or generic aesthetic. Establish hierarchy with consistent typography and a type scale, readable line lengths, deliberate spacing rhythm, and purposeful proportions/density before adding decoration. Relate visual weight to importance; avoid gratuitous cards, dividers, ornament, or competing emphasis that adds clutter.
- Keep navigation focused on useful destinations and common tasks. Avoid duplicate or low-value choices and unnecessary steps, but keep secondary destinations and task context discoverable. Make the primary task and next action apparent without weakening needed confirmations or recovery paths.
- During aesthetic critique, name observable issues (for example, inconsistent heading scale, cramped groups, disproportionate panels, competing actions, or redundant navigation), make scoped refinements, then re-inspect the rendered result. Do not accept “looks modern/clean” as the sole criterion.
- Use concise, plain-language labels and instructions. Put hints before the user needs them; connect help and error text to the control it describes.
- Make interactive states distinguishable: rest, hover where relevant, keyboard focus, active/selected, disabled, pending, and invalid.
- Test with representative short and long text, empty values, and localized or user-generated content when the UI supports them. Avoid brittle fixed heights and truncation that removes essential meaning.
- Keep charts, status badges, and visual summaries understandable with text or other non-color cues; retain source values and units when they matter to the task.

## Acceptance criteria

Write observable criteria, for example: “Submitting an invalid date leaves the entered values intact, moves focus to or announces the first invalid field, and displays a specific correction message associated with that field”; “The primary action is visually distinct through the established type and spacing hierarchy, while secondary navigation remains findable”; or “After the explicitly approved redesign, the required task and backend interaction still work even though the old navigation layout is not retained.” Avoid subjective-only requirements such as “looks clean” or “feels modern.”
