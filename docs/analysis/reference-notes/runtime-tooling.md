# 后台执行、工程与 agent harness 只读分析

参考仓库：`/Users/fayon/workspace/github/app-development-template`，HEAD `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。工作区 `git status --short` 无输出。以下证据路径均相对于参考仓库，明确标记 pstack-x 的除外。本轮仅阅读源码、脚本、测试和文档，没有安装依赖、运行测试或服务、访问数据库。报告是静态能力评估，不代表运行验收。

## 结论

模板已有真实 PostgreSQL outbox 发布器、Kafka consumer 通用辅助函数、任务状态与事件表，以及本地环境和验证脚本。它还不是接好业务消费者、覆盖崩溃恢复的任务平台。`async-runtime` 实际仅建 topic 和循环发 outbox；消费函数没有生产调用点。默认 dry-run 会把数据库中的事件改为 published，不能把默认启动解释成 Kafka 发布成功。源码同时存在幂等抢占、状态原子性、offset 错误归类、过期锁恢复和退出处理不足，迁移时应保留设计目标并替换这些实现。

## 工程结构与现有能力

| 范围           | 已实现能力                                                                                                                             | 证据                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| pnpm monorepo  | apps/web、packages/shared、services/worker 三个 workspace；web 拥有路由、数据库、服务和测试，shared 拥有 Zod 契约，worker 拥有后台代码 | `pnpm-workspace.yaml:1`；`docs/technical-design.md:5`；`AGENTS.md:5`                                                                |
| Web 构建       | Next.js 16.2.7、React 19.2.3；根 build/start 只构建/启动 web                                                                           | `apps/web/package.json:7`；`apps/web/package.json:34`；`package.json:9`                                                             |
| Worker 执行    | tsx 直接运行 TypeScript；health/readiness/alerts/outbox-once/outbox-loop/async-runtime CLI                                             | `services/worker/package.json:7`；`services/worker/src/index.ts:124`                                                                |
| 配置           | 发布驱动枚举校验、正整数参数、Kafka brokers/group、重试和幂等 TTL 参数；可跳过 env 文件供测试隔离                                      | `services/worker/src/env.ts:42`；`services/worker/src/env.ts:59`；`services/worker/src/env.ts:83`                                   |
| 诊断           | 结构化日志及字段脱敏；outbox backlog、dead-letter 和 stale lock 查询；管理员按 topic 和任务状态聚合健康信息                            | `services/worker/src/logger.ts:1`；`services/worker/src/outbox-readiness.ts:95`；`apps/web/lib/async-runtime-health-service.ts:142` |
| 迁移与备份     | Drizzle SQL/journal/snapshot 检查；数据库 dump、manifest、校验与显式 confirm 恢复入口                                                  | `docs/technical-design.md:91`；`scripts/db-backup.mjs:173`；`scripts/db-backup.mjs:211`                                             |
| Agent 工程入口 | dev-local.sh、pr:verify、三个 repo skill、loops 工作状态目录                                                                           | `docs/agent-harness.md:16`；`loops/README.md:14`                                                                                    |

## 真实后台链路

### 生产端写入

`recordTelemetry` 先插 telemetry 记录，再写 `telemetry.events` outbox。`storeUploadedFile` 先写对象，再写文件元数据、审计，最后写 `files.events` outbox。outbox 使用随机事件 ID、pending、attempts=0、maxAttempts=5，并记录 traceId 和时间。它们是实际持久写路径，但不是业务记录与 outbox 同事务。对象写入后若后续任一步失败，也未在该服务中记录补偿清理任务。证据：`apps/web/lib/product-service.ts:22`、`:42`、`:64`、`:75`，`apps/web/lib/repository.ts:277`。

### Outbox 发布

1. 每批创建 pg pool 和 Kafka producer，先连接 producer，再开始认领事务。证据：`services/worker/src/outbox.ts:181`。
2. 用单条 CTE、`FOR UPDATE SKIP LOCKED` 选择到期 pending/failed 事件并改成 processing，写 locked_by/locked_at，然后提交事务。多个正常运行的发布器可以避免同时认领同一待处理行。证据：`services/worker/src/outbox.ts:105`、`:200`。
3. 逐条向实际 topic 发送 Kafka 消息，key 为 traceId 或 eventId；value 保留 eventId/eventType/traceId、可选任务元数据与业务 payload。证据：`services/worker/src/outbox.ts:65`、`:87`、`:169`。
4. 发完后写 published；异常则增加 attempts，按指数退避设 next_attempt_at，达到 maxAttempts 后写 dead_letter 和错误。证据：`services/worker/src/outbox.ts:127`、`:143`、`:210`。
5. finally 释放连接、断开自建 producer、关闭 pool。证据：`services/worker/src/outbox.ts:220`。

这属于至少一次发布基础结构，不能保证 Kafka 与 PostgreSQL 原子提交。Kafka 已接收而 published 写入失败时会记录 failed 并重发；进程在认领后退出则留下 processing。路线文档“multiple workers ... without double-publishing”应限制为正常并发认领，不能扩展成跨故障只发一次。证据：`docs/productionization-roadmap.md:75`。

### 消费与持久任务

- `parseAsyncTaskMessage` 接受 string/Buffer/null，要求 JSON object 与 eventId/eventType/traceId，补 taskId、attemptCount、maxAttempts 和 source offset；默认幂等 key 为 eventType:eventId。领域 payload 直接断言为泛型，没有调用 shared 中现成的 Zod message schema。证据：`services/worker/src/async-consumer.ts:149`、`:153`；`packages/shared/src/index.ts:157`。
- `processAsyncConsumerMessage` 先加载幂等状态。已成功重复消息、已 canceled/dead_letter 消息跳过 handler 并提交；失败未到期返回 deferred_retry；到期后 start、handler、succeed、commit。handler 失败写 failed 或 dead_letter，只有 dead_letter 提交。证据：`services/worker/src/async-consumer.ts:225`、`:247`、`:259`、`:273`、`:295`。
- `app_idempotency_keys` 存状态、TTL 和 response_data；`app_tasks` 存任务摘要，`app_task_events` 存尝试次数、重试时间、错误及 Kafka source 信息。task 与 event 的写入共享一个事务。证据：`services/worker/src/async-consumer.ts:347`、`:354`；`apps/web/db/migrations/0002_async_task_runtime.sql:1`。
- `runKafkaConsumer` 是真实 KafkaJS consumer 实现，订阅 topic、fromBeginning=true、关闭 autoCommit 和 eachBatchAutoResolve；顺序处理，成功后提交 offset+1，再 resolveOffset、heartbeat。retry 等待每 5 秒 heartbeat。证据：`services/worker/src/async-consumer.ts:571`、`:597`、`:625`、`:562`。
- 可设置 maxMessages 和 maxWaitMs；监听不可重启 CRASH；finally 移除监听、stop/disconnect。证据：`services/worker/src/async-consumer.ts:583`、`:645`、`:675`。
- DLQ 当前只是 PostgreSQL 中的 dead_letter 状态与任务事件，没有独立 Kafka DLQ topic 发布器，没有已接通的重放、取消 API 或领域 handler。`runKafkaConsumer` 全库搜索仅见定义，`async-runtime` 只调用 `processOutboxOnce`。证据：`services/worker/src/async-runtime.ts:91`、`services/worker/src/async-consumer.ts:316`、`:516`。
- `app_tasks` 本身没有完整业务 payload，task_events 也只存 source/重试元数据。重做业务仍依赖 Kafka 原消息及尚存 outbox。不能当作可独立重放的持久任务执行引擎。证据：`apps/web/db/migrations/0002_async_task_runtime.sql:14`；`services/worker/src/async-consumer.ts:395`。

## 应当明确记录的不足

| 问题                      | 触发及结果                                                                                                                                                                                                                                                                                                 | 证据                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| dry-run 修改真实状态      | publishOutboxEvent 在 dry-run 直接返回，调用方仍执行 markPublished；Compose 默认 dry-run，启动 worker 会把已有 outbox 当作发布完成                                                                                                                                                                         | `services/worker/src/outbox.ts:170`、`:213`；`deploy/compose/docker-compose.yml:110`           |
| stale processing 不恢复   | 认领只看 pending/failed；崩溃遗留 processing 只被 readiness 查询告警，无重新认领、租约续期、恢复命令                                                                                                                                                                                                       | `services/worker/src/outbox.ts:110`；`services/worker/src/outbox-readiness.ts:112`             |
| consumer 并发幂等不足     | hasCompleted 与 start 分离，start 对 key 无条件 upsert processing；并发相同 key 可同时执行。lockedBy/lockedUntil 没形成数据库租约或 fencing                                                                                                                                                                | `services/worker/src/async-consumer.ts:247`、`:288`、`:451`                                    |
| 完成证据不原子            | succeed 先更新幂等表，再另起事务写 task/event。后者失败时可能存在已完成幂等和未完成任务。start/fail 也分成两次写入                                                                                                                                                                                         | `services/worker/src/async-consumer.ts:451`、`:477`、`:496`                                    |
| offset 失败可改写成功     | handler、store.succeed、commitOffset 同一个 try；若显式 commitOffset 实现抛错，会走 store.fail，把已经执行成功的任务变回可重试或 dead_letter                                                                                                                                                               | `services/worker/src/async-consumer.ts:297`、`:314`                                            |
| committed 语义分层混杂    | createAsyncConsumerOptions 默认 commitOffset 是 no-op，helper 返回 committed=true；runner 再负责真实 commit。直接调用 helper 的“committed”不证明 Kafka 已提交                                                                                                                                              | `services/worker/src/index.ts:102`；`services/worker/src/async-consumer.ts:539`、`:625`        |
| 重试再次投递与重启未闭合  | 未提交结果的 nextRetryAt 在未来时，等待后退出 batch；已到期或无等待时间时，runner 的 onRetryableFailure 拒绝等待结果并停止 consumer，没有自动重启 consumer 的 supervisor。代码未显式 seek 到失败 offset 或当场重试同一消息；未来时间分支的同会话重投和后续 batch 不越过失败 offset 没有真实 Kafka 集成证明 | `services/worker/src/async-consumer.ts:543`、`:635`、`:638`                                    |
| poison message 无隔离     | JSON 解析/必要字段失败发生在 handler try 之前，不持久化 malformed DLQ；可令 consumer crash 并反复遇到同一坏消息                                                                                                                                                                                            | `services/worker/src/async-consumer.ts:229`、`:297`                                            |
| 长 handler 与退出能力不足 | heartbeat 只在提交或等待重试时调用，执行 handler 时无周期 heartbeat；worker 没有 SIGTERM/SIGINT drain/停止认领机制，无限 loop 无 AbortSignal                                                                                                                                                               | `services/worker/src/async-consumer.ts:621`、`:632`；`services/worker/src/async-runtime.ts:79` |
| 取消不等于运行中取消      | 只在执行前读取 canceled 状态；没有 handler AbortSignal、条件完成更新或取消与完成竞态保护                                                                                                                                                                                                                   | `services/worker/src/async-consumer.ts:259`、`:298`、`:363`                                    |
| TTL 与 key 边界较弱       | 幂等查询仅看未过期 key；过期后可重执，key 不含 consumer group，request_hash 写了 eventId 却不比较冲突 payload                                                                                                                                                                                              | `services/worker/src/async-consumer.ts:149`、`:417`、`:453`                                    |
| 健康并不证明活跃          | worker health 只返回固定 ok，Compose healthcheck 新开进程执行该函数；无法证明主循环前进、Kafka 可写或数据库可访问                                                                                                                                                                                          | `services/worker/src/index.ts:21`；`deploy/compose/docker-compose.yml:125`                     |
| 观测计数不精确            | readyToRetry=pending+failed 未过滤到期；staleLocks.count 是 LIMIT 20 的列表长度；admin 健康把所有 outbox/task 拉到内存聚合                                                                                                                                                                                 | `services/worker/src/outbox-readiness.ts:118`、`:139`；`apps/web/lib/repository.ts:362`        |
| env 优先级可覆盖部署值    | worker 将 .env/.env.local/.env.test 文件 override=true，可能覆盖显式进程环境；repoRoot 又依赖 cwd 为 services/worker                                                                                                                                                                                       | `services/worker/src/env.ts:42`                                                                |
| 遗留伪发布函数            | repo.publishOutboxBatch 仅 SELECT 后 UPDATE published，没有 Kafka send/锁；markOutboxPublished 调它。全库搜索未见生产路由调用，属于可删的危险遗留能力                                                                                                                                                      | `apps/web/lib/repository.ts:320`；`apps/web/lib/product-service.ts:98`                         |

上述重试重投条目是未被测试证明的运行风险，其他条目直接来自所列控制流。没有把未经运行的推断描述为已经复现。

## 部署与本地运行

- Dockerfile 固定 Node 22 digest 和 pnpm 10.32.1，冻结 lockfile 安装，缓存 pnpm/Next 构建；默认 pnpm start，worker 覆盖 command 执行 tsx async-runtime。镜像复制整个构建目录，没有生产依赖裁剪、独立 worker 编译产物或非 root USER。证据：`Dockerfile:1`、`:22`、`:30`、`:38`；`deploy/compose/docker-compose.yml:104`。
- Compose 包含 PostgreSQL 17、Redis 7、Kafka 3.7、MinIO、ClickHouse、worker，命名持久卷和基础设施 healthcheck。没有 web service、反向代理/TLS、迁移 job、restart policy、滚动部署或发布流水线。应定位为本地开发依赖集合。证据：`deploy/compose/docker-compose.yml:1`、`:94`、`:131`。
- Kafka advertised listener 为 localhost，worker bootstrap 为 kafka:9092；container 内获取 broker metadata 后会指向自己的 localhost。迁移真实 Kafka 容器链路须区分 INTERNAL/EXTERNAL listeners。证据：`deploy/compose/docker-compose.yml:43`、`:115`。
- `scripts/dev-local.sh up` 只启动五个基础设施和 tmux 里的 web，不启动 worker，不迁移数据库，不等待完整 readiness。status 读 tmux/Compose/端口，TCP 开着不证明本仓库服务；已有同名 web tmux 窗口会直接复用，缺源码路径和进程身份验证。down 默认只杀 tmux，--all 再 compose down，不删除 named volume。证据：`scripts/dev-local.sh:110`、`:119`、`:137`、`:146`、`:158`。
- backup:create 有真实 dump 和 manifest，verify 有 archive list 与 checksum 比较，restore 需要 --confirm。但 verify 未强制 manifest 必须包含 checksum，restore 不先自动 verify；恢复后检查只是核心表存在，也不是备份恢复演练。证据：`scripts/db-backup.mjs:211`、`:224`、`:244`。

## 测试与 CI 实际证明范围

Worker 只有 `tests/worker.test.mjs`。覆盖 runtime plan、缺失配置、dry-run、脱敏、envelope/key、readiness 分类、内存 fake store 的成功去重/延期/死信、顺序批次停止和 retry 算法。没有执行 PostgreSQL store、真实 claim/send、Kafka consumer rebalance、崩溃恢复、并发幂等、成功后 offset 失败或 SIGTERM 测试。证据：`services/worker/tests/worker.test.mjs:1`、`:54`、`:185`、`:235`、`:304`。

根 verify 是 typecheck、contract:check、unit+integration、web build、test:e2e。test:e2e 启动 Next dev 并跑 HTTP smoke，不使用刚生成的生产构建；smoke 是登录、me、users、outbox list 和 404。浏览器 test:ui 是单独入口。证据：`package.json:32`；`apps/web/scripts/e2e.mjs:31`；`apps/web/scripts/smoke.mjs:53`；`apps/web/package.json:24`。

GitHub CI 只有 PostgreSQL service，install、db:migrate、pnpm verify，没有 Kafka/Redis/MinIO/ClickHouse 集成环境、test:ui、Docker build 或发布制品验证。db:integration 单独脚本只查 11 张表与 admin seed，DATABASE_URL 缺失时退出 0 且不属于根 verify。证据：`.github/workflows/verify.yml:9`；`apps/web/scripts/db-integration.mjs:7`、`:33`。

## Agent harness 与门禁

三个 skill 分别定义环境、handoff 验证、持续维护；明确 docs 存稳定事实，loops 存动态状态，禁止 secrets/测试产物进入 loops，loop 记录日期与证据并人工维护。它们不是定时后台 agent，domain cadence 为 manual。harness skill 留有旧绝对路径 `/Users/fayon/workspace/gpdata/app-development-template`，迁移时应去掉机器路径。证据：`.agents/skills/app-template-harness/SKILL.md:8`；`.agents/skills/app-template-loop/SKILL.md:16`；`loops/domains/template-maintenance/README.md:6`；`loops/README.md:25`。

`pr-verify` 读取 git diff base 与 untracked，按 docs/API/migrations/worker/UI/scripts 路径安排门禁；shell=false 执行，第一项失败就停止，写 Markdown summary，不 commit/push/开 PR。默认 base=HEAD。证据：`scripts/pr-verify.mjs:11`、`:56`、`:91`、`:113`、`:188`、`:224`。

迁移前须修正路由器本身：

1. `apps/web/lib/*`、根依赖/lockfile、Dockerfile、Compose、CI 配置没有类别，单独改变这些路径可能只跑 diff sanity。`packages/shared` 也只匹配 src，测试或包配置不覆盖。证据：`scripts/pr-verify.mjs:113`。
2. 无改动分支在处理 --full 前提前 return，所以干净树 `--full` 仍只 diff sanity；--ui 虽写入 touches 也同样被提前 return。提交后不指定对比基线会漏检已提交工作。证据：`scripts/pr-verify.mjs:138`、`:158`、`:162`。
3. git diff --check 不使用 --base，也不加 --cached，校验范围与检测到的范围不一致；缺 spawn error 监听、超时/取消、每命令独立持久日志，失败后 summary 只列已执行项，没有清楚列未执行项。证据：`scripts/pr-verify.mjs:56`、`:134`、`:204`、`:228`。
4. API 路由也位于 app/，会自动归成 UI 触发浏览器；规则粒度过粗。证据：`scripts/pr-verify.mjs:116`、`:125`。

## 迁给 pstack-x 的取舍

pstack-x 当前使用 vinext 1.0.0-beta.9、Vite 8 和 pnpm 10.33.4，build/start 已是 vinext；已有 verify-pstack-x skill 的身份检查、独占 server、Chromium 交互和 evidence 工作流。证据：pstack-x `package.json:1`、`.agents/skills/verify-pstack-x/SKILL.md:9`。因此不能直接复制 Next.js 命令和默认 tmux 复用策略。

| 处理方式                   | 内容                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保留并适配                 | workspace 边界、shared Zod 契约、显式 API 路由登记与生成文档、Drizzle 迁移完整性、任务与事件观测字段、结构化日志和脱敏、备份 manifest、docs/loops 职责分工、按修改范围给出可审计命令报告                |
| 保留目标，重新实现         | 事务 outbox 写入、consumer 条件抢占和 fencing、幂等/任务/事件原子持久化、独立 offset 确认、崩溃重试/过期锁恢复、毒消息隔离、运行中取消及优雅退出。明确至少一次投递，以领域幂等保护副作用                |
| 替换                       | Next build/start/dev 为 vinext；完整镜像布局按 vinext 输出验证；Kafka 容器 listener；dry-run 状态语义；worker health 为当前进程心跳/循环进度及依赖 readiness；pr-verify 分类器和 clean-tree --full 行为 |
| 沿用 pstack-x 当前更强入口 | 保留已有独占启动、checkout/lock/PID/port 身份验证、无复用现存 server 的 Chromium 证据流程，向其扩展新业务 feature map；不要退回纯端口/tmux 识别                                                         |
| 按需引入                   | Kafka、Redis、MinIO、ClickHouse、独立 worker。先明确产品是否存在对应业务边界；后台能力接通前不把 async-runtime 当完整任务系统验收                                                                       |
| 删除或不带入               | 未调用的 markOutboxPublished/publishOutboxBatch 伪发布路径、旧绝对机器路径、模板 maintenance 历史记录、固定 container_name/通用 tmux session 等多项目冲突默认值                                         |

若要把后台能力列为首批可验收项，最低补充证据应包含：真实 PostgreSQL+Kafka 发布消费闭环；同 key 并发仅一次有效副作用；发布后写库失败与进程崩溃恢复；offset 提交失败不抹成功；延迟重试不越过失败 offset；毒消息可追踪；SIGTERM drain；真实构建产物启动。它们是后续迁移验收需求，本轮未执行。
