# pstack-x

基于 vinext、React 和 pnpm monorepo 的应用开发模板。提供数据库会话、RBAC 管理端、文件上传、审计、tRPC 内部接口与外部 HTTP 契约、PostgreSQL 迁移、Kafka 后台任务和本地基础设施。通过 pstack 开发，项目技能负责实际启动与验证。

## 本地启动

需要 Node 22.13+、pnpm 11.26.0 和 Docker。

```bash
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm local:init
pnpm local:up
pnpm db:migrate
```

设置管理员账号和至少 16 位密码，再执行初始化。密码通过环境变量传入，不要提交配置或把真实密码写进共享命令记录。

```bash
pnpm admin:bootstrap
pnpm dev
```

初始化读取 `BOOTSTRAP_ADMIN_ACCOUNT`、`BOOTSTRAP_ADMIN_PASSWORD` 和可选的 `BOOTSTRAP_ADMIN_DISPLAY_NAME`。应用默认运行于 http://localhost:3100，进入管理端后可创建角色和用户。没有默认管理员口令。

`.env.local` 的值优先于 `.env`，显式进程环境优先于两者。修改端口时同步修改 APP_ORIGIN 和启动参数。

## 工作区

| 位置               | 职责                              |
| ------------------ | --------------------------------- |
| apps/web           | 页面、API 路由、React 组件        |
| packages/contracts | Zod 契约、类型、API 操作登记      |
| packages/database  | schema、迁移、事务和仓储          |
| packages/kafka     | 服务端 Kafka 安全连接与恢复检查点 |
| packages/server    | 身份权限、存储和应用服务          |
| services/worker    | 事件发布、消费、幂等和恢复        |
| deploy/compose     | PostgreSQL 与可选中间件           |

## 验证与扩展

```bash
pnpm typecheck
pnpm contract:check
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:ui
pnpm test:production
pnpm test:ui:production
pnpm test:containers
pnpm test:kafka-security
pnpm test:async-recovery
pnpm test:app-backup
```

浏览器测试需要先执行 `pnpm exec playwright install chromium`。API 和浏览器验证创建自己的临时数据库，结果保存在 `.verification`。`pnpm verify` 汇总模板的验证入口。按实际结果判断通过，不能把配置存在当成中间件接入成功。

新增业务时先定义角色、对象归属与验收流程，再添加契约、迁移、服务和页面。Effect 的资源管理与单一契约思想已纳入包边界，当前默认运行时使用 async/await；Effect worker 试点尚未纳入默认依赖。

- [最新修复与验证结果](docs/production-repair-results.md)
- [初始改造验证](docs/verification.md)
- [开发架构](docs/architecture.md)
- [目录与代码约定](docs/conventions.md)
- [业务开发步骤](docs/module-development.md)
- [工程能力建设方案](docs/engineering-adoption-plan.md)
- [工程命令与验证证据](docs/engineering-tools.md)
- [版本管理](docs/versioning.md)
- [制品发布与部署计划](docs/releasing.md)
- [隔离冷启动检查](docs/cold-start.md)
- [容量回归比较](docs/capacity-comparison.md)
- [运行、备份和中间件](docs/operations.md)
- [联合备份与恢复](docs/recovery.md)
- [生产部署预检](docs/production-deployment.md)
- [运行指标与监控](docs/monitoring.md)
- [隔离容量测试](docs/capacity.md)
- [目标环境上线验收](docs/production-acceptance.md)
- [HTTP 契约](docs/api.md)
- [数据库迁移](packages/database/README.md)
- [后台协议与恢复](services/worker/README.md)
- [改造前设计对照](docs/analysis/template-effect-assessment.md)

## 账号维护与数据保留

用户通过 `/account` 修改自己的密码；管理员在用户页重置其他账号密码。两种操作都会撤销目标账号的全部旧会话。遗失现代管理员凭据时，受控运维入口为 `pnpm admin:recover -- --account ACCOUNT --confirm`，新密码只通过 `ADMIN_RECOVERY_PASSWORD` 环境变量传入。

`pnpm history:prune -- --days 90` 预览保留策略，确认后增加 `--apply` 执行有界批次。`pnpm storage:cleanup -- --dry-run` 预览上传协调。写入结果不明的对象按恢复文档人工核查，不能仅因超时而删除。
