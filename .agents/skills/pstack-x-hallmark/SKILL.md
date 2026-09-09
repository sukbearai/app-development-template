---
name: pstack-x-hallmark
description: Explicitly requested Hallmark visual audits, new page design, scoped redesigns, component design, and reference studies for pstack-x. Defaults to a read-only audit; implementation requires a request to change the UI.
---

# Hallmark for pstack-x

Use this skill only when explicitly requested. A bare `$pstack-x-hallmark` starts a read-only audit of the relevant pstack-x UI. Infer the target from the current task and changed UI files. If no target is identifiable, ask for the page or component.

## Establish the project and scope

Resolve all project paths below from the repository root, not from this skill's installed directory. Read the applicable `AGENTS.md` and `git status --short`. Confirm the Web runtime in `apps/web/vite.config.ts`, which uses `vinext()`. Inspect current files before relying on these project conventions.

`apps/web/app/globals.css` owns the existing visual tokens. Read the relevant components and any existing `design.md` or `DESIGN.md`. If neither design document exists, use the current UI, stylesheet, and user brief as the design authority. Missing Hallmark files do not require a new theme or a question.

Preserve route structure, component ownership, copy intent, and the existing design unless the requested change covers them. Keep browser code in `apps/web`, business tRPC operations and authorization in `packages/server`, and schemas in `packages/contracts`. A visual task does not authorize changing authentication, permissions, data contracts, or transaction behavior.

Use the current tokens and font stack, including Inter where already used. Extend or edit the owning stylesheet only for the requested change. Do not create a parallel root `tokens.css`, overwrite global styles, rotate themes, add Hallmark stamps, or maintain `.hallmark` caches or history.

When the user requests a distinct theme for a new marketing or showcase page, allow palette and typography exploration within that page's scope. Keep its styles in the owning Web stylesheet or component. Preserve the administration UI and shared status colors.

## Choose the requested mode

| Request                                         | Action                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare invocation or `audit <target>`             | Read [visual audit](references/visual-audit.md). Inspect and return ranked findings. Do not edit source or configuration, or mutate application data.                                                      |
| `redesign <target>`                             | Read [design and components](references/design-and-components.md). Change the named UI in place within its current implementation boundaries.                                                              |
| A request to create or change a named component | Read [design and components](references/design-and-components.md). Work at component scope and cover its applicable states.                                                                                |
| A request to build a new page                   | Read [design and components](references/design-and-components.md), then use [design reference selection](references/design-selection.md) to choose a fitting structure. Implement only the requested page. |
| `study <URL or screenshot>`                     | Read [reference study](references/reference-study.md). Return observed design choices and their limits. Implement or write `design.md` only if requested.                                                  |

A URL or screenshot alone is reference material, not permission to redesign. Follow the user's stated intent without imposing a new confirmation step when that intent is already clear. Skill installation, an audit, or a study does not authorize application edits.

For a new page, a substantial redesign, or an explicitly requested design alternative, read [design reference selection](references/design-selection.md), then only the selected references. Ordinary administration fixes retain the current layout. During audit, alternatives remain suggestions and aesthetic preferences do not become defects.

## Verify within the authorized task

Use available Codex file, shell, browser, and image tools according to their current documentation. Discover callable tools when needed. Do not assume Claude commands or a tool named `WebFetch` exists.

For live browser evidence, read the repository-relative file `.agents/skills/verify-pstack-x/SKILL.md` and its relevant feature map. An audit may inspect an authorized running app with read-only interactions. Do not run its data-writing suites merely to perform an audit. If the app is unavailable, report a source-only audit and the missing browser evidence.

After UI implementation, follow that verification skill for affected user flows. Its `pnpm test:ui` and `pnpm test:ui:production` commands own disposable PostgreSQL databases. Never substitute a shared database. Inspect the resulting screenshots and actual behavior.

For component work, reuse `apps/web/stories` and the current Storybook setup. Check the current scripts before running `pnpm storybook`, `pnpm storybook:test`, or `pnpm storybook:smoke`. Storybook proves isolated component states; it does not prove authenticated application behavior.

Run repository-required checks for implementation, including `pnpm lint`, `pnpm duplication:check`, and the applicable type, contract, migration, and package checks. Keep source checks, component checks, browser observations, and deployment evidence distinct. A self-score or passing build does not establish visual correctness.

Report what changed or what was found, the evidence inspected, and unresolved limits. Keep an audit report in the response unless the user requests a file. Do not declare a visual pass for viewports or states that were not inspected.

Adapted from [Hallmark](https://github.com/Nutlope/hallmark) v1.1.0, commit `13ac0ec7e148655948100b6396439e481361d690`. The references identify the source material used. Upstream copyright and permissions remain in [LICENSE](LICENSE).
