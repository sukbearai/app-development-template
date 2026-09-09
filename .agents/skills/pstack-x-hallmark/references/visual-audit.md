# Audit the visible result

Start with the user's task, the current design, and the named page or component. Evaluate whether people can read, navigate, and complete that task. Treat stylistic preferences as recommendations, not defects.

## Inspect the relevant dimensions

| Dimension             | Look for                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hierarchy             | A clear page purpose and primary action. Headings align with their content. Size, weight, and spacing distinguish sections without repeated heavy containers.                                          |
| Layout                | Spacing separates different tasks and groups related controls. Tables retain useful comparison. Equal cards are a problem when they flatten meaningful differences, not merely because they are equal. |
| Typography            | Readable body text, useful heading scale, stable line lengths, and aligned numeric columns. Check long labels, real data, and the product's languages.                                                 |
| Color                 | Consistent semantic tokens and visible distinctions between text, controls, selection, and status. Check muted text, accent buttons, and text on changed backgrounds.                                  |
| Interaction           | Keyboard focus, pointer feedback, disabled behavior, loading, validation, and completion feedback where applicable. Identify missing states by the component's actual behavior.                        |
| Responsive behavior   | Content remains reachable at narrow widths and zoom. Controls, dialogs, menus, long words, and tables fit or have usable local scrolling.                                                              |
| Content and restraint | Labels name real actions. Empty and error states explain what happened. Metrics, testimonials, and claims have sources. Decoration does not compete with work.                                         |

For text contrast, use WCAG ratios of at least 4.5:1 for normal text and 3:1 for large text. Check meaningful non-text controls and focus indicators against adjacent colors at 3:1 where applicable. Inspect the actual rendered color pairs; token names alone do not prove contrast. Do not treat APCA scores as interchangeable with WCAG ratios.

Use 320, 375, 414, and 768 CSS pixels as useful narrow-width probes, plus the actual desktop target. Inspect relevant content breakpoints rather than treating those widths as exhaustive. Check keyboard access, zoom, and reduced motion when the affected UI makes them relevant. State the viewports and states actually observed.

For horizontal overflow, identify the element and sizing rule that causes it. Check fixed minimum widths, `100vw`, long unbroken text, grid tracks, and missing `min-width: 0`. Page-level clipping can hide inaccessible content and is not evidence that the layout works. A locally scrollable data table can be an intentional design.

## Separate observations from hypotheses

A screenshot proves only the visible state and viewport. Source inspection can identify likely focus or overflow problems, but it does not prove how the browser renders them. If runtime access is missing, mark those findings as source-based and name the browser check that would settle them.

Prioritize by user impact, not how strongly something resembles a template. Report each finding with its severity, location, evidence, consequence, and smallest useful correction.

- High impact means the UI blocks a task or makes essential content or controls inaccessible.
- Medium impact means the UI creates a material readability, navigation, or interaction problem.
- Low impact means an inconsistency or optional refinement has limited practical effect.

Keep speculative improvements separate from confirmed defects. If no defect is supported, say so and list the inspection limits. Do not modify files while auditing, even when the correction is obvious.

Adapted from Hallmark v1.1.0 at `13ac0ec7e148655948100b6396439e481361d690`, especially `references/verbs/audit.md`, `anti-patterns.md`, `layout-and-space.md`, `typography.md`, `interaction-and-states.md`, and `responsive.md`. Severity here describes user impact; upstream taste bans and mandatory self-scoring are not carried over.
