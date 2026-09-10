# pstack-x development

Use pstack for design, implementation and review. Project-specific instructions below define runtime and verification boundaries.

After installing dependencies, run `pnpm hooks:install` once per repository to enable the native `.githooks/pre-commit` hook. It exports the Git index to a temporary staged snapshot, then runs `pnpm lint`, `pnpm duplication:check`, `pnpm dependency:check` and `pnpm conventions:check`; the working tree and index remain unchanged. Do not bypass the hook to avoid fixing violations; CI runs the same gates.

## Structure

Business code lives in `src/modules/<domain>` within its owning package. Contracts expose `contracts.ts`, database modules expose `repository.ts`, server modules expose `service.ts`, and worker modules expose `handler.ts`. Server `router.ts` files are assembled only by `trpc-router.ts`. Other files are private to that module, including type imports and re-exports. Platform paths are explicit in `scripts/convention-policy.mjs`. See `docs/conventions.md` and `docs/module-development.md`.

Web components live in `components/<domain>`, `ui`, `providers`, or `admin`; clients live in `lib` and shared hooks in `lib/hooks`. Use kebab-case paths and named exports except framework-reserved files. Business modules do not read `process.env`. Tests use `tests/unit`, `tests/integration`, and server `tests/web-runtime`; existing commands discover files recursively without per-test registration.

Production source files have a 600-line limit enforced by Oxlint `max-lines`, excluding blank and comment-only lines. Split oversized files by responsibility, not by adding forwarding layers. Tests, tooling and declaration files are outside this size limit; their other lint rules remain enabled. There is no function-length limit.

- `apps/web` owns vinext pages, explicit App Router handlers and browser components.
- `packages/contracts` owns Zod HTTP/message schemas, derived types and the operation registry. It may be imported by the browser.
- `packages/database` owns PostgreSQL schema, Drizzle migrations, connection pool, transactions and repositories.
- `packages/kafka` owns Node-only Kafka connection configuration and recovery checkpoints. Browser modules and contracts cannot import it.
- `packages/server` owns authentication, authorization, application operations, storage and transport helpers. It must not import Web code.
- `services/worker` owns Kafka delivery, durable task recovery and process shutdown. Its database handlers use the transaction client supplied by the worker.

Browser modules cannot import server/database runtime code or credentials. The browser may import `AppRouter` with `import type` from `@pstack/server/trpc-router`. Keep one schema authority per interface. Internal business APIs use tRPC procedures in `packages/server/src/trpc-router.ts`; preserve service authorization, transaction boundaries and Zod input/output validation. External HTTP routes remain explicitly registered in `packages/contracts/src/http.ts`. Generate their OpenAPI with `pnpm api:docs`; do not edit generated output manually.

## Verification

Start with git status and preserve unrelated work. Run `pnpm lint`, `pnpm duplication:check`, `pnpm dependency:check` and `pnpm conventions:check` before declaring work ready. Fix new violations; do not disable rules, add broad ignores, or refresh the duplication baseline just to pass. Baseline changes require explicit review of accepted clones. See `docs/quality-gates.md`. Use `pnpm typecheck`, `pnpm contract:check`, `pnpm migration:check` and affected package tests. `pnpm verify` runs the complete template checks. See `.agents/skills/verify-pstack-x/SKILL.md` for browser evidence and isolated databases.

`pnpm test:e2e`, `pnpm test:ui` and `pnpm test:production` own disposable PostgreSQL containers. Never substitute a shared database to make tests pass. Distinguish source checks, PostgreSQL/Kafka/Redis/S3 integration, browser behavior and deployment evidence.

## Data and authentication

Use `pnpm db:generate` after editing the database schema. Inspect generated SQL and metadata. `pnpm db:migrate` verifies integrity and applies the safe template history; old application databases require the explicit legacy upgrade procedure in the database documentation. Do not rewrite applied migrations or their hashes.

Initialize the administrator with `pnpm admin:bootstrap` and explicit BOOTSTRAP_ADMIN_ACCOUNT/BOOTSTRAP_ADMIN_PASSWORD. There is no default password. Check permissions on both server pages and HTTP routes; visible menu items never grant access. Keep Cookie origin checks and service-level authorization when adding operations.

Business rows, audit and outbox facts commit in one transaction. Object storage and PostgreSQL are separate systems; use durable upload intents and reconciliation. Background execution is at least once; external receivers must implement idempotency when effects can repeat.
