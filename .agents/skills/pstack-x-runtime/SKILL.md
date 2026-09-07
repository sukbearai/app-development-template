---
name: pstack-x-runtime
description: Start, inspect and verify the pstack-x monorepo and its optional middleware, or generate and apply its database migrations. Use for project runtime work alongside pstack development workflows.
---

# pstack-x runtime

Read the root AGENTS.md and the relevant package README. Root package.json defines supported commands; docs/analysis describes the old template and design history, not current runtime state.

For local development use `pnpm local:init`, `pnpm local:up`, `pnpm db:migrate`, explicit administrator initialization and `pnpm dev`. Add middleware through `pnpm local:up -- redis kafka storage worker`. The CLI scopes Compose to this checkout and preserves volumes on down. APP_ORIGIN must match the browser origin.

Generate database changes with `pnpm db:generate`; inspect the SQL and metadata. Keep the new template and legacy migration histories separate. Never edit an applied migration to fix a schema. Existing deployments require a target-specific backup and upgrade decision. Template tests own isolated containers and do not authorize changing another database.

Before marking a feature ready, run the affected package tests and real path. `pnpm verify` covers the template, and `verify-pstack-x` owns browser proof. For a product-specific external handler, add its own acceptance path; the default worker receipts do not prove external side effects.

New APIs require a contracts registry entry and `pnpm api:docs`. New runtime options belong in typed configuration, examples, Compose where applicable, and an executable check. Browser code imports contracts only; service and database packages remain server-side.
