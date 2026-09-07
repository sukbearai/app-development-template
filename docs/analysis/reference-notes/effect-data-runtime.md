# Effect 数据与后台能力对照

调查日期：2026-09-07。仅阅读源码、配置和测试，没有安装依赖、启动服务、运行测试或写数据库。

证据基线：Effect `/Users/fayon/workspace/github/effect`，HEAD `5a802043984727b0c5a291af39d1b9bbfa8d7b8b`；旧模板 `/Users/fayon/workspace/github/app-development-template`，HEAD `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。检查时两个参考仓库均无工作区改动。下文 `E/`、`T/` 分别表示这两个绝对路径。文件后的数字是源码行号。

Effect 的 `packages/effect/package.json:4` 确认为 `4.0.0-rc.112`；`:36`、`:43`、`:49`、`:50` 明确导出 `unstable/cluster`、`unstable/persistence`、`unstable/sql`、`unstable/workflow`。核心 Scope、Fiber、Schedule、Queue 的设计已有长期演进，当前版本仍是 RC，不能把“成熟可借鉴”写成这套版本已经完成生产验收。

## 采用判断

| 对象 | 分类 | 对新模板的判断 |
| --- | --- | --- |
| Scope、Fiber 所有权、类型化失败、组合式重试 | 成熟可借鉴；纯进程内路径可直接采用 | 用来统一连接回收、worker 关闭、有界并发与测试时钟。先限定一个服务或 worker，保持业务持久状态不变。 |
| SqlClient/PgClient | 需 POC，事务结构可借鉴 | 有真实连接保留、嵌套 savepoint、失败及取消回滚，适合数据访问层。替换现有 pg/Drizzle 必须核对 SQL 类型、事务上下文、连接与取消语义。 |
| Migrator 替换现有 Drizzle 流程 | 需 POC；不能直接等价替换 | 缺少模板现有 journal/snapshot/内容哈希门禁，迁移历史格式也不同。查询层采用 Effect 不要求同时替换迁移体系。 |
| Schedule、Queue、PubSub | 进程内用途可直接采用；不可替代持久任务和 Kafka | 提供定时、背压与广播，不保存跨进程重启状态，不提供 Kafka topic、partition、consumer group、offset 与保留日志协议。 |
| Workflow/Activity/DurableQueue/cluster | 需 POC | 已有 SQL 持久化、去重、分片所有权与重启测试，但外部副作用幂等、跨版本恢复、死信处置仍需产品设计。 |
| NodeRedis | 需 POC；驱动真实存在 | 可替换模板手写 RESP 连接，仍需验证业务限流原子性、TTL、故障策略与取消边界。 |
| ClickhouseClient | 需 POC；驱动真实存在 | 官方客户端封装、查询取消、错误分类可用作起点。不能推导为 PostgreSQL 一样的事务能力。 |
| S3 | 不可直接替代 | 本次 Effect packages 文件及包清单搜索未发现 S3/AWS SDK 驱动。需保留现有适配器或另选 SDK 后自行封装。此结论不覆盖仓库之外的社区包。 |
| OpenTelemetry 与 @effect/vitest | 可直接采用到受控模块 | 统一 trace/metric/log 生命周期和可控时间测试；不自动提供业务审计、日志脱敏、告警规则或现场验收。 |

## SQL 事务与连接生命周期

`E/packages/effect/src/unstable/sql/SqlClient.ts:163` 从上下文获取当前事务连接，`:171` 定义 BEGIN、COMMIT、ROLLBACK 与 savepoint SQL。`makeWithTransaction` 在 `:273` 使用 `uninterruptibleMask` 保护事务收尾，只恢复用户逻辑的可中断性。成功时提交，失败或中断时回滚，最后关闭连接 Scope，见 `:294–328`。嵌套事务在 `:331–333` 使用同一事务层级的 semaphore，避免并行 savepoint 相互覆盖。

这能减少手写 try/finally 和漏回收，但边界很具体：

- 事务仅覆盖使用对应 SqlClient 及其上下文的 SQL。Drizzle/pg 单独创建的 pool 查询、Kafka 发布、S3 PUT 不会自动进入这个事务。旧模板 `T/apps/web/db/client.ts:1–6` 直接把 pg Pool 交给 Drizzle，没有 Effect 事务桥接。
- `SqlClient.ts:310`、`:317` 把 COMMIT/ROLLBACK 失败转为 defect；不可只捕获类型化 SqlError 就声称覆盖所有事务失败，更不能对“提交结果未知”盲目重试副作用。
- `E/packages/sql/pg/src/PgClient.ts:145–152` 对普通语句使用 pool borrower，事务和 LISTEN 使用保留连接。并非所有查询都要在调用方新开一个 Scope。
- `E/packages/sql/pg/src/PgConnection.ts:1455–1474` 在中断时发送取消并等待连接回到 ReadyForQuery，排空超时则销毁连接；`:206–208` 明确未固定的 multiplex 连接直接 interrupt 是 no-op，以免取消其他 Fiber 的查询。采用时必须明确选择池模式及查询 API。

源码测试证据较扎实。`E/packages/effect/test/unstable/sql/SqlClient.test.ts:111–175` 使用 harness 检查 begin 失败、回滚、关闭及提交；真实 PostgreSQL 集成测试 `E/packages/sql/pg/test/Client.integration.test.ts:254–285` 验证并发嵌套事务保留成功写入；`PgPool.integration.test.ts:103–125` 检查服务端 pg_sleep 被取消后连接仍能查询，`:205–227` 用单连接池验证成功、失败、中断后借用归还。此次只读了测试，没有执行这些用例。

## 迁移不能只比较 API

| 要点 | Effect Migrator | 旧模板 |
| --- | --- | --- |
| 执行入口 | `E/packages/effect/src/unstable/sql/Migrator.ts:100`，加载 Effect 迁移 | `T/apps/web/package.json:10–11`，drizzle-kit generate/migrate |
| 历史记录 | 默认 effect_sql_migrations；id/name/created_at，见 `Migrator.ts:111`、`:139–143` | 自定义 Drizzle schema/table，见 `T/apps/web/drizzle.config.ts:39–42` |
| 待执行判断 | 读取最大 migration_id，跳过所有 <= 最大值的迁移，见 `Migrator.ts:162–175`、`:249–253` | journal 对应 SQL 与 snapshot；当前仓库不含安装后的 drizzle-kit 实现，未核实其底层运行时算法 |
| 并发互斥 | PostgreSQL `LOCK TABLE ... ACCESS EXCLUSIVE`，见 `Migrator.ts:225`；建历史表在事务调用之前，见 `:305–308` | 自有代码未发现 advisory lock runner；实际调用 drizzle-kit，不能宣称模板已经实现 advisory lock |
| 原子执行 | 记录待执行项并执行迁移体，外层 sql.withTransaction，见 `Migrator.ts:262–285`、`:307–308` | 当前只确认调用 drizzle-kit，未安装依赖、未验证底层事务执行 |
| 内容完整性 | 所读实现无 checksum 列，也未重新比对已应用迁移内容；只检查当前 loader 数字 ID 重复，见 `Migrator.ts:240–244` | `migration-check.mjs:63–72` 检查 journal；`:78–92` 检查 snapshot；`:104–143` 计算和比对 SQL/snapshot SHA-256 |

Effect 的迁移表锁与 cluster 的 advisory lock 属于不同机制。`E/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts:55–57` 的 advisory lock 用于 shard 所有权，不是 Migrator 的迁移锁。两个都出现“lock”不能视为等价。

建议新模板先保留 Drizzle 生成与 journal/snapshot/哈希门禁。即使改用 Effect 查询，也可以保留一个独立、显式执行的迁移入口。若确实改用 Migrator，需要迁移历史映射、已应用文件不可改写规则、首次并发建表、双实例迁移、失败回滚及恢复测试。现有哈希门禁只是仓库文件一致性检查，也不能证明目标数据库 schema 未漂移；`db:migrate` 本身没有串接 `migration:check`，不能把静态门禁误写成每次迁移自动执行的检查。

还有启动副作用需要注意：`E/packages/effect/src/unstable/cluster/SqlMessageStorage.ts:79–83` 在构造 SQL message store 时直接执行自身 migrations，表前缀还影响迁移历史，见 `:54–60`。采用 cluster 前必须决定 schema 管理者及应用运行账号权限，不能只加一个 Layer 就默认允许生产应用启动时建表。

## 后台并发、关闭和重试

旧模板 `T/services/worker/src/async-runtime.ts:79–88` 使用无限循环加 setTimeout 轮询 outbox，`:100–108` 是有限迭代路径。Effect 的 `forkChild` 把子 Fiber 归属父 Scope，父结束则子结束，见 `E/packages/effect/src/Effect.ts:8508–8512`；`forkScoped` 跟随提供的 Scope，见 `:8594–8595`。适合把 worker 循环、连接和订阅交给同一个进程生命周期管理。

Scope 是清理机制，见 `E/packages/effect/src/Scope.ts:4–8`，不是崩溃后持久恢复协议。普通 Promise 只有观察 AbortSignal 才会停止，`Effect.ts:871–872` 已明说这一点。将现有 KafkaJS 或 S3 调用包成 tryPromise，不会自动撤销发送、停止服务端工作或回滚对象上传。

有界 Queue 提供吞吐背压，`E/packages/effect/src/Queue.ts:501`；shutdown 会清空消息并结束等待，`:1138–1155`，所以“关闭队列”也不是“完成排空”。产品应明确先关准入、等待处理或保留持久待处理项，再结束 Scope。Schedule.exponential、jittered、recurs、spaced 分别位于 `Schedule.ts:850`、`:1093`、`:1169`、`:1198`。重试次数、下次时间、幂等记录若需跨重启存在，必须放数据库或 durable 引擎，不能依赖 Schedule 的进程内计数。

可借鉴测试方式：`E/packages/effect/test/Scope.test.ts:7–16` 用 TestClock 证明并行 finalizer 都完成；`Schedule.test.ts:379–397` 检查次数耗尽，`:450–458` 用固定随机种子检查 jitter 范围。新 worker 应保留模板已有的任务与 offset 行为测试，而不是只补 Effect 类型检查。

## Workflow、Activity 与持久队列

Workflow 以 workflow tag 和业务提供的 idempotencyKey 生成执行 ID，见 `E/packages/effect/src/unstable/workflow/Workflow.ts:317`。Activity.idempotencyKey 再组合 executionId、名称，以及可选 attempt，见 `Activity.ts:251–272`。这些是稳定身份生成，不会证明同一个 key 的不同 payload 合法，也不会给外部系统自动添加唯一约束。是否把 attempt 加入外部幂等键必须由业务决定，否则每次重试可能被外部系统视为新操作。

`Activity.ts:122–125` 明确只缓存完成的 activity 结果，等待子 workflow 或 durable clock 而挂起时，恢复会重新运行 activity body，挂起前副作用可以重复。`WorkflowEngine.ts:655–671` 明确 layerMemory 只适合无需持久性的本地或测试环境，状态就在 Map 中。

真实持久路径存在。`E/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts:49–62` 接入 Sharding 和 MessageStorage；`SqlMessageStorage.ts:289` 使用 message_id 冲突去重，`:844–914` 定义数据库唯一约束。`SqlRunnerStorage.ts:86–100` 使用独立保留连接管理 PostgreSQL shard 锁，带释放和恢复逻辑。这个运行时可以承接分布式调度，但不能顺带替业务实现权限、状态机、租户隔离和外部协议 fencing。

DurableQueue 的实现比“持久 Queue”这个名字更值得逐项读：

- `E/packages/effect/src/unstable/workflow/DurableQueue.ts:215–239` 把 payload 和 deferred token 写入 PersistedQueue，携带确定性 ID 和 trace 上下文。
- `:298–340` 配置 worker 并发，处理函数的 Exit 写回 DurableDeferred。
- `:11–17` 明确至少一次投递；handler 成功后尚未确认时崩溃会重投。超过持久队列次数上限会进入 dead letter，等待的 workflow 保持 parked，需外部 requeue，还需单实例 cleanup。

因此推荐作为独立 POC，而不是用它直接替掉旧模板的所有 app_tasks/outbox/idempotency 表。POC 至少证明业务事务提交后 dispatch 丢失、handler 副作用成功后进程终止、锁丢失后的旧 owner、相同 key 不同 payload、取消与完成竞态、代码/Schema 升级后的旧任务恢复、死信 requeue 和清理后的去重边界。

测试要辨别层级。`E/packages/effect/test/cluster/ClusterWorkflowEngine.test.ts:39–43` 使用 MemoryDriver，虽覆盖 suspend/resume/dedup，也不是数据库耐久证据。`E/packages/platform/node/test/cluster-integration/Workflow.test.ts:807–839` 测试 SQL 后端重启后的 durable clock 和 queued work；harness `:31–32` 明确后端是 MySQL/PG。但 harness `:516–529` 的 stop/kill 是关闭 Scope 加模拟 controller 状态，不是操作系统 kill -9、机器断电或多机器网络分区。

`E/packages/sql/pg/test/Persistence.integration.test.ts:113–153` 的测试名虽称 exactly once，实际只是正常并发 worker 各消费一次；`:155–180` 的 crash recovery 是直接更新数据库模拟失效锁。它们不能推翻 DurableQueue 文档明确的至少一次语义。

## Kafka 与跨系统一致性

PubSub 的底层是原子内存结构、订阅者、Scope 与可选 ReplayBuffer，见 `E/packages/effect/src/PubSub.ts:65–74`、`:505–518`。bounded 队列满时背压，dropping 丢新消息，sliding 淘汰旧消息，分别见 `:297`、`:347`、`:394`。replay 只是进程内最近消息缓存。没有 Kafka 的磁盘日志、分区偏移量、消费组与 broker 协议，不能替代 Kafka。它可以承担同进程状态通知或订阅广播。

旧模板需要保留和强化的协议仍然明确：`T/services/worker/src/outbox.ts:105–123` 用 SKIP LOCKED 领取，`:200–214` 先提交领取状态，再发送 Kafka，再记 published。库级 Scope 不能消除发送成功与 published 落库之间的崩溃窗口。`T/services/worker/src/async-consumer.ts:298–305` 是 handler 成功、记录 succeed、提交 offset 的顺序，`:320–322` 是失败持久化后只为死信提交 offset。Effect 可重写这些步骤的控制流，不能改变 offset 只能跟随持久业务结果前进的约束。

同理，PostgreSQL 与 S3/Redis/ClickHouse 不是一个事务。旧模板 `T/docs/productionization-roadmap.md:18–22` 已要求唯一约束、条件更新和失败补偿。该文档是约束，不是所有补偿都已实现的证据。新模板仍需明确定义 outbox、幂等收件箱、对象键、重试、清理或补偿及操作者可见状态。RBAC 和所有权判断也必须由应用在边界执行，Context.Service 的依赖注入不能替代授权。

## 驱动与观测

Redis 驱动确实存在：`E/packages/platform/node/src/NodeRedis.ts:19–20` 连接 node-redis 和 unstable persistence Redis；`:43–61` 创建并在 Scope 结束关闭，`:75–90` 映射连接/命令错误。旧模板 `T/apps/web/lib/redis-client.ts:20–63` 是手写 Redis 协议调用。更换适配器有价值，但 node-redis use 的 Promise 包装没有为每次命令传递 AbortSignal，不能宣称 Fiber 取消会撤回已经提交的 Redis 命令。`E/packages/platform/node/test/NodeRedis.integration.test.ts:3–15` 使用 Redis Testcontainers，有真实后端用例；本次未执行。

ClickHouse 驱动确实存在：`E/packages/sql/clickhouse/src/ClickhouseClient.ts:14` 使用 @clickhouse/client，`:337–349` 接入 SqlClient，声明 BEGIN TRANSACTION；不能据此推导目标 ClickHouse 版本、表引擎及事务配置支持应用需要的 ACID。`E/packages/sql/clickhouse/test/Client.test.ts:13–27` mock 了底层客户端，`:37–61` 验证关闭和取消封装，不是真实 ClickHouse 事务验收。旧模板 compose `T/deploy/compose/docker-compose.yml:76–87` 有 ClickHouse 服务，但本次在 apps/web/lib 中未找到业务 ClickHouse 客户端实现，不能把 compose 容器当作已实现报表链路。

S3 路径仍需外部适配器。旧模板 `T/apps/web/lib/storage.ts:26–31` 转给 `s3-client.ts`，后者 `:68–88` 自行签名并执行 PUT。Effect 的错误通道、Scope、retry 可以包裹该调用，但不足以证明多段上传中止、重试覆盖、校验和、对象清理或与数据库原子提交。

观测可直接统一到 `E/packages/opentelemetry/src/NodeSdk.ts:123–148`，其 tracer/metric/logger 只有配置 processor/reader 才启用。SQL transaction span 和 commit/rollback 事件已在 `SqlClient.ts:275`、`:309–316`；DurableQueue 的 producer/worker trace 延续见 `DurableQueue.ts:227–235`、`:319–326`。但旧模板 `T/services/worker/src/logger.ts:13–44` 的敏感字段脱敏和业务 traceId、审计事件应保留，装 SDK 不会自动恢复这些策略。

`E/packages/vitest/src/internal/internal.ts:40–42` 提供 TestClock/TestConsole，`:367–368` 区分 scoped 的 effect 测试与真实时钟 live 测试。建议直接借鉴分层证据：纯状态机和重试用虚拟时钟；连接/锁/事务用真实服务；Kafka 重投、S3 补偿、进程硬终止与生产部署另做集成和验收。当前报告只能证明源码与已有测试内容，未证明测试通过或生产可用。
