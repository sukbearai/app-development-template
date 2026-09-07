# 候选4：以共享数据和契约划分边界

建议保留两个进程、三个共享包。Web 与 worker 共用 schema、事务实现和消息合同，各自持有连接池。默认按 vinext 设计，待用户选择框架；本候选未修改应用，也未运行兼容性验证。

## 先看使用方式

以下是拟定入口，尚未实现。开发者运行 `pnpm infra:up`、`pnpm db:migrate`、`pnpm admin:init`，然后用 `pnpm dev` 同时启动 Web 和 worker。迁移与管理员初始化显式执行，启动应用不建表。`pnpm verify --base <commit>` 按变更选检查；`--full` 即使工作区干净也执行完整验证。

两个调用点展示职责分配，签名为设计草图：

```ts
// Web POST /api/admin/users
const actor = await authenticate(request, db);
requirePermission(actor, "admin.write");
const input = CreateUser.parse(await request.json());
return respond(await createUser(db, actor, input));

// worker 收到 Kafka 消息
const event = TaskMessage.parse(message);
const result = await executeTask(db, handlers, event);
if (result.durable) await commitOffset(message);
```

`createUser` 的事务包含账号、角色关系及审计。`executeTask` 先检查幂等身份和 payload hash，再执行受租约保护的 handler；offset 失败只重试确认，不改写已经成功的任务。

## 模块和核心接口

```text
apps/web/          页面、route、Cookie、浏览器请求
apps/worker/       Kafka消费、outbox发送、心跳、停止入口
packages/contracts/ Zod请求响应、消息版本、OpenAPI生成
packages/data/    schema、迁移、pg/Drizzle、事务查询
packages/server/  身份/RBAC、用例、存储、配置、日志
scripts/          本地环境、备份恢复、验证分类器
.agents/skills/   pstack使用约定、真实浏览器验证
```

contracts 无服务器依赖，浏览器只能引用该包。data 不导入 server；server 不导入 Web 框架。包内按身份、文件、任务分文件，暂不把每个适配器拆包，也不增加通用 repository/service 基类。

```ts
type Actor = { userId: UserId; permissions: ReadonlySet<Permission> };
type Lease = { taskId: TaskId; owner: string; generation: number };
type TaskResult =
  | { durable: true; state: "succeeded" | "dead_letter" }
  | { durable: false; retryAt: Date };
transaction<A>(db: Database, body: (tx: Transaction) => Promise<A>): Promise<A>;
createUser(db: Database, actor: Actor, input: CreateUser): Promise<User>;
completeTask(tx: Transaction, lease: Lease, result: TaskOutput): Promise<boolean>;
```

事务内查询必须接收 `Transaction`，不能取全局 pool。Drizzle 和参数化 SQL 使用同一底层 pg 事务连接；不另建 Effect PgClient。角色查询只纳入 active，注销验证 secret，初始化使用安全哈希；数据库约束处理并发创建冲突。

## HTTP、资源和恢复所有权

Web 只保留一条边界链：trace/访问日志、可信代理与来源校验、认证授权、输入解析、用例、输出校验和错误映射。页面另做权限检查。服务器记录内部异常，客户端收到稳定错误码；响应合同覆盖各操作的成功数据和状态码。

进程组合根拥有连接池和 SDK 的启动、关闭。Web 请求不创建长期资源。worker 先停止认领、等待有界排空，再关闭连接；超时留下可恢复记录。outbox 使用到期租约重领和 generation 条件更新，旧 owner 无权完成。幂等、任务、事件及数据库业务结果同事务提交；Kafka 维持至少一次语义。

上传先落持久意图和确定对象键，再 PUT，最后事务提交元数据、审计、outbox。崩溃后由 worker 核对意图并补偿，失败可查询。S3 与 PostgreSQL 不宣称原子；外部任务副作用也必须接受幂等键，否则转人工处理。

## Effect 与依赖选择

先借鉴 Effect 的显式错误、资源归属和可控时钟；实际采用限定在 worker 的 Scope、Fiber、Schedule 和日志上下文。持久重试次数、租约、死信保留在 PostgreSQL，Schedule 仅负责唤醒。是否采用须先证明 SDK 取消、排空和连接释放。

固定兼容版本后再引入。当前 vinext `1.0.0-beta.9`、Vite 8，Effect `4.0.0-rc.112` 均有版本风险；`@effect/vitest` 要求 Vitest 5，不能顺便更换全仓测试框架。HttpApi、Effect SQL/Workflow 暂不采用，避免同时迁移 HTTP、数据库及持久任务协议。

## 分步验收和拒绝项

1. 对照五份分析冻结清单：9个页面、15个HTTP操作、13张表、RBAC、迁移、上传、审计埋点、异步观测、备份及开发门禁。Redis/Kafka/S3须真实接通；ClickHouse保留部署配置，明确旧版无业务链路。
2. 临时 PostgreSQL 验证空库迁移、旧结构升级、事务回滚、并发冲突和账本完整恢复。已有数据库另按授权操作；备份必须包含业务和迁移账本。
3. 真HTTP与浏览器验证登录、撤权、注销、CSRF、三个管理表单、上传，以及输出合同；验证构建产物和客户端依赖隔离。
4. PostgreSQL/Kafka/S3 验证崩溃窗口、过期租约、同键异载荷、毒消息、offset失败和SIGTERM。pstack沿用独占服务身份检查，交付实际命令及证据。

拒绝按旧目录复制、共享巨型barrel、双数据库客户端事务和用内存Queue替代Kafka。旧版伪发布、dry-run落成功、明文管理员及无恢复租约不属于需要保留的能力。

依据：同目录 `identity-http.md`、`data-storage.md`、`runtime-tooling.md`、`effect-core-http.md`、`effect-data-runtime.md`。以上为架构候选，验收项均未在本轮执行。
