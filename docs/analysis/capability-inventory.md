# 旧模板完整结构清单

来源版本：`bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。此清单由只读脚本生成，记录文件和入口，不表示运行验证通过。

重建 JSON：

```bash
python3 docs/analysis/scripts/inventory.py --template /Users/fayon/workspace/github/app-development-template --effect /Users/fayon/workspace/github/effect --output docs/analysis/inventory.json
```

## 设计文档与章节

### .agents/skills/app-template-harness/SKILL.md

- App Template Harness
- First Checks
- Local Runtime
- Verification Gates
- API And Docs
- Acceptance Boundary

### .agents/skills/app-template-loop/SKILL.md

- App Template Loop
- Read First
- Run A Loop
- Boundary
- Handoff

### .agents/skills/app-template-pr-verify/SKILL.md

- App Template PR Verify
- Preconditions
- Required Checks By Change Type
- Feature Verification
- API And Docs Sync
- Final Report Shape

### AGENTS.md

- Repository Guidelines
- Project Structure & Module Organization
- Build, Test, and Development Commands
- Agent Harness
- Coding Style & Naming Conventions
- Testing Guidelines
- Commit & Pull Request Guidelines
- Security & Configuration Tips

### README.md

- Application Development Template
- 适用场景
- 目录
- 快速开始
- 常用命令
- 使用为新项目
- 产品化能力
- 默认账号

### deploy/compose/README.md

- Local Infrastructure

### docs/README.md

- Documentation Index
- Choose By Scenario
- Recommended Reading Order
- Source Of Truth
- Maintenance Rules

### docs/agent-harness.md

- Agent Harness
- Scope
- Repo Skills
- Local Entrypoint
- Verification Matrix
- Acceptance Boundary
- Loop Brain

### docs/api.md

- API
- Health Semantics
- Admin Auth And Async Runtime Health
- Smoke And UI Checks

### docs/architecture.md

- Architecture
- Document Boundary
- Boundary
- Layers
- Data Stores
- Productized Capabilities
- Access Control Baseline
- Engineering Guardrails
- Verification

### docs/frontend-guidelines.md

- Frontend Guidelines
- Page Boundaries
- Data And State
- Tables, Forms, And Uploads
- Visual Consistency
- Verification

### docs/mvp.md

- MVP Scope
- Current Goal
- Required Roles And Entries
- Main Business Chain
- Not In MVP
- Acceptance Flow
- Current Implementation Notes

### docs/productionization-roadmap.md

- Productionization Roadmap
- Current Principles
- Required Reinforcement Before Background Migration
- Idempotency, Locks, And State Machines
- Read-Side Side Effects
- Web-Side Execution Boundary
- Async Consumer Baseline
- Acceptance

### docs/requirements.md

- Requirements
- MVP
- Out of Scope

### docs/technical-design.md

- Technical Design
- Design Goals
- Recommended Monorepo Shape
- API Route Pattern
- Background Work
- Storage
- Migration Rules
- Backup And Restore
- Production Configuration
- Upload Memory Limits
- Frontend Request And Loading Baseline
- Browser Acceptance

### loops/LOG.md

- Loop Log
- 2026-07-07 · template-maintenance brain initialized · #engineering
- 2026-07-07 · AIBC parity tightened · #engineering

### loops/README.md

- Loop Brain
- Layout
- Current Domains
- Rules

### loops/domains/template-maintenance/README.md

- Template Maintenance
- Current Focus
- Backlog
- Timeline

## Workspace 与命令

### apps/web/package.json

包名：`@app-template/web`。

| 命令 | 实际执行 |
| --- | --- |
| `dev` | `next dev --hostname 0.0.0.0` |
| `build` | `next build` |
| `start` | `next start` |
| `db:generate` | `drizzle-kit generate` |
| `db:migrate` | `drizzle-kit migrate` |
| `lint` | `tsc -p tsconfig.check.json --noEmit` |
| `typecheck` | `tsc -p tsconfig.check.json --noEmit` |
| `api:docs` | `node scripts/generate-openapi.mjs` |
| `config:check` | `tsx scripts/config-check.mjs` |
| `storage:cleanup` | `node scripts/cleanup-local-storage.mjs` |
| `migration:check` | `node scripts/migration-check.mjs` |
| `contract:check` | `node scripts/contract-check.mjs && node scripts/migration-check.mjs` |
| `db:integration` | `node scripts/db-integration.mjs` |
| `bootstrap:local` | `node scripts/bootstrap-local.mjs` |
| `test:unit` | `NODE_OPTIONS='--import ./tests/setup-env.mjs' tsx --test tests/unit/**/*.test.mjs` |
| `test:integration` | `NODE_OPTIONS='--import ./tests/setup-env.mjs' tsx --test tests/integration/**/*.test.mjs` |
| `test:e2e` | `node scripts/e2e.mjs` |
| `test:ui` | `node scripts/ui-flow.mjs` |
| `pr:verify` | `node ../../scripts/pr-verify.mjs` |
| `smoke` | `node scripts/smoke.mjs` |
| `test` | `pnpm test:unit && pnpm test:integration` |

### package.json

包名：`app-template-monorepo`。

| 命令 | 实际执行 |
| --- | --- |
| `dev` | `pnpm --filter @app-template/web dev` |
| `build` | `pnpm --filter @app-template/web build` |
| `start` | `pnpm --filter @app-template/web start` |
| `backup:create` | `node scripts/db-backup.mjs create` |
| `backup:verify` | `node scripts/db-backup.mjs verify` |
| `backup:restore` | `node scripts/db-backup.mjs restore` |
| `db:generate` | `pnpm --filter @app-template/web db:generate` |
| `db:migrate` | `pnpm --filter @app-template/web db:migrate` |
| `db:integration` | `pnpm --filter @app-template/web db:integration` |
| `bootstrap:local` | `pnpm --filter @app-template/web bootstrap:local` |
| `lint` | `pnpm --filter @app-template/web lint` |
| `typecheck` | `pnpm -r --if-present typecheck` |
| `api:docs` | `pnpm --filter @app-template/web api:docs` |
| `config:check` | `pnpm --filter @app-template/web config:check` |
| `storage:cleanup` | `pnpm --filter @app-template/web storage:cleanup` |
| `migration:check` | `pnpm --filter @app-template/web migration:check` |
| `contract:check` | `pnpm --filter @app-template/web contract:check` |
| `test:unit` | `pnpm --filter @app-template/shared test:unit && pnpm --filter @app-template/web test:unit && pnpm --filter @app-template/worker test:unit` |
| `test:integration` | `pnpm --filter @app-template/web test:integration` |
| `test:e2e` | `pnpm --filter @app-template/web test:e2e` |
| `test:ui` | `pnpm --filter @app-template/web test:ui` |
| `pr:verify` | `node scripts/pr-verify.mjs` |
| `smoke` | `pnpm --filter @app-template/web smoke` |
| `test` | `pnpm test:unit && pnpm test:integration` |
| `verify` | `pnpm typecheck && pnpm contract:check && pnpm test && pnpm build && pnpm test:e2e` |

### packages/shared/package.json

包名：`@app-template/shared`。

| 命令 | 实际执行 |
| --- | --- |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `test:unit` | `tsx --test tests/**/*.test.mjs` |

### services/worker/package.json

包名：`@app-template/worker`。

| 命令 | 实际执行 |
| --- | --- |
| `dev` | `tsx src/index.ts` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `test:unit` | `tsx --test tests/**/*.test.mjs` |

## 全部页面

- `apps/web/app/admin/audit/page.tsx`
- `apps/web/app/admin/files/page.tsx`
- `apps/web/app/admin/outbox/page.tsx`
- `apps/web/app/admin/page.tsx`
- `apps/web/app/admin/permissions/page.tsx`
- `apps/web/app/admin/roles/page.tsx`
- `apps/web/app/admin/users/page.tsx`
- `apps/web/app/login/page.tsx`
- `apps/web/app/page.tsx`

## 全部 API 操作

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/system/health`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/{id}`
- `GET /api/admin/roles`
- `POST /api/admin/roles`
- `PATCH /api/admin/roles/{id}`
- `GET /api/admin/audit-logs`
- `GET /api/admin/outbox-events`
- `GET /api/admin/async-runtime-health`
- `POST /api/uploads`
- `POST /api/telemetry`

另有 catch-all 404，GET/POST/PUT/PATCH/DELETE。

## 数据库表与迁移

- `app_users`
- `app_roles`
- `app_permissions`
- `app_user_roles`
- `app_role_permissions`
- `app_user_sessions`
- `app_audit_logs`
- `app_telemetry_events`
- `app_file_assets`
- `app_outbox_events`
- `app_idempotency_keys`
- `app_tasks`
- `app_task_events`
- `apps/web/db/migrations/0001_core.sql`
- `apps/web/db/migrations/0002_async_task_runtime.sql`
- `apps/web/db/migrations/0003_outbox_runtime_state.sql`

## 基础设施

- `postgres`
- `redis`
- `kafka`
- `minio`
- `clickhouse`
- `worker`

## 全部测试入口

- `apps/web/tests/e2e/admin-login.spec.ts`
- `apps/web/tests/e2e/admin-overview.spec.ts`
- `apps/web/tests/e2e/auth.setup.ts`
- `apps/web/tests/integration/health-service.test.mjs`
- `apps/web/tests/unit/access-control-routes.test.mjs`
- `apps/web/tests/unit/admin-service.test.mjs`
- `apps/web/tests/unit/api-response.test.mjs`
- `apps/web/tests/unit/async-runtime-health-service.test.mjs`
- `apps/web/tests/unit/docs-guard.test.mjs`
- `apps/web/tests/unit/health-route.test.mjs`
- `apps/web/tests/unit/infrastructure.test.mjs`
- `apps/web/tests/unit/logger.test.mjs`
- `apps/web/tests/unit/product-service.test.mjs`
- `apps/web/tests/unit/production-config.test.mjs`
- `apps/web/tests/unit/security.test.mjs`
- `apps/web/tests/unit/smoke-script.test.mjs`
- `packages/shared/tests/contracts.test.mjs`
- `services/worker/tests/worker.test.mjs`

## 环境变量名称

### .env.example

- `APP_NAME`
- `LOG_LEVEL`
- `APP_ORIGIN`
- `SESSION_COOKIE_NAME`
- `SESSION_TTL_SECONDS`
- `RATE_LIMIT_DRIVER`
- `LOGIN_RATE_LIMIT_MAX`
- `LOGIN_RATE_LIMIT_WINDOW_SECONDS`
- `LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS`
- `SERVICE_TOKEN`
- `DATABASE_URL`
- `APP_TEMPLATE_DB_SCHEMA`
- `APP_TEMPLATE_MIGRATIONS_SCHEMA`
- `POSTGRES_TOOL_IMAGE`
- `UPLOAD_STORAGE_DRIVER`
- `UPLOAD_STORAGE_DIR`
- `UPLOAD_MAX_BYTES`
- `REDIS_URL`
- `KAFKA_BROKERS`
- `KAFKA_CLIENT_ID`
- `OUTBOX_PUBLISHER`
- `OUTBOX_BATCH_SIZE`
- `OUTBOX_MAX_ATTEMPTS`
- `OUTBOX_RETRY_DELAY_SECONDS`
- `OUTBOX_RETRY_BASE_MS`
- `OUTBOX_RETRY_MAX_MS`
- `OUTBOX_POLL_INTERVAL_MS`
- `OUTBOX_PENDING_WARN`
- `OUTBOX_PENDING_BLOCKED`
- `OUTBOX_FAILED_WARN`
- `OUTBOX_STALE_LOCK_MS`
- `KAFKA_CONSUMER_GROUP_ID`
- `ASYNC_RUNTIME_TOPICS`
- `ASYNC_RUNTIME_TOPIC_PARTITIONS`
- `ASYNC_RUNTIME_TOPIC_REPLICATION_FACTOR`
- `ASYNC_TASK_IDEMPOTENCY_TTL_HOURS`
- `ASYNC_TASK_DEFAULT_MAX_ATTEMPTS`
- `ASYNC_TASK_RETRY_BASE_MS`
- `ASYNC_TASK_RETRY_MAX_MS`
- `E2E_PORT`
- `LOCAL_STORAGE_TTL_HOURS`
- `OBJECT_STORAGE_ENDPOINT`
- `OBJECT_STORAGE_REGION`
- `OBJECT_STORAGE_ACCESS_KEY`
- `OBJECT_STORAGE_SECRET_KEY`
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_FORCE_PATH_STYLE`
- `CLICKHOUSE_URL`

### deploy/compose/.env.example

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `POSTGRES_PORT`
- `POSTGRES_IMAGE`
- `REDIS_PORT`
- `KAFKA_PORT`
- `MINIO_API_PORT`
- `MINIO_CONSOLE_PORT`
- `MINIO_ROOT_USER`
- `MINIO_ROOT_PASSWORD`
- `CLICKHOUSE_DB`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`
- `CLICKHOUSE_HTTP_PORT`
- `CLICKHOUSE_NATIVE_PORT`
- `APP_IMAGE`
- `NODE_IMAGE`
- `NPM_CONFIG_REGISTRY`

## 全部跟踪文件

- `.agents/skills/app-template-harness/SKILL.md`
- `.agents/skills/app-template-loop/SKILL.md`
- `.agents/skills/app-template-pr-verify/SKILL.md`
- `.dockerignore`
- `.env.example`
- `.github/workflows/verify.yml`
- `.gitignore`
- `AGENTS.md`
- `Dockerfile`
- `README.md`
- `apps/web/app/admin/audit/page.tsx`
- `apps/web/app/admin/files/page.tsx`
- `apps/web/app/admin/layout.tsx`
- `apps/web/app/admin/outbox/page.tsx`
- `apps/web/app/admin/page.tsx`
- `apps/web/app/admin/permissions/page.tsx`
- `apps/web/app/admin/roles/page.tsx`
- `apps/web/app/admin/users/page.tsx`
- `apps/web/app/api/[...segments]/route.ts`
- `apps/web/app/api/admin/async-runtime-health/route.ts`
- `apps/web/app/api/admin/audit-logs/route.ts`
- `apps/web/app/api/admin/outbox-events/route.ts`
- `apps/web/app/api/admin/roles/[id]/route.ts`
- `apps/web/app/api/admin/roles/route.ts`
- `apps/web/app/api/admin/users/[id]/route.ts`
- `apps/web/app/api/admin/users/route.ts`
- `apps/web/app/api/auth/login/route.ts`
- `apps/web/app/api/auth/logout/route.ts`
- `apps/web/app/api/auth/me/route.ts`
- `apps/web/app/api/system/health/route.ts`
- `apps/web/app/api/telemetry/route.ts`
- `apps/web/app/api/uploads/route.ts`
- `apps/web/app/globals.css`
- `apps/web/app/layout.tsx`
- `apps/web/app/login/page.tsx`
- `apps/web/app/page.tsx`
- `apps/web/components/admin/admin-actions.tsx`
- `apps/web/components/admin/admin-charts.tsx`
- `apps/web/components/admin/admin-shell.tsx`
- `apps/web/components/admin/admin-ui.tsx`
- `apps/web/components/admin/login-form.tsx`
- `apps/web/components/api-client.ts`
- `apps/web/components/api-query.ts`
- `apps/web/components/query-provider.tsx`
- `apps/web/components/skeleton.tsx`
- `apps/web/db/client.ts`
- `apps/web/db/migrations/0001_core.sql`
- `apps/web/db/migrations/0002_async_task_runtime.sql`
- `apps/web/db/migrations/0003_outbox_runtime_state.sql`
- `apps/web/db/migrations/meta/0002_snapshot.json`
- `apps/web/db/migrations/meta/0003_snapshot.json`
- `apps/web/db/migrations/meta/_journal.json`
- `apps/web/db/migrations/migration-debt.json`
- `apps/web/db/migrations/migration-integrity.json`
- `apps/web/db/schema.ts`
- `apps/web/drizzle.config.ts`
- `apps/web/lib/api-authz.ts`
- `apps/web/lib/api-response.ts`
- `apps/web/lib/api-security.ts`
- `apps/web/lib/async-runtime-health-service.ts`
- `apps/web/lib/auth-service.ts`
- `apps/web/lib/env.ts`
- `apps/web/lib/health-service.ts`
- `apps/web/lib/infrastructure.ts`
- `apps/web/lib/logger.ts`
- `apps/web/lib/password.ts`
- `apps/web/lib/product-service.ts`
- `apps/web/lib/production-config.ts`
- `apps/web/lib/rate-limit.ts`
- `apps/web/lib/redis-client.ts`
- `apps/web/lib/repository.ts`
- `apps/web/lib/request-auth.ts`
- `apps/web/lib/s3-client.ts`
- `apps/web/lib/storage.ts`
- `apps/web/lib/upload-memory-limits.ts`
- `apps/web/lib/validation.ts`
- `apps/web/next-env.d.ts`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/playwright.config.mjs`
- `apps/web/scripts/api-contracts.mjs`
- `apps/web/scripts/bootstrap-local.mjs`
- `apps/web/scripts/cleanup-local-storage.mjs`
- `apps/web/scripts/config-check.mjs`
- `apps/web/scripts/contract-check.mjs`
- `apps/web/scripts/db-integration.mjs`
- `apps/web/scripts/e2e.mjs`
- `apps/web/scripts/generate-openapi.mjs`
- `apps/web/scripts/load-script-env.mjs`
- `apps/web/scripts/migration-check.mjs`
- `apps/web/scripts/smoke.mjs`
- `apps/web/scripts/ui-flow.mjs`
- `apps/web/tests/e2e/admin-login.spec.ts`
- `apps/web/tests/e2e/admin-overview.spec.ts`
- `apps/web/tests/e2e/auth.setup.ts`
- `apps/web/tests/integration/health-service.test.mjs`
- `apps/web/tests/setup-env.mjs`
- `apps/web/tests/unit/access-control-routes.test.mjs`
- `apps/web/tests/unit/admin-service.test.mjs`
- `apps/web/tests/unit/api-response.test.mjs`
- `apps/web/tests/unit/async-runtime-health-service.test.mjs`
- `apps/web/tests/unit/docs-guard.test.mjs`
- `apps/web/tests/unit/health-route.test.mjs`
- `apps/web/tests/unit/infrastructure.test.mjs`
- `apps/web/tests/unit/logger.test.mjs`
- `apps/web/tests/unit/product-service.test.mjs`
- `apps/web/tests/unit/production-config.test.mjs`
- `apps/web/tests/unit/security.test.mjs`
- `apps/web/tests/unit/smoke-script.test.mjs`
- `apps/web/tsconfig.check.json`
- `apps/web/tsconfig.json`
- `deploy/compose/.env.example`
- `deploy/compose/README.md`
- `deploy/compose/docker-compose.yml`
- `docs/README.md`
- `docs/agent-harness.md`
- `docs/api.md`
- `docs/architecture.md`
- `docs/frontend-guidelines.md`
- `docs/mvp.md`
- `docs/openapi.json`
- `docs/productionization-roadmap.md`
- `docs/requirements.md`
- `docs/technical-design.md`
- `loops/LOG.md`
- `loops/README.md`
- `loops/domains/template-maintenance/README.md`
- `package.json`
- `packages/shared/package.json`
- `packages/shared/src/index.ts`
- `packages/shared/tests/contracts.test.mjs`
- `packages/shared/tsconfig.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `scripts/db-backup.mjs`
- `scripts/dev-local.sh`
- `scripts/pr-verify.mjs`
- `services/worker/package.json`
- `services/worker/src/async-consumer.ts`
- `services/worker/src/async-runtime.ts`
- `services/worker/src/cli-utils.ts`
- `services/worker/src/env.ts`
- `services/worker/src/index.ts`
- `services/worker/src/logger.ts`
- `services/worker/src/outbox-readiness.ts`
- `services/worker/src/outbox.ts`
- `services/worker/tests/worker.test.mjs`
- `services/worker/tsconfig.json`
- `tsconfig.base.json`
