# Component development

`pnpm storybook` starts the component workbench at <http://localhost:6006>. It uses Storybook's React/Vite renderer and the application's CSS. It does not start vinext, PostgreSQL or Kafka.

The workbench contains the production `CreateRoleForm` and a request example composed from `useApiQuery`, `CardSkeleton`, `EmptyState`, `Section` and `StatusBadge`. Both have empty, loading, error, success and slow network stories. Loading holds the request open. Slow network delays the response by 2.5 seconds.

MSW handles `/api/admin/roles` inside the browser. Handlers validate form requests and response fixtures with the shared contracts. Unhandled `/api/` requests fail instead of reaching a backend. Each request story mounts its own query client, and MSW resets handlers between stories.

Storybook aliases `next/navigation` to `.storybook/navigation.ts`. Its router records navigation calls without leaving the story. This alias exists only in the component configuration. The application uses its normal vinext router.

## Checks

Install dependencies with `pnpm install --frozen-lockfile`, then run `pnpm hooks:install`. Install Chromium once with `pnpm exec playwright install chromium`.

```sh
pnpm --filter @pstack/web storybook:typecheck
pnpm storybook:test
pnpm storybook:smoke
```

`storybook:test` uses the Storybook Vitest addon to run every story and its `play` interaction in headless Chromium. It checks successful form reset and route refresh, failed request input preservation, pending button state and slow responses.

`storybook:smoke` builds the static workbench, starts its preview on port 6106, and uses Playwright to check the built form and request stories. It owns and stops that preview process. Static output is in `artifacts/storybook`; browser failure traces are in `artifacts/storybook-smoke`. `pnpm --filter @pstack/web storybook:preview` serves an existing build manually.

The MSW worker is copied from the installed `msw` package into `artifacts/storybook-msw` before each component command. No generated worker is committed or added to the application's public assets. Storybook, MSW and Vitest are development dependencies.

These commands cover isolated browser components. Keep the existing Node tests, application browser tests, integration tests and production verification commands for their respective runtime behavior.

## Add a story

Add `apps/web/stories/<name>.stories.tsx`, import the production component, and provide HTTP handlers through `parameters.msw.handlers`. Use `storybook/test` for user interactions and assertions in `play`. Keep network responses consistent with `@pstack/contracts`. Reuse `.storybook/navigation.ts` when asserting route effects, and extend its adapter only for router methods the component actually uses.
