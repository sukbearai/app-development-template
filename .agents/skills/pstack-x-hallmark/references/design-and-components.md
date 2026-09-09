# Design within the existing application

Read the owning components, styles, and nearby examples. State the intended change and likely files briefly, then perform the work already authorized. Ask only when missing context changes the outcome and cannot be inferred from the task or current product.

## Choose a structure that fits the content

For administration pages, use the existing application shell and navigation. Establish hierarchy through content order, alignment, type scale, and spacing before adding decoration. Vary space according to relationships: keep a label close to its field and separate independent groups more clearly.

For a new page or a requested structural redesign, use [design reference selection](design-selection.md). It offers optional technical styling, aligned data layouts, screenshot tours, real workflows, and interactive component documentation. Apply only the references that fit the content.

For genuinely different content, consider these adapted Hallmark patterns:

| Content                                     | Useful structure                                                      | Constraint                                                             |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Comparable values or specifications         | A semantic table with clear row headings, units, and tabular numerals | Preserve column relationships and provide local scrolling when needed. |
| A real ordered workflow                     | An ordered sequence with a heading and explanation for each step      | Number actual stages; do not add decorative section numbers.           |
| An explanation supported by a product image | Text beside a real capture, stacked when narrow                       | Keep a readable text measure and let the image shrink.                 |
| Repeated records or settings                | Consistent rows or controls with meaningful grouping                  | Repetition supports scanning. Do not force asymmetry or card variety.  |

Use distinct heading and body roles without adding font families by default. For longer prose, roughly 45 to 75 characters per line and a line height near 1.5 to 1.65 are useful starting points. Adapt to the script, language, and density. Size headings for the actual copy, including long names and translated labels.

Consume `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted`, `--border`, and the current surface and status tokens from `apps/web/app/globals.css`. Inspect their current values. Preserve status colors and the existing font stack. If a new semantic token is needed, define it in that authority and use it consistently. A new color space or font is not required for a visual improvement.

If the user requests a distinct marketing or showcase theme, scope its palette and typography to that page in the owning stylesheet or component. This is the exception to reusing the existing font and palette, not a reason to overwrite the shared tokens or administration shell.

Pair changed backgrounds with readable text and icon colors. Use accents to identify actions or state, rather than decorating every container. Verify contrast on muted surfaces and primary buttons. Never invent product metrics, customer logos, testimonials, or user data to fill a layout.

## Make component states useful

Review default, hover, focus, pressed, disabled, loading, error, and success states, then implement the ones supported by the component. A static badge does not need eight artificial variants. Do not introduce new business behavior merely to fill a state matrix.

- Keep a visible, immediate `:focus-visible` indicator. Do not remove the browser outline without a working replacement.
- Keep border thickness and control geometry stable when focus or validation changes. Use color or an outline rather than resizing the field.
- Match adjacent input and button heights. Reserve room for an existing status icon or helper text when it prevents distracting shifts, while allowing long errors to wrap.
- Keep visible labels and associate errors with their fields. Error messages need text and an actionable explanation, not just color.
- Preserve native control semantics. Use `disabled` where appropriate; `aria-disabled` alone does not prevent activation. Verify actual keyboard and pointer behavior.
- Keep loading labels understandable and prevent duplicate submission through the existing request behavior. Preserve existing validation timing and data handling unless the task requests a change.
- Check dialog focus entry and return, keyboard containment, dismissal, and access to controls on short screens. Reuse the established dialog implementation.
- Aim for comfortable touch targets, commonly 44 by 44 CSS pixels, without overlapping adjacent controls. Hover effects need keyboard and touch equivalents.

Represent applicable states in the existing Storybook stories and verify real interactions. Prefer the current story request handlers to a new standalone preview page. Keep mocks in stories, not in production data paths.

## Fit narrow screens and motion preferences

Let containers and rows adapt when the content stops fitting. Use `minmax(0, 1fr)` for grid tracks that must shrink, `min-width: 0` on constrained children, and responsive image sizing as appropriate. Choose wrapping, stacked controls, or local table scrolling according to the task. Avoid global `nowrap` rules that make labels inaccessible.

Fix the source of page overflow. Do not add `overflow-x: hidden` or `clip` to the root to conceal a layout defect. Confine intentional decorative overflow to its own container and verify that focusable content remains visible.

Keep existing motion unless it causes a problem or the brief changes it. Add transitions only when they explain a state change. Prefer short `transform` or `opacity` transitions and respect `prefers-reduced-motion`. Focus indicators must appear immediately. Avoid decorative loops, delayed access to content, and layout shifts during interaction.

Use the verification workflow in the skill entrypoint. After a shared style change, inspect the affected sibling components as well as the requested one. Report measured checks and observed states; do not substitute a taste score for browser evidence.

Adapted from Hallmark v1.1.0 at `13ac0ec7e148655948100b6396439e481361d690`, especially `layout-and-space.md`, `typography.md`, `color.md`, `interaction-and-states.md`, `responsive.md`, `motion.md`, and `components/f3-tabular-spec-sheet.md` and `components/f4-step-sequence.md` under its `references` directory. Project token names, existing Storybook use, and scope boundaries are pstack-x adaptations.
