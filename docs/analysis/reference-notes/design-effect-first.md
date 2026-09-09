# Effect-first 架构候选

阶段状态：Ground、Sketch 完成；供主方案比较，未进入实现。默认保留 vinext，框架切换由用户选择。Effect 固定 `4.0.0-rc.112`，HTTP、SQL 等 `unstable` API 不按生产成熟组件承诺。

先看调用者。根命令继续提供 `dev`、`bootstrap:local`、`db:generate`、`db:migrate`、`api:docs`、`contract:check`、`pr:verify`、`verify`；worker 保留 outbox、readiness、alerts 和 runtime 命令。下列为契约草图，不是已验证代码。

```ts
// 调用点一：显式 vinext route，框架 params 不传给 Effect Context
export const POST = (request: Request) => web.handler(request);
// web 由 HttpApiBuilder + HttpRouter.toWebHandler 构建一次；拥有 dispose

// 调用点二：worker 的业务完成与 offset 确认分开
const receipt = yield * Tasks.complete(envelope);
yield * Kafka.confirm(receipt.source); // 失败只重试确认，不回写业务失败
```

浏览器保留 fetch、React Query、表单和 skeleton；共享 Schema 可输出 Standard Schema，但不默认把 HttpApi runtime client 放入浏览器。

## 模块与签名

```text
apps/web/                 vinext 页面、显式 route、web 组合根
packages/contracts/      Effect Schema、HttpApi、错误与事件协议
packages/server/         server-only
  identity/              session、RBAC、来源和归属检查
  files/ telemetry/      应用服务与持久写入
  tasks/                 outbox、幂等、任务状态机
  platform/              SQL、对象、Redis、Kafka、配置、日志 Layer
  migrations/            SQL、执行清单、校验器
services/worker/         worker 组合根、循环与诊断 CLI
scripts/ deploy/ docs/   运维、构建、门禁及 agent harness
```

Web 与 worker 共享服务规则，各自拥有进程资源；禁止从 contracts 导出服务器 Layer。

```ts
type TaskState =
  | { kind: "ready"; nextAttemptAt: Date }
  | { kind: "running"; lease: Lease }
  | { kind: "done"; receipt: Receipt }
  | { kind: "dead"; reason: Failure }
  | { kind: "canceled"; canceledAt: Date };
// ID、Lease、请求与输出类型均由 Schema 派生
authorize: (request: Request, action: Permission) => Effect<Actor, AuthError, Identity>;
upload: (actor: Actor, input: UploadInput) => Effect<FileAsset, UploadError, Files>;
complete: (event: TaskEnvelope) => Effect<Receipt, TaskError, Tasks>;
// Context.Service 定义上述能力，Layer 提供实现；领域代码不 runPromise
```

## 统一到哪里

契约统一为 Effect Schema，HttpApi 生成 OpenAPI；保留 URL、状态码、traceId envelope、cookie/bearer 优先级和错误含义。每组切换同时删除旧 Zod 与手写 schema，显式 route 清单继续校验，catch-all 只返回 404。页面与 API 各自授权，HttpApiSecurity 只提取凭据，不提供 RBAC。

本候选最终移除 Drizzle runtime 与生成器，查询由 Effect SQL 执行，数据库结果由 Schema 解码，DDL 由人工编写 SQL 和 Migrator 执行。Schema 不会生成关系约束或 SQL 迁移；`db:generate` 改为创建编号骨架，必须在文档明确其行为变化。保留旧 SQL、journal、snapshot 与 hash 作为不可改写历史，迁移检查继续验证历史，新迁移另有编号及完整性清单。

新库重放经审核的基线；已有库只在确认表结构、种子及旧账本一致后登记采用基线，绝不重新执行旧 DDL。该转换需要单独迁移程序和恢复演练，不能靠换 Migrator 表名完成。

## 所有权与一致性

Web handler 和 worker runtime 各持有一个 Scope，统一创建连接池、客户端，HMR、测试结束与进程退出关闭它们。请求断连中断请求 fiber；已提交任务继续由 worker 所有。SIGTERM 先停止认领，再有界排空，关闭连接；强杀后的恢复依赖持久状态。

每个应用写命令负责事务，所有参与查询必须使用同一个 SqlClient 及其事务连接。业务行、审计与 outbox 同事务；consumer 的幂等抢占、领域写入、任务和事件也在同一 PostgreSQL 事务内提交。Drizzle、原生 pg、另一个 SqlClient 套进 Effect 不会加入该事务。

Kafka 发布保持至少一次语义，租约、fencing、毒消息、过期锁回收和领域幂等由业务实现；Schedule 不提供持久恢复。确认失败后的重投读取持久成功凭证，不能再次执行副作用。上传先写持久意图，再执行对象 PUT，最后原子确认元数据、审计、outbox；失败留待协调任务修复。Scope finalizer 不能替代对象补偿。

## 功能覆盖与验收

| 旧模板能力                                                                   | 保留或重建及验收谓词                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 登录、登出、session、scrypt、用户角色权限 CRUD、归属与同源检查、限流         | 改为 Identity 服务；真实 cookie/bearer、撤销、越权、跨站及 Redis/内存路径结果一致                      |
| 管理端首页、导航、图表、用户、角色、权限、文件、审计、outbox、查询与加载状态 | 页面保留；构建产物上的 Chromium 全路径通过，数据取自服务器                                             |
| 上传 local/S3、大小限制、清理、审计、telemetry                               | 驱动与 traceId 保留；真实 PUT、超限、失败协调、保留期有证据                                            |
| outbox、任务/事件/幂等、健康、readiness、alerts                              | 重建缺陷实现；并发、重启、租约失效、offset 失败、取消与 SIGTERM 不损坏成功事实；dry-run 不写 published |
| 13 表、迁移种子、备份校验恢复、配置日志                                      | 空库与升级库结构一致；备份包含账本、缺 checksum 拒绝；生产配置与脱敏规则通过                           |
| Compose、Docker、CI、smoke/UI、门禁、skills/loops                            | 全部适配 vinext；真实构建启动、干净树 full gate 和进程身份验证通过                                     |

Redis、Kafka、MinIO 保留真实接入；ClickHouse 保留可选部署配置，不新增未实现的分析业务。现有明文种子、伪发布、只查端口的 readiness 等缺口单列修复，不作为应保留行为。

## 代价、回退与取舍

这是替换成本最高的候选：重写契约、查询、迁移工具和后台执行，失去 Drizzle 的 schema diff 生成，团队需掌握 Effect 错误、Scope 与事务上下文。版本连同 lockfile 精确固定，每次升级重跑协议和真实资源测试；不假定 rc 可直接降到 v3。回退保留整套已验证的旧应用镜像和数据库兼容窗口，涉及账本切换时先恢复演练副本，禁止仅降包版本。

拒绝两个替代：长期 Zod/Schema 双写会重新制造契约漂移；以 Effect Workflow 替代 Kafka 后宣布任务可靠会漏掉已有事件语义与故障窗口。此候选只有在愿意承担全量替换、且 vinext HTTP 桥接及 SQL 迁移探针通过时才值得选。当前只有静态设计，未证明这些验收谓词成立。

依据：参考模板 `AGENTS.md`、`docs/architecture.md`、`docs/technical-design.md`；本目录 `effect-core-http.md`、`runtime-tooling.md`、`data-storage.md`。补查 Effect `SqlClient.ts:55,162,195` 与 `Migrator.ts:111,225,308`，事务依赖客户端专属上下文，Migrator 默认另有账本。主报告目标与范围见 `docs/analysis/plan.md`。
