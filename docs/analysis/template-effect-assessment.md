# pstack-x 应用模板改造前设计对照

日期：2026-09-07。阶段：改造前分析完成，以下目标架构与实施计划尚未成为应用代码。

## 结论

可以从 Effect 吸收更完整的依赖、资源、错误、并发和契约设计，但不建议把旧模板整体翻译成 Effect。推荐以 **vinext/Vite + pnpm monorepo + Zod + Drizzle/PostgreSQL** 为第一阶段基础，先完成全部能力对齐与已确认缺陷修复。Effect 的资源与运行时机制放在 worker 隔离试点，达到退出、取消、故障和版本验证条件后再采用。HttpApi、Effect SQL/Migrator、Workflow/Cluster 不作为第一阶段必需依赖。

旧模板提供的是管理应用和后台执行的基础，不是所有基础设施均已验收的完整产品。完整能力对齐应保留真实功能、修正缺陷，并将占位和规划继续明确标记。ClickHouse 的可选 Compose 配置属于需保留的工程能力，分析报表写入链路不属于旧模板已实现功能。

本方案保留当前 pstack-x 的 vinext，尚未收到其它框架偏好。Next.js 兼容性是需要实测的迁移条件，不以 API 名称相似判定通过。pstack 的角色模型沿用此前指定的 `gpt-6-astra@high`，不把相同模型的独立评估称为跨模型验证。

## 证据与范围

| 对象 | 当前证据基线 |
| --- | --- |
| app-development-template | `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`，参考仓库只读 |
| Effect | `5a802043984727b0c5a291af39d1b9bbfa8d7b8b`，核心版本 `4.0.0-rc.112`，参考仓库只读 |
| pstack-x | 无初始 commit，现有应用文件均未跟踪；vinext `1.0.0-beta.9`、Vite 8、React、Tailwind、Chromium 验证技能 |
| 静态清单 | 149 个跟踪文件、18 份 Markdown、根包及 3 个 workspace、9 个页面、13 个显式 API 文件和 1 个兜底 API 文件、15 个业务 HTTP 操作、13 张表、3 条迁移、18 个测试/浏览器 setup 文件、15 个脚本、3 个 repo skill |

第一次粗盘的 122 个工程文件只统计 apps/packages/services/scripts/deploy/CI 子目录。以上 149 个跟踪文件是包含根文件、文档、技能和 loops 的完整范围。测试文件数不等于通过用例数。

可复核材料：

- [完整结构、文档章节和入口清单](capability-inventory.md)，[机器可读清单](inventory.json)，[重建脚本](scripts/inventory.py)。
- [身份、RBAC、HTTP 与管理端源码分析](reference-notes/identity-http.md)。
- [数据、迁移、备份、上传与基础设施源码分析](reference-notes/data-storage.md)。
- [后台执行、部署、验证和 agent harness 源码分析](reference-notes/runtime-tooling.md)。
- [Effect 核心、HTTP、Schema、配置与测试对照](reference-notes/effect-core-http.md)。
- [Effect SQL、迁移、后台执行与基础设施对照](reference-notes/effect-data-runtime.md)。

这些分项报告保留具体文件与行号，并明确区分源码判断、仓库现有测试和本轮真正执行的验证。本报告用 T 表示旧模板，用 E 表示 Effect，路径均相对对应仓库根目录。

## 旧模板所有设计领域与迁移决策

| 领域 | 旧模板当前能力与限制 | Effect 对照 | pstack-x 决策 |
| --- | --- | --- | --- |
| Monorepo | web/shared/worker，服务端数据实现主要放 Web 内 | Layer 将依赖构建与业务实现分开，但不决定仓库布局 | 保留 workspace；把 Web/worker 真正共用的数据库与服务放共享服务器包 |
| Web 框架 | Next.js 16.2.7，App Router、RSC、Cookie、redirect、router.refresh | Web Request/Response 桥接可用；不替代页面框架 | 保留 vinext；验证 Cookie、RSC、动态路由、重定向、HMR、生产构建 |
| 管理 UI | 9 页面，顶栏、侧栏、图表、用户/角色/权限/文件/审计/outbox | Effect 不提供成品管理端或设计系统 | 完整迁移页面及实际操作，保留响应式和统一组件 |
| 前端请求与缓存 | fetch wrapper、React Query provider/hook、skeleton；管理页主要服务端直读 | 可选 Atom/HttpApiClient 不是必要替换 | 保留 React Query 可用能力，实际需要时使用；保留 trace/code/details |
| 账号与密码 | scrypt、账号启停、开发种子；仍接受 plain: | Context.Service 可承载规则，不提供账号产品 | 保留 scrypt；新模板移除生产已知密码，独立初始化管理员 |
| Session | PostgreSQL session、id.secret、secret hash、有效期、撤销 | Service/Layer 管实现依赖；security 只解码凭据 | 保留会话模型；修复 logout 校验、TTL 和撤销规则 |
| Cookie/Bearer | 同一 session token 两种传递方式 | HttpApiSecurity 有提取器和安全声明 | 保留两种入口；不把 SERVICE_TOKEN 配置当成已有服务账号 |
| RBAC | users/roles/permissions 及关系表；页面/API 双校验 | 依赖注入不等于授权；示例 token 非 RBAC 实现 | 服务端统一有效权限，只纳入 active 角色；菜单不是安全边界 |
| 对象归属 | requireResourceOwner helper 有测试，没有生产资源路由使用 | Effect 不知道对象所有者或租户 | 保留扩展接口，在真实资源读取/修改处接线；不声称已有多租户 |
| 来源与限流 | Cookie 同源 helper、内存桶、Redis；代理信任和原子性不足 | Middleware/Config 可承载边界策略 | 明确可信代理、来源及原子 Redis 限流；补负向行为测试 |
| HTTP 路由 | 15 操作、显式 route.ts、catch-all 仅 404 | HttpApi 定义可派生路由/客户端/文档 | 第一阶段保持显式路径、方法和操作语义 |
| 输入/输出契约 | Zod 输入，手写 OpenAPI，成功 data 无具体 schema | Schema/HttpApi 的单一事实来源设计更完整 | Zod 类型推导+JSON Schema 生成，端点登记绑定具体成功/错误 schema；不双写 Effect Schema |
| HTTP 错误 | ApiError；未知异常原文回 400，坏 JSON 转空对象 | `Effect<A,E,R>`、Exit/Cause、命名错误 | 分开预期错误、未知 5xx 和取消；错误映射放传输边界 |
| 数据访问 | Drizzle + pg；Web 与 worker 使用不同访问代码 | SqlClient 有事务连接上下文、savepoint、Scope | 首期只用一套 pg/Drizzle 事务；Effect 包装整项操作不能创建第二个事务池 |
| 数据模型 | 13 表，部分外键；状态类型主要在 TS | Schema/SqlModel 可解码，但不是完整关系 DDL 生成器 | 保留实体，补必要 CHECK/唯一约束/状态版本；HTTP schema 与 DB schema 各自负责边界 |
| 迁移生成 | drizzle-kit generate 提供 schema 差异 SQL + journal/snapshot | Effect Migrator 执行迁移，不提供同等 schema diff | 保留 db:generate 真正生成功能，不用“空 SQL 骨架”冒充等价 |
| 迁移执行/检查 | drizzle-kit migrate 与静态 SHA256/DDL 门禁分开 | Migrator 有表锁与事务，无已应用文件 checksum 比对 | 一个迁移所有者和账本；检查后执行；补真库漂移、并发及回滚验证 |
| 备份恢复 | pg_dump/custom、manifest、显式 confirm restore，默认漏账本 | Effect 不提供数据库与对象一致恢复方案 | 备份含业务及迁移账本；checksum 必填；先 verify 再 restore，空库恢复后能继续迁移 |
| 文件上传 | local/S3 PUT、元数据、大小 helper；全量 multipart 内存解析 | 可用 Stream/Scope，仓库无可直接替代的 S3 驱动 | 保留 local/S3 能力；真实读取限额、确定对象键、上传意图、补偿和引用核对 |
| 文件保留期 | local TTL 清理只按文件 mtime，不核对 DB 引用 | Schedule 只是调度，不能判断数据归属 | 区分 staging 与持久附件，只清理受管且可删对象，dry-run 不写 |
| 审计与埋点 | PostgreSQL audit/telemetry + traceId，后续 outbox | 日志/OTel 可贯穿上下文，不替代审计记录 | 业务、审计、outbox 同库原子；匿名埋点限制体积/频率 |
| Outbox | SKIP LOCKED claim、Kafka send、retry/dead_letter | Scope/Schedule 可规范执行，不消除发布/落库窗口 | 至少一次发布，持久租约+代次、过期锁恢复、只读 dry-run |
| 消费幂等 | 有 task/idempotency/events helper，无真实领域接线 | DurableQueue/Workflow 提供另一套运行时，仍至少一次 | 保留 Kafka 协议；原子抢占/完成，offset 确认独立，不复制缺陷 |
| 任务恢复与取消 | 有字段及 helper，缺完整运行中取消、毒消息、重放流程；已到期重试分支会停止 consumer，没有自动重启 supervisor | Fiber 中断、Workflow 恢复有帮助但不提供外部业务幂等 | 明确 worker 所有权、持久恢复及领域 handler 接入合同；分别验收等待后重投和停止后恢复，演示 handler 不当业务验收 |
| Worker 生命周期 | 无限轮询、每批 pool/producer、无统一 drain | Layer/Scope/Fiber 是最值得直接试点的改进 | 进程级资源、停止认领→排空/保留重试→关闭；硬崩溃由租约恢复 |
| 健康与观测 | DB 只检查 URL，其他多是 TCP；worker health 固定 ok | Metrics/OTel 可提供运行观测，不自动生成就绪语义 | 分 liveness/readiness/业务积压，验证真实 DB/协议与主循环进度 |
| 配置与 secrets | Web Zod、worker/脚本分别加载 env，优先级不一 | Config/ConfigProvider/Redacted 可组合与注入 | 统一配置权威和 env 优先级，明确字符串布尔解析、生产约束、客户端公开字段 |
| Redis | 手写 RESP，AUTH/SELECT 多响应解析错误，INCR/EXPIRE 分开；session 不在 Redis | NodeRedis 实际存在，可统一连接生命周期 | 换成熟客户端/原子脚本需真实 Redis POC；覆盖密码、数据库选择和分片响应，保持内存模式语义与告警 |
| Kafka | KafkaJS producer/consumer helper，单节点 Compose | PubSub/Queue 无 broker/offset/消费组持久语义 | 不用内存 PubSub 替 Kafka；修复容器内外 advertised listener |
| MinIO/S3 | 真 PUT adapter，Compose 无 bucket init | Effect 可包 SDK，无原子 DB+S3 魔法 | 可选存储 profile 保留并增加初始化与真实 PUT/HEAD/补偿验证 |
| ClickHouse | Compose 与环境配置占位，无业务写入/查询 | 有 ClickhouseClient，部分测试 mock SDK | 保留可选服务和扩展入口；不为对齐模板捏造分析业务 |
| Docker/Compose | 五种数据服务+worker，无 web Compose；镜像整个工作区 | Effect NodeRuntime 不替代部署拓扑 | 保留可选配置；做 Web/worker 制品、迁移 job、服务命名/端口隔离 |
| CI/门禁 | typecheck/contracts/tests/build/dev smoke；路由器有漏类 | Effect 上游有类型/运行/时钟/真实驱动分层测试 | 修门禁路由，补真实后端和生产制品检查；不只统计测试数 |
| pstack 开发 | 3 repo skill、dev-local、pr-verify、docs/loops | Effect LLMS/ai-docs 可作选定 API 的本地依据 | pstack 负责通用工作流；项目技能负责运行、迁移、验收；保留现有独占浏览器证据机制 |

## 必须先纠正的旧模板行为

“源码确认”表示控制流直接可见；“隔离复现”表示执行了真实函数体或 schema；两者都不等于已做真实数据库/浏览器利用测试。

| 优先级 | 问题、影响与最小修复方向 | 证据和验证级别 |
| --- | --- | --- |
| 阻断 | inactive 角色仍授予权限；logout 不验证 secret 即按 id 撤销。统一有效权限求值，撤销前完整认证 | T `apps/web/lib/auth-service.ts:50`、`:208`；两个函数隔离探针均复现 |
| 阻断 | 迁移无条件写 admin/plain:admin，生产校验不检查该身份。迁移结构与管理员初始化分开，明确生产 bootstrap | T `apps/web/db/migrations/0001_core.sql:108`、`lib/password.ts:13`；源码确认 |
| 阻断 | 业务/审计/outbox 分离；上传对象成功后 DB 失败无补偿。用同库事务及持久上传意图修复 | T `apps/web/lib/product-service.ts:22`、`:42`、`auth-service.ts:144`；源码确认 |
| 阻断 | dry-run 仍写 published；processing 锁崩溃后不恢复；默认部署会消耗 outbox | T `services/worker/src/outbox.ts:105`、`:169`、`:210`；源码确认 |
| 阻断 | 幂等 start 无条件 upsert；完成幂等/任务/事件非原子；注入 helper 的 commitOffset 失败会进入业务失败分支。默认 runner 的真实提交在 helper 外，不能声称该默认路径也会改写成功 | T `services/worker/src/async-consumer.ts:297`、`:451`、`:477`、`:626`；源码确认，真实并发待验 |
| 阻断 | 默认备份 public 不含 drizzle 账本，manifest 迁移版本来自本地文件；缺 checksum 可通过，restore 不先 verify | T `scripts/db-backup.mjs:170`、`:192`、`:211`、`:224`；源码确认 |
| 必修 | 未知异常原文作为 400 返回；坏 JSON 被转成空 PATCH。输入错误明确拒绝，未知错误脱敏 500 | T `apps/web/lib/api-response.ts:33`、`:56`；源码确认 |
| 必修 | 表单 await 后读取 currentTarget；next 只做 startsWith('/')；Cookie TTL 固定值与 session 配置不一致 | T `components/admin/admin-actions.tsx:28`、`login-form.tsx:9`、`lib/request-auth.ts:58`；浏览器结果待验 |
| 必修 | 环境字符串 false 被 coerce.boolean 转成 true，导致 path-style 配置失真 | T `apps/web/lib/env.ts:23`；Zod 4.4.3 真实 schema 隔离复现 |
| 必修 | Redis URL 带密码或数据库路径时，AUTH/SELECT 的正常 +OK 响应被 INCR 整数解析器拒绝；首次 TCP data 即结束读取也不能处理分片响应 | T `apps/web/lib/redis-client.ts:7`、`:35`、`:42`；原客户端加本地 TCP 响应替身复现 AUTH/SELECT 问题，未运行真实 Redis 登录链路 |
| 必修 | OpenAPI 成功 data 不绑定类型；health 的 503 被写成错误包；认证/冲突状态缺漏 | T `apps/web/scripts/api-contracts.mjs:104`、`:144`；源码确认 |
| 必修 | health 只证明配置/端口；Kafka 容器拿到 localhost broker；MinIO 无 bucket 初始化 | T `lib/health-service.ts:9`、`deploy/compose/docker-compose.yml:43`、`:58`；部署效果待验 |
| 必修 | pr-verify 漏 lib/依赖/部署等路径；干净树 --full 提前返回 | T `scripts/pr-verify.mjs:113`、`:138`、`:158`；源码确认 |

完整风险及限定条件见五份分项报告。源码中的 owner helper、React Query hook、consumer helper 和 SERVICE_TOKEN 不等于对应业务已经接通。最后管理员、自停用、已失效 session 再启用等行为需要明确目标规则，不静默复制旧行为。

## Effect 中值得吸收的方案

### 服务、错误和资源

采用 `Effect<A,E,R>` 的思想明确结果、预期失败及依赖，把未知异常和取消留给运行边界。当前源码名为 `Context.Service`，不要混用早期 v4 的 ServiceMap 或 v3 写法。连接池、Kafka producer/consumer 和定时任务属于进程组合根，用户请求只拥有自己的 signal。

Effect `Layer`、`ManagedRuntime`、`Scope` 能降低漏回收与隐含依赖风险。源码见 E `packages/effect/src/ManagedRuntime.ts:285`、`Scope.ts:382`。本轮真实包探针验证了一次构造、多次使用和 dispose 后释放，以及失败路径释放。

但普通 Promise/SDK 只有接收并执行 AbortSignal 才可取消；finalizer 不能应对 kill -9 后的业务补偿。不要把每个 Promise 都套一层 Effect 后宣称可靠性提高。先选择 worker 组合根作为边界试点，库的采用以真实故障验证和明显减少手写生命周期代码为准。

### 契约单一事实来源

HttpApi 的价值是统一请求/响应 schema、路由与客户端/文档，不是改一组 import。E `HttpApiBuilder.ts:63`、`OpenApi.ts:283` 有实际实现；本轮探针返回合法请求 200、非法请求 400，并生成相应 OpenAPI。

第一阶段可用已有 Zod 4 的 `z.toJSONSchema` 消除手写 schema，保留端点登记与状态/权限元数据，按操作绑定具体响应。这也已用旧模板真实 login schema 做了隔离验证。生成 JSON Schema 不能完整表达 trim/转换等运行行为，仍要做运行输入/输出契约测试。

`Schema.toStandardSchemaV1` 是验证协议，不是 Zod AST 到 Effect AST 的无损转换。若以后采用 HttpApi，应按完整业务组迁移 schema、handler、client 和文档，并删除该组旧定义；不要长期维护两套权威 schema。浏览器不因共享 contracts 而导入服务器 Layer、数据库或秘密配置。

### SQL、迁移和持久执行

Effect SQL 对事务连接、嵌套 savepoint、取消和收尾的设计值得学习，见 E `SqlClient.ts:163`、`:273`。第一阶段仍由 Drizzle/pg 唯一负责事务；所有参加一次写入的仓储方法必须接收同一个 tx。把 Drizzle Promise 放进 Effect SQL withTransaction 不会加入它的事务。

Effect Migrator 的 PostgreSQL `ACCESS EXCLUSIVE` 表锁不同于 cluster 的 advisory shard lock。它不具备旧模板的 SQL/snapshot SHA256 门禁，也不替代 Drizzle schema diff 生成。保留既有迁移工具更符合功能对齐。

Fiber/Scope/Schedule/Queue 适合进程内并发、背压、唤醒和退出。重试次数、nextRetryAt、租约代次、幂等和完成事实要留在 PostgreSQL。Kafka 仍是至少一次投递，业务成功与 offset 确认分开。Effect PubSub 不替代 Kafka。

Workflow/Cluster/DurableQueue 有真实持久化实现，但位于 unstable。DurableQueue 文档明确至少一次；缓存 activity 结果不会给外部副作用自动去重。需要独立验证代码升级恢复、租约丢失、副作用成功后崩溃、死信重放与运维处置，不能同时复制一套 app_tasks 和引入另一套 workflow 事实源。

## 推荐目标结构

以下为拟定结构，不是当前仓库现状。

```text
apps/web/               vinext 页面、显式 HTTP 路由、Web 适配、管理 UI
packages/contracts/     Zod 请求/响应/消息、派生类型、端点清单、OpenAPI
packages/database/      schema、迁移、单一连接/事务入口、仓储
packages/server/        身份权限、文件、审计、任务用例、配置和适配器
services/worker/        发布/消费、租约恢复、心跳、退出组合根
scripts/                本地环境、备份恢复、验证路由、模板初始化
deploy/compose/         core 及 redis/kafka/storage/analytics 可选 profile
.agents/skills/         项目启动、数据操作和真实验证技能
docs/                   架构、契约、迁移、部署、验证和能力边界
loops/                  可选动态工作记录，不复制旧维护历史
```

三个共享包有明确理由：contracts 可被浏览器读取；database 统一 Web/worker 数据与事务；server 表达框架无关用例。暂不拆通用 repository 基类、adapter 接口包或独立 API 进程。

开发者保留原有 `dev/build/start`、`db:generate/migrate/integration`、`backup:*`、`api:docs`、`contract:check`、`migration:check`、`test:*`、`pr:verify` 命令。增加安全管理员初始化和基础设施 profile 入口。原来无完整实现的取消/重放/领域业务不得靠命令名称视作交付。

关键类型和所有权草图如下，尚未编译或实现：

```ts
type Actor = { userId: UserId; permissions: ReadonlySet<Permission> }
type Lease = { taskId: TaskId; owner: WorkerId; generation: number }
type DurableResult =
  | { state: 'succeeded'; receipt: Receipt }
  | { state: 'retryable'; retryAt: Date }
  | { state: 'dead_letter'; reason: Failure }
  | { state: 'canceled'; canceledAt: Date }

createUser(actor: Actor, input: CreateUserInput): Promise<User>
commitUpload(operation: UploadOperation): Promise<FileAsset>
executeTask(envelope: TaskEnvelope): Promise<DurableResult>
```

这些公开方法隐藏完整事务，避免调用者逐步协调“写主行→写审计→写事件”。内部 tx 必须显式传递，预期失败不得作为普通成功值返回而意外提交事务。角色状态、任务状态、锁代次和合法转移应落实到数据结构与条件更新。

文件写入使用持久意图→确定对象键 PUT→同事务确认元数据/审计/outbox；失败保留协调记录，清理前核对引用和代次。数据库和对象存储不宣称原子。

## 候选裁决

四个独立 GPT-6 Astra 候选均已完成，并由另一个 Astra 实例复核。以保守方案为基础，吸收局部 Effect 方案的进程资源所有权，以及边界方案的 contracts/database/server 分离。这里的保守指控制依赖替换范围，不是保留已确认缺陷。

| 候选 | 六项评分合计，满分 18 | 裁决 |
| --- | --- | --- |
| 保留 Zod/Drizzle，先借鉴 Effect | 16 | 作为基础；明确补回 ClickHouse 可选配置和 db:generate 差异生成验收 |
| 按共享数据/契约划分包 | 16 | 吸收三包边界；暂不默认同时启动所有 worker/基础设施 |
| 服务端整体局部 Effect 化 | 15 | 吸收资源/事务所有权；实际采用限先通过 worker POC |
| 全面 Effect-first | 11 | 不选；改变 schema 差异生成能力，且同时切换多套协议 |

评分标准为功能不退化、事务/生命周期、契约单源/浏览器隔离、版本成本、可验收性、模块深度。采用建议以功能不退化为硬条件，不按总分掩盖能力损失。详见 [独立裁决](reference-notes/design-review.md)。用户指定统一模型，因此没有跨模型多样性证据。

## 改造步骤与可证伪验收

| 阶段 | 改造范围 | 完成条件 |
| --- | --- | --- |
| P0 基线与隔离 | 保留现有未提交文件、建立源快照、workspace、依赖固定、contracts/database/server 边界 | 根与子包命令可运行；旧 9 页面/15 操作及工程命令均进入逐项待验收清单；客户端禁止导入 server/database |
| P1 数据与身份 | 单一 Drizzle schema/账本、管理员初始化、session/RBAC、来源/限流、错误契约 | 新库覆盖原 13 表能力及新增协调结构；旧结构升级至同一目标；generate 能产生 schema 差异；业务/审计/outbox 任一步失败全部回滚；坏 secret 不注销、停用角色 403、过期/撤销拒绝、并发角色创建唯一成功 |
| P2 管理端与文件 | 全部管理页面/操作、具体响应 schema、审计埋点、local/S3 意图及补偿 | 真实浏览器创建/修改/启停/登出/上传；失败 UI 与 DB 一致；上传故障无不可追踪孤儿对象；OpenAPI 与运行响应一致 |
| P3 后台与中间件 | 真 Kafka outbox/消费接线、Redis 限流、MinIO、持久租约/幂等、worker 生命周期 | 发布后强杀进程再重启可恢复；同 key 同 payload 并发去重，异 payload 拒绝；外部副作用有接收方幂等证明；offset 失败不抹成功；旧租约无权完成；毒消息可追踪；SIGTERM 正常关闭；dry-run 无持久变化 |
| P4 运维与交付 | 全量备份/账本恢复、Compose profiles、Web/worker 制品、CI 和 verify-pstack-x 扩展 | 独立库恢复后可登录且可继续迁移；真实生产构建/容器启动；clean-tree full 仍执行；相关变更分类无遗漏；证据清理后仍保留 |
| P5 Effect 采用门槛 | worker 资源生命周期对照试点，必要时 HTTP 小组独立试点 | 真实资源复用/关闭、超时取消、强杀恢复及构建兼容通过；有可说明的维护收益，才固定版本进入默认模板 |

P3 的全部可选能力仍需各自验证后才算模板完整，不能因为默认只启动 PostgreSQL 而省略 Redis/Kafka/S3 验收。ClickHouse 保留配置/profile 和接入文档，真实分析业务应由具体项目另定。

现有数据库与共享基础设施不在本阶段操作范围。后续新建的隔离数据库可用于迁移/恢复测试；改已有库前必须识别目标与备份，不能让示例 env 覆盖显式连接参数。

历史已应用迁移不得改写。新模板的安全管理员初始化与旧模板已部署数据库的增量修复是两条路径，分别验证。若重新生成新模板基线，不得拿它直接覆盖旧库账本；旧结构兼容性测试应使用独立副本和显式增量迁移。

## 本轮真正执行的验证

| 命令或工件 | 结果 | 证明范围 |
| --- | --- | --- |
| `scripts/inventory.py` | 生成完整 JSON 清单 | 文件、入口与设计文档覆盖，不证明实现正确 |
| T Web 目录 `node scripts/migration-check.mjs` | 3 迁移、3 SQL hash、2 snapshot hash 通过 | 静态迁移文件完整性；未访问数据库 |
| T Web 目录 `node --test tests/unit/access-control-routes.test.mjs` | 6/6 通过 | 源码字符串守卫；未执行真实授权 |
| `.verification/template-analysis/identity-probe.mjs` | 两项错误行为复现 | 真实函数体隔离执行，仓储替身；非真实 API 利用 |
| `.verification/template-analysis/effect-probe/probe.mjs` | Layer/Scope/HttpApi 机制通过 | 安装于证据目录的发布包 rc.112，进程内 Web Request；不是本地 Effect HEAD 的构建测试 |
| `.verification/template-analysis/effect-probe/zod-probe.mjs` | false 配置问题复现、真实 login schema 输出 JSON Schema | 固定 Zod 4.4.3 的真实 schema 隔离运行；没有 S3/应用服务 |
| `node docs/analysis/scripts/redis-probe.mjs <template>` | 普通 INCR 返回 1；AUTH/SELECT 正常响应均被错误拒绝 | 原客户端与短时 loopback TCP 响应替身；不是 Redis 服务或登录端到端验证 |

两个参考仓库都没有 node_modules，本轮未在其中安装依赖、启动服务或修改文件。没有运行它们的全量测试，也没有执行 PostgreSQL/Kafka/MinIO/Redis/ClickHouse 真集成或 vinext+Effect 的框架集成。此前 pstack-x hello 应用的浏览器验证只证明旧起始页，不能用于新模板能力验收。

隔离探针安装和结果保存在 `.verification/template-analysis/effect-probe/`，包含 package.json、package-lock.json、result.json、zod-result.json 和生成 schema。审计轨迹在 `.verification/template-analysis/decisions.tsv`。所有修改均为 pstack-x 分析文档或隔离证据，运行时代码尚未改造。

复核记录见 [本次复核](revalidation.md)。本次重新核对了源版本、清单和上述探针，补入 Redis 协议问题并修正 offset 失败的适用范围。分项调查和四候选保留各自当时的建议，最终采用决定以本报告为准。
