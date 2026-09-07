# 候选：保留 Web 与 Drizzle，Effect 管服务端执行

## 调用者先行

沿用 `pnpm dev/build/start`，默认仍运行 vinext；提供 `db:generate`、`db:migrate`、`bootstrap:local`、`backup:*`、`storage:cleanup`、`worker -- outbox-loop/readiness/alerts`、`pr:verify`、`verify`、`test:ui`。命令对应真实能力，dry-run 只观察，不写 published。

两个调用点的伪码如下。页面继续独立授权；API 适配器集中处理凭据、同源、解析和 HTTP 错误。

```ts
// apps/web/app/api/admin/roles/route.ts
export const POST = (request: Request) =>
  web.invoke(request, CreateRole, ({ actor, input }) =>
    Roles.create(actor, input))

// services/worker/src/main.ts
const runtime = ManagedRuntime.make(WorkerLive)
try {
  await runtime.runPromise(Outbox.run, { signal: shutdown.signal })
} finally {
  await runtime.dispose()
}
```

## 边界与签名

`apps/web` 拥有 vinext 页面、显式路由、React Query、管理台组件及框架适配；`packages/contracts` 拥有 Zod 请求/响应、错误和消息契约；`packages/server` 拥有授权、服务、Drizzle schema/repository、基础设施 Layer；`services/worker` 拥有调度与 Kafka 生命周期。独立 server 包的依据是 Web/worker 共用事务及授权领域数据，客户端禁止导入它。迁移 SQL、snapshot、journal 全留在 server 包，命令保持根入口。

```ts
type AppError = Unauthorized | Forbidden | InvalidInput | Conflict | Unavailable
type Actor = { userId: UserId; permissions: ReadonlySet<Permission> }
type Lease = { eventId: EventId; owner: string; generation: number }
Roles.create(actor: Actor, input: CreateRoleInput):
  Effect.Effect<Role, AppError, RoleRepository>
RoleRepository.createWithAudit(input: AuthorizedRoleWrite): Promise<Role>
OutboxRepository.claim(now: Date): Promise<ReadonlyArray<Lease>>
OutboxRepository.complete(lease: Lease): Promise<boolean>
```

服务用 v4 `Context.Service` 声明依赖。Effect 负责依赖提供、错误、取消、时间与资源关闭；仓储公开完整业务写入，避免调用者拼出半个事务。

## 事务和资源所有权

Drizzle 是唯一数据库事务所有者。仓储内部以同一个 `tx` 写业务、审计、outbox；Effect 只包装整次 Promise 调用，不在 transaction callback 内运行依赖全局 pool 的 Effect。此方案不引入 Effect SQL/Migrator，不能假定两套事务上下文互通。

每个 Web 进程和 worker 各有一个 runtime，由组合根持有；Layer 建立池、producer、consumer，进程退出、HMR 替换和测试结束调用 dispose。请求 signal 只取消可取消的工作；持久任务由 worker 接管。关闭先停止认领、再等待或中断执行、最后释放连接。SIGKILL 后由数据库租约恢复，不能依赖 finalizer。

文件先登记持久上传操作与确定对象键，再写对象；成功后同事务提交元数据、审计、outbox。失败记录清理意图，由可重试清理器核对操作状态后删除，禁止盲删可能已提交的对象。

## 契约选择

保留 Zod 为唯一 HTTP/消息 schema，类型推导、输入解析及 OpenAPI 从它生成；路径、权限、状态码由显式端点登记补充。Effect 服务接收已校验值，不再维护平行 Effect Schema。生产响应与生成文档做一致性测试，禁止手写重复 OpenAPI 对象。暂不采用 HttpApi：Standard Schema 不是 Zod AST 到 Effect AST 转换，不能自动消除重复。

Web adapter 只接 Web Request/Response，另有页面 session adapter；Next cookies/navigation 留在 apps/web。保留 vinext 待用户选框架，验证构建产物、RSC、Cookie、重定向和断连后再称兼容。

## 迁移和验收

1. 固化旧模板逐项能力清单，迁入页面、认证/RBAC、CRUD、文件、审计/telemetry、健康、outbox/任务工具、备份、Compose、CI 和 agent harness。ClickHouse 保留可选基础设施，不虚构分析业务；未接通的领域 consumer 不计作既有成果。
2. 先修边界：停用角色撤权、logout 验密、移除已知管理员与 plain 密码、统一 TTL、可信代理与限流、同源跳转、非法 JSON 拒绝、错误脱敏；角色冲突必须回滚，表单先保存节点，telemetry/上传限制实际读取字节。
3. 再接 Effect，改业务/审计/outbox 原子写；consumer 用有作用域的幂等键、payload hash、条件租约和 fencing，状态/事件/幂等同事务。offset 失败只能重试确认，不能抹掉成功；补毒消息持久隔离、租约恢复、heartbeat 与 drain。
4. 验收谓词：旧能力矩阵无遗漏；停用权限请求为 403、伪造 logout 无效；并发同角色仅一方成功；任一数据库写失败全部回滚；对象失败最终收敛；并发同 key 只有一次有效副作用；崩溃可恢复且至少一次投递不产生重复业务；构建后浏览器闭环通过。

补齐真实 PostgreSQL/Kafka/Redis/MinIO 故障测试、备份隔离恢复、容器启动和完整路径门禁。修正 Kafka listeners、缺 checksum 仍通过、restore 未先 verify、clean-tree `--full` 漏检。源码测试不替代生产构建、浏览器与基础设施证据。

## 风险与拒绝项

本地 Effect `4.0.0-rc.112` 仍是候选版本，HTTP 是 unstable；固定版本并保留适配器回退，不能据上游测试宣称生产成熟。局部引入仍有 Promise/Effect 双模型成本，故只在组合根转换，避免逐函数包装。拒绝全量 HttpApi/schema 重写、双迁移账本、额外 API 服务及照搬旧 worker；它们扩大迁移面，不能自行修复授权或持久一致性。

依据：旧模板 `AGENTS.md`、`docs/architecture.md`、`docs/technical-design.md`；本轮 `effect-core-http.md`、`runtime-tooling.md`、`identity-http.md`、`data-storage.md` 和目标 `docs/analysis/plan.md`。本文件为独立设计候选，未改应用代码、未执行上述验收。
