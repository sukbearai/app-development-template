# 候选三：先交付可验证的应用模板

保留 vinext，采用 Zod、Drizzle、PostgreSQL 和普通 async 函数。Effect 暂不成为默认依赖；先落实它强调的依赖显式化、错误分类和资源所有权。以下是设计草案，命令与类型尚未实现。

## 开发者先接触什么

```sh
pnpm infra:up --profile core
pnpm db:migrate
pnpm admin:init
pnpm dev
pnpm verify --full
pnpm infra:up --profile async
pnpm worker:start
```

core 启动隔离 PostgreSQL；迁移显式执行，管理员通过交互秘密输入初始化，DDL 不写默认口令。async 启动真实 Kafka 与 worker。其他基础设施按配置启用，未启用的能力显示 disabled。

增加一个操作只需定义契约、实现服务、挂载路由。浏览器 `api.users.create(input, { signal })`；服务端页面直接调用同一服务，两处均授权。

```ts
type Result<A, E> =
  | { ok: true; value: A }
  | { ok: false; error: E }
type RequestContext = {
  actor: Principal; traceId: string; signal: AbortSignal
}
interface Users {
  create(input: CreateUser, ctx: RequestContext):
    Promise<Result<User, Forbidden | Conflict | InvalidInput>>
}
interface UnitOfWork {
  run<A>(f: (tx: Transaction) => Promise<A>): Promise<A>
}
interface AppRuntime {
  users: Users
  close(): Promise<void>
}
```

未知异常允许向上抛出，由 HTTP 边界记录并返回脱敏 500；Result 只表达预期失败。事务内部失败必须抛出，不能返回失败 Result 却提交事务。

## 包边界与唯一事实来源

`apps/web` 保留 vinext 页面、路由和 Web Request/Response 适配。`packages/contracts` 只导出 Zod schema、操作登记与推导类型，生成 OpenAPI 和 fetch 客户端，按操作绑定响应状态及 envelope。输出也运行校验，不再手写第二套 OpenAPI schemas。

`packages/server` 按 identity、files、telemetry、tasks 分模块，集中服务、配置、日志与存储适配器；禁止浏览器导入。`packages/database` 拥有全部 13 张表、repository、事务和唯一 Drizzle 迁移账本，Web 与 worker 共用。`services/worker` 只组合发布器和消费者。内部函数不为分层而包装透传服务。

HTTP schema 与数据库 schema 各管协议和持久化，显式映射二者。数据库不再有第二套迁移器；共享状态枚举生成 CHECK，升级测试验证 SQL、snapshot 与真实表结构。

## 能力逐项落点

| 参考能力 | 迁移安排 |
| --- | --- |
| 9 个页面、15 个 HTTP 操作及兜底 404 | 全部列入验收清单，保留登录、管理概览、用户、角色、权限、文件、审计、outbox；包括 me/logout、health、async-health、上传和 telemetry |
| 密码、Session、Cookie/Bearer、RBAC、CSRF、限流 | identity 服务及入口策略；保留页面/API 双授权，不声称已有租户、MFA、SSO |
| 文件、审计、telemetry、统计 | PostgreSQL 保存事实；文件适配 local/S3，增加可靠协调状态；React Query 仅在实际页面需要缓存时启用 |
| outbox、幂等、任务、事件、重试、死信、健康 CLI | async 配置提供完整发布消费闭环；原有未接线 consumer 不计为已交付 |
| PostgreSQL、Redis、Kafka、MinIO、ClickHouse | PostgreSQL 为基础；Redis 限流、Kafka、S3 可选，ClickHouse 保留扩展说明，因无业务调用不启动默认容器 |
| 备份恢复、Compose、CI、agent 工作流 | 保留入口并修复证据缺口；docs 存稳定约定，loops 存状态，沿用独占服务器的浏览器验证技能 |

## 谁负责事务与资源

应用服务通过 UnitOfWork 把业务行、审计和 outbox 一起提交。角色主键冲突整体回滚；登录会话与审计同事务。上传先持久化意图，再写确定对象键，最后提交文件元数据与事件；失败保留可重试记录，由协调器检查或删除孤立对象。对象与 PostgreSQL 不假装原子，清理必须核对引用。

worker 使用条件抢占、租约代次和匹配代次的完成更新。幂等键包含消费方与业务键，比较 payload hash；任务、事件、幂等结果与可同库的业务副作用同事务。外部副作用要求接收方幂等，否则明确重复风险。offset 确认独立于业务完成，失败不改写成功；毒消息持久隔离后才能提交，重试不能跨过失败 offset。

组合根创建并拥有连接池、producer 和 consumer；请求只拥有 signal。SIGTERM 停止领取、限时 drain、关闭连接；热更新和测试结束也释放资源。崩溃恢复依赖持久租约，不能依赖 finally。

## 缺陷与阶段验收

第一阶段完成契约和身份闭环。修复 inactive 角色撤权、logout secret 校验、Cookie TTL、同源 next、可信代理、原子 Redis 限流、空 PATCH/坏 JSON、匿名 telemetry 限额、表单异步节点及最后管理员保护。用真实 HTTP 和浏览器验证成功、401/403、注销、撤权与刷新。

第二阶段验证真实数据库并发、审计失败回滚、上传中断与恢复。备份强制 checksum，包含业务表和迁移账本，记录实测版本；在空库恢复后继续迁移。配置以显式环境为先，禁止测试文件覆盖部署值。

第三阶段跑 Kafka 崩溃、租约过期、重复消费、offset 失败、取消与 SIGTERM 测试；dry-run 只读。修复容器 listeners，健康探针检查实际依赖和主循环进度。

第四阶段验证 vinext 构建产物及浏览器路径，补全 Web/worker 镜像。verify 覆盖依赖、部署和共享包变更，干净树 `--full` 仍执行，缺必要环境按失败或明确未执行报告。

## Effect 的价值与拒绝理由

rc.112 的 `Effect<A,E,R>`、`Context.Service`、Layer、Scope 和 TestClock 能减少手写依赖、取消及测试设施；HttpApi 可统一 Schema、客户端和 OpenAPI。这是实质收益，普通 Promise 无法在类型上检查全部依赖，也需要团队维护释放纪律。

但 v4 尚为 RC，http/httpapi 明确 unstable，Standard Schema 不会把 Zod 自动变成 HttpApi 契约。默认全迁移会同时承担 vinext beta 和 Effect 升级适配，且仍须自行实现身份、事务、幂等及恢复规则。现阶段拒绝全量 Effect、双 schema 双迁移器和照搬旧缺陷；也不擅自改用 Next。待上述闭环通过，可选一个复杂服务对照 Effect 的代码量、取消可靠性和构建体积，再决定是否采用。

依据为本目录 identity-http、data-storage、runtime-tooling、effect-core-http 报告及 `docs/analysis/plan.md`；本候选未执行运行验证。
