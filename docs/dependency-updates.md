# Formatting and dependency updates

Run `pnpm format` to apply Prettier and `pnpm format:check` to check formatting.
`.editorconfig` sets UTF-8, LF line endings, two spaces, and final newlines.
`.prettierignore` excludes build output and files maintained by other generators.
SDK declarations are formatted during generation and remain part of the format
check.

pnpm 11 requires an explicit dependency build policy. `pnpm-workspace.yaml`
allows esbuild to verify its native binary. It disables MSW's optional worker-file
postinstall because `scripts/prepare-storybook.mjs` owns the Storybook worker.
New dependency build scripts require a package-specific decision; installation
fails until they are classified.

`renovate.json` groups related React, Effect, Drizzle, AWS SDK, Playwright, Oxlint,
and OpenAPI dependencies. Renovate proposes pinned versions, maintains the pnpm
lockfile, and runs on Monday mornings in Australia/Perth. Major upgrades require
approval in Renovate's dependency dashboard before PR creation. Automatic merging
is disabled for every update.

Install or enable the Renovate GitHub App for this repository to start receiving
PRs. The configuration alone does not install the app. Review updates with the
same repository checks as application changes, including relevant runtime and
integration tests for database, queue, storage, and framework changes.
