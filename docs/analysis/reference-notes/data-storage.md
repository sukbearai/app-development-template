# 参考模板的数据与存储设计

分析对象：`/Users/fayon/workspace/github/app-development-template`，HEAD `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。本报告只分析参考仓库，不表示这些能力已迁入 pstack-x。

本次读取 AGENTS.md、文档索引及相关设计、schema、迁移、repository、上传、备份、环境、compose 和测试源码。参考仓库 `git status --short` 为空。未安装依赖、启动服务、访问数据库或执行备份恢复。只运行了不连接数据库的 `node scripts/migration-check.mjs`，输出 `migration check ok (3 Drizzle migrations, 3 SQL hashes, 2 snapshot hashes)`。

下列 `file:line` 均相对参考仓库根目录。

## 设计及实际访问层

设计规定 PostgreSQL 保存结构化事实，对象存储保存文件，local 目录只作开发暂存，Redis 保存短期协调状态，Kafka 由 outbox 驱动。见 `docs/technical-design.md:83`。

Web 实际采用 `pg.Pool -> drizzle-orm/node-postgres -> typed repository`，没有 SQLite、内存业务库或数据库未配置时的假数据回退。Pool 在模块加载时按 `DATABASE_URL` 创建，未配置的所有业务方法由 `requireDb()` 抛错。见 `apps/web/db/client.ts:1`、`apps/web/lib/repository.ts:20`、`apps/web/lib/repository.ts:63`。

Web repository 集中处理用户、角色、权限、session、audit、telemetry、文件元数据、outbox 和后台计数。worker 的 task/idempotency/outbox 使用原生参数化 SQL，不通过 Web Drizzle repository。Web Pool 未显式设置容量、连接超时或统一关闭入口；worker async store 设置 `max: 4` 并提供 close。见 `apps/web/lib/repository.ts:20`、`services/worker/src/async-consumer.ts:342`。

## 全部数据实体

共 13 张业务表，另有 Drizzle 迁移账本。完整表定义在 `apps/web/db/schema.ts`。

| 实体                   | 主要字段及约束                                                                                                                                                                                                  | 证据                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `app_users`            | text ID 主键；account 唯一；displayName、passwordHash、status；createdAt/updatedAt。status 默认 enabled                                                                                                         | `apps/web/db/schema.ts:3`       |
| `app_roles`            | text ID 主键；name、status、createdAt。status 默认 active                                                                                                                                                       | `apps/web/db/schema.ts:13`      |
| `app_permissions`      | text ID 主键；name                                                                                                                                                                                              | `apps/web/db/schema.ts:20`      |
| `app_user_roles`       | userId/roleId 联合主键，分别外键到 users/roles                                                                                                                                                                  | `apps/web/db/schema.ts:25`      |
| `app_role_permissions` | roleId/permissionId 联合主键，分别外键到 roles/permissions                                                                                                                                                      | `apps/web/db/schema.ts:32`      |
| `app_user_sessions`    | ID、userId 外键、secretHash、expiresAt、createdAt、lastUsedAt、revokedAt；userId 索引                                                                                                                           | `apps/web/db/schema.ts:39`      |
| `app_audit_logs`       | ID、actorId、action、targetType/targetId、traceId、JSONB metadata、createdAt；traceId 索引                                                                                                                      | `apps/web/db/schema.ts:51`      |
| `app_telemetry_events` | ID、event、route、traceId、JSONB payload、occurredAt；traceId 索引                                                                                                                                              | `apps/web/db/schema.ts:64`      |
| `app_file_assets`      | ID、fileName、mimeType、bigint sizeBytes 映射 JS number、storageKey、uploadedBy、uploadedAt                                                                                                                     | `apps/web/db/schema.ts:75`      |
| `app_outbox_events`    | ID、topic、eventType、JSONB payload、status、attempts/maxAttempts、nextAttemptAt、lockedBy/lockedAt、publishedAt、errorCode/lastError、traceId、createdAt/updatedAt；status+nextAttemptAt、status+lockedAt 索引 | `apps/web/db/schema.ts:85`      |
| `app_idempotency_keys` | key 全局主键；scope、requestHash、JSONB responseData、status、createdAt/expiresAt；scope、expiresAt 索引                                                                                                        | `apps/web/db/schema.ts:107`     |
| `app_tasks`            | ID、taskType、status、progress、traceId、objectType/objectId、errorCode/message、createdAt/updatedAt；status、trace、object、type+status 索引                                                                   | `apps/web/db/schema.ts:120`     |
| `app_task_events`      | ID、taskId、traceId、eventType、status、message、JSONB payload、createdAt；taskId+createdAt、traceId 索引                                                                                                       | `apps/web/db/schema.ts:139`     |
| Drizzle 账本           | 默认 `drizzle.drizzle_migrations`，schema 可由 `APP_TEMPLATE_MIGRATIONS_SCHEMA` 指定                                                                                                                            | `apps/web/drizzle.config.ts:39` |

数据库层只有 RBAC 关联和 session 建了外键。audit.actorId、file.uploadedBy、taskEvent.taskId、task.objectId 均为普通 text，未声明引用关系。各类 status、progress、attempts 在数据库没有枚举或 CHECK 限制；repository 多处直接把字符串断言为共享契约的状态类型。不能把 TypeScript 声明等同于现存数据合法性校验。见 `apps/web/db/schema.ts:51`、`apps/web/db/schema.ts:75`、`apps/web/db/schema.ts:85`、`apps/web/db/schema.ts:120`、`apps/web/lib/repository.ts:31`、`apps/web/lib/repository.ts:298`。

没有 tenant、项目级隔离、文件 provider/bucket/version/checksum、删除状态等通用实体字段。存储 provider 只进入上传 outbox payload，未保存在 `app_file_assets`。见 `apps/web/db/schema.ts:75`、`apps/web/lib/product-service.ts:55`。

## 迁移生成、应用及安全门禁

根命令转发至 Web：`db:generate = drizzle-kit generate`、`db:migrate = drizzle-kit migrate`。schema 为 `./db/schema.ts`，输出 `./db/migrations`，PostgreSQL dialect、strict/verbose 开启。见 `apps/web/package.json:11`、`apps/web/drizzle.config.ts:32`。

现有迁移如下。

| 文件                            | 变更                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `0001_core.sql`                 | 10 张基础表、索引、4 项权限、管理员角色、管理员账号和角色关联。见 `apps/web/db/migrations/0001_core.sql:1`、`:93`         |
| `0002_async_task_runtime.sql`   | idempotency、tasks、task_events 3 张表和索引。见 `apps/web/db/migrations/0002_async_task_runtime.sql:1`                   |
| `0003_outbox_runtime_state.sql` | outbox 补 maxAttempts、锁信息、publishedAt、错误字段和锁索引。见 `apps/web/db/migrations/0003_outbox_runtime_state.sql:1` |

`0001` 写入 `admin / plain:admin`，不是生产可沿用的管理员口令策略。当前 `verifyPassword` 仍接受 plain 前缀，未按生产模式禁用。见 `apps/web/db/migrations/0001_core.sql:108`、`apps/web/lib/password.ts:13`。实际项目应按文档更换初始化账号与哈希，不直接复制种子。

迁移规范要求先改 schema、生成 SQL、审查 SQL 与 meta；后续采用一次性 DDL，使漂移暴露；不得靠 `IF NOT EXISTS` 掩盖漂移，例外须记入 debt。见 `AGENTS.md:64`、`docs/technical-design.md:91`。

`migration:check` 真实覆盖：

- SQL 文件名必须为四位连续编号，从 0001 开始；journal tags 与 SQL 清单完全相等；idx、version、when、breakpoints 必须有效。见 `apps/web/scripts/migration-check.mjs:45`。
- 最新 snapshot 编号必须追上 SQL，version/dialect 与 journal 对齐。当前 snapshots 为 0002、0003；不要求每个历史 SQL 都有独立 snapshot。见 `apps/web/scripts/migration-check.mjs:75`、`apps/web/db/migrations/migration-integrity.json:7`。
- SQL 与所有 snapshot 的 SHA256 必须和 manifest 一致，增加/删除文件也须同步 manifest。见 `apps/web/scripts/migration-check.mjs:104`、`:127`。
- 用正则拒绝 `DROP TABLE`、`TRUNCATE TABLE`、`DROP COLUMN`；统计含 `IF NOT EXISTS` 的迁移，对照债务名单和上限。当前 snapshot lag 与 fallback DDL 上限均为 0。见 `apps/web/scripts/migration-check.mjs:95`、`:148`、`apps/web/db/migrations/migration-debt.json:1`。

门禁局限：它是文件结构、hash 和局部 SQL 文本检查，不加载 schema.ts，也不连接数据库。它不证明 schema.ts 与 snapshot/SQL 语义相等、不证明既有数据库无漂移、不校验升级后的真实约束和数据、不演练回滚。它也没有识别 `DELETE FROM`、所有 ALTER 类型变化等完整破坏性 SQL 的机制。正则报错提到“显式迁移计划”，但脚本没有读取计划并放行的路径。见 `apps/web/scripts/migration-check.mjs:22`、`:95`、`:162`。

`db:integration` 只查询 public 中 11 张表，再检查 admin 账号存在且 password_hash 非空；漏掉 `app_user_roles` 和 `app_role_permissions` 两张关联表，没有校验列、外键、索引、角色权限种子、账本版本和 CRUD。无 DATABASE_URL 时 exit 0 并显示 skipped；但脚本先载入根 `.env.example`，正常模板示例已提供默认 DATABASE_URL，因此通常会尝试本机数据库。见 `apps/web/scripts/db-integration.mjs:5`、`:15`、`:34`、`apps/web/scripts/load-script-env.mjs:22`、`.env.example:13`。

环境优先级也需单独处理：Drizzle 配置先读根 `.env.example`，再以 override 方式读 Web `.env/.env.local/.env.test/.env.test.local`，这些文件可以覆盖传入的 DATABASE_URL；普通脚本 loader 还读根 `.env/.env.local`。备份 loader 则用 `||=` 保留先前值，优先级不同。且 `APP_TEMPLATE_DB_SCHEMA` 仅用于备份，Drizzle schema 定义和 db:integration 都未借此切换业务 schema。见 `apps/web/drizzle.config.ts:13`、`apps/web/scripts/load-script-env.mjs:22`、`scripts/db-backup.mjs:35`、`:55`。

## 事务与一致性边界

| 操作                                    | 已有原子范围                                                                                                 | 范围外的步骤及含义                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建/更新用户                           | users + user_roles 同一个 Drizzle transaction                                                                | 只覆盖 repository 内两表写入。见 `apps/web/lib/repository.ts:116`、`:134`                                                                                                             |
| 创建/更新角色                           | roles + role_permissions 同一个 transaction                                                                  | 关联采用 delete 后重建，事务保护中间状态。见 `apps/web/lib/repository.ts:150`、`:160`                                                                                                 |
| Session、audit、file、telemetry、outbox | 各自单条 insert/update                                                                                       | 不自动参与调用方的统一事务。见 `apps/web/lib/repository.ts:178`、`:202`、`:229`、`:252`、`:277`                                                                                       |
| 记录 telemetry                          | 先 telemetry insert，再独立 outbox insert                                                                    | 第二步失败时已留下 telemetry，重试可能重复。见 `apps/web/lib/product-service.ts:22`                                                                                                   |
| 上传                                    | 对象 PUT → file metadata → audit → outbox                                                                    | 无对象删除补偿、共同数据库事务、上传幂等键或失败协调记录。对象成功而 DB 失败会留下孤立对象；后续 audit/outbox 失败可能向用户报错但文件已入库。见 `apps/web/lib/product-service.ts:42` |
| Worker 领取 outbox                      | BEGIN + `FOR UPDATE SKIP LOCKED` + processing/lock 更新 + COMMIT                                             | Kafka send 和 DB markPublished 在领取提交后执行，属于至少一次发布边界。send 成功但标记失败可能重发。见 `services/worker/src/outbox.ts:105`、`:195`、`:210`                            |
| Task 状态和事件                         | `writeTask` 把 tasks upsert + task_events insert 放在同一事务；事件 ID 按 taskId/eventType/attemptCount 确定 | idempotency start/succeed/fail 先独立写，再调用 writeTask，不与 tasks/events 原子提交。见 `services/worker/src/async-consumer.ts:354`、`:451`、`:477`、`:496`                         |

Worker 的幂等表主键是 key，scope 不是联合键；start 冲突时无条件改为 processing，request_hash 实际写 sourceEventId，未在此 SQL 路径比较同 key 是否对应同一 payload。它提供重复检测基础，不是跨消费者抢占与业务副作用事务的完整方案。见 `services/worker/src/async-consumer.ts:417`、`:451`。

outbox claim 只领取 pending/failed；processing 锁过期由 readiness 报告，但该领取 SQL 不回收过期 processing。进程在领取提交后崩溃，事件不会自动再次被这一领取路径选中。见 `services/worker/src/outbox.ts:110`、`services/worker/src/outbox-readiness.ts:112`。

默认 dry-run 仍领取和标记 published，只跳过 Kafka send，因此不能当成无写入预览。见 `services/worker/src/outbox.ts:169`、`:181`、`:210`。Web 还保留 `publishOutboxBatch`，它只把 pending 行改为 published，没有 Kafka 发送，当前检索仅见 product-service 包装和单测调用，未见路由调用。见 `apps/web/lib/repository.ts:320`、`apps/web/lib/product-service.ts:98`、`apps/web/tests/unit/product-service.test.mjs:13`。

## 上传及对象存储

`POST /api/uploads` 先执行写权限与来源检查，再按 Content-Length 做预检，解析 formData，验证 File 类型及实际大小，最后调用 storeUploadedFile。默认最大 10 MiB，multipart 预检另留 1 MiB overhead；空文件拒绝，超限 413。见 `apps/web/app/api/uploads/route.ts:12`、`apps/web/lib/upload-memory-limits.ts:3`、`apps/web/lib/env.ts:14`。

无 Content-Length 或非正值时预检直接跳过。实际文件大小校验在 formData 全量解析之后，随后还生成 arrayBuffer/Buffer，故不是流式限流或严格内存上限。没有总 multipart 字节流计数、文件数限制、MIME 内容检测、恶意文件扫描；目前只取名为 file 的条目。见 `apps/web/lib/upload-memory-limits.ts:23`、`apps/web/app/api/uploads/route.ts:18`、`apps/web/lib/product-service.ts:47`。

服务生成 `file_<UUID>_<safeName>`，文件名非 word/dot/hyphen 替换为下划线。local adapter 创建 storageDir 并 writeFile；目前调用方生成的 key 不含目录分隔符，但 adapter 自身没有做路径归一和目录越界校验。见 `apps/web/lib/product-service.ts:48`、`apps/web/lib/storage.ts:17`。

S3 adapter 为手写 AWS SigV4 的实际 HTTP PUT：完整内容 SHA256、region credential scope、path style 或 bucket hostname、签名 headers、fetch PUT，非 2xx 抛错。没有 STS session token、multipart/direct upload、Get/Delete/HEAD adapter、显式超时/重试或 bucket 初始化。见 `apps/web/lib/s3-client.ts:31`、`:48`、`:77`。

环境布尔值 `OBJECT_STORAGE_FORCE_PATH_STYLE` 使用 `z.coerce.boolean()`，环境字符串 `"false"` 仍按 JS truthy 转成 true，因此通过通常的环境字符串配置无法切换到 virtual-host 模式。见 `apps/web/lib/env.ts:23`、`apps/web/lib/s3-client.ts:38`。此结论来自 Zod coercion 声明与代码路径，本次未装依赖或连接 S3 重演。

清理脚本 `storage:cleanup`：root 可由 `--root=` 或 UPLOAD_STORAGE_DIR 指定，默认 `.uploads`；TTL 默认 72 小时；支持 `--dry-run=1`；拒绝根目录、cwd、推导的仓库根目录；递归删除 mtime 早于 cutoff 的普通文件及空目录，跳过非普通文件。见 `apps/web/scripts/cleanup-local-storage.mjs:13`、`:21`、`:31`。

清理不查数据库、不删除 metadata、不判断文件是否仍被引用，也不清理 S3。脚本只拒绝少量 exact root 值，不把 root 限定为受管暂存目录。没有定时触发器或清理任务持久化记录。若将 local 文件当成长期附件保存，72 小时清理会造成 DB metadata 悬挂。见 `apps/web/scripts/cleanup-local-storage.mjs:21`、`:47`、`docs/technical-design.md:87`。

## 备份与恢复

根层 `scripts/db-backup.mjs` 提供 create/verify/restore。使用本机 pg_dump/pg_restore；仅在程序不存在 ENOENT 时退回 `postgres:17-alpine` 工具容器，将 localhost/127.0.0.1 替换为 host.docker.internal。见 `scripts/db-backup.mjs:77`。

| 能力     | 实际行为与边界                                                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create   | `pg_dump --format=custom --no-owner --no-privileges --schema <schema>`；schema 默认 public；写 `.dump` 和 manifest。见 `scripts/db-backup.mjs:192`                                                                                                                                  |
| manifest | id、schema、format、createdAt、latestMigration、dumpFile/Bytes/Sha256、tableCount、estimatedRows、totalBytes、逐表统计。最新迁移取本地 journal，表统计来自 dump 后另一次 DB 查询。行数是 reltuples 估计值，不是 snapshot 精确 count。见 `scripts/db-backup.mjs:132`、`:144`、`:170` |
| verify   | 调 pg_restore --list，再读取 manifest 和计算 SHA256；只有 manifest.dumpSha256 存在且不匹配时才失败，缺失 checksum 字段也会输出 checksum ok。见 `scripts/db-backup.mjs:211`                                                                                                          |
| restore  | 必须显式 --confirm；执行 `pg_restore --clean --if-exists --no-owner --no-privileges --dbname`；成功后只 SELECT app_outbox_events LIMIT 1。无自动调用 verify、无 single-transaction、无 schema 参数约束恢复对象、无应用停写或回滚协调。见 `scripts/db-backup.mjs:224`、`:244`        |

默认 public-only dump 不含默认放在 drizzle schema 的迁移账本。恢复到空库后业务表可能已在，而迁移账本缺失，再执行一次性建表迁移会冲突；恢复覆盖旧库时又可能留下与数据不对应的旧账本。此边界由 `scripts/db-backup.mjs:55`、`:203` 与 `apps/web/drizzle.config.ts:39` 共同确定。

manifest 没有记录数据库实测应用的迁移版本、数据库版本、应用 commit、对象文件清单或 Kafka offset。它是 PostgreSQL 单 schema 备份工具，不是数据库+对象存储+队列一致恢复方案，也不具备 PITR/WAL、加密、备份保留/轮转、远端副本或定时恢复演练。现有代码中未发现相应扩展路径。见 `scripts/db-backup.mjs:170`、`:192`、`:224`。

## 基础设施真实接入与占位

| 基础设施   | 真实接入                                                             | 当前默认与限制                                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | Web repository、worker 原生 SQL、Drizzle migrate、备份均是真实客户端 | compose 为 postgres:17-alpine，named volume；Web health 只检查 DATABASE_URL 是否存在，不执行 DB 查询。见 `deploy/compose/docker-compose.yml:2`、`apps/web/lib/health-service.ts:9`                                                                                                                                                            |
| Redis      | 登录限流实际通过 TCP RESP 发 INCR/EXPIRE/DEL                         | 默认 memory；数据库 session 不在 Redis。客户端逐连接发送命令，非成熟 RESP 流解析器、无 TLS/ACL 用户名路径；INCR/EXPIRE 是两次独立操作。见 `apps/web/lib/rate-limit.ts:48`、`apps/web/lib/redis-client.ts:20`                                                                                                                                  |
| Kafka      | kafkajs producer 实际发送 outbox；async-runtime 可创建配置的 topics  | 默认 dry-run；async-runtime 当前只启动 outbox loop，没有注册业务 consumer。consumer/store 是可接入组件。compose 单节点 plaintext，advertised listener 为 localhost，对容器内 worker 的 broker metadata 可达性需实测。见 `services/worker/src/outbox.ts:96`、`services/worker/src/async-runtime.ts:91`、`deploy/compose/docker-compose.yml:33` |
| MinIO/S3   | 已有真实 signed PUT adapter                                          | 默认 local，compose 仅 MinIO server/volume/health，没有创建 app-files bucket 的 init service。见 `apps/web/lib/storage.ts:30`、`deploy/compose/docker-compose.yml:58`                                                                                                                                                                         |
| ClickHouse | compose 容器、volume、健康检查和 CLICKHOUSE_URL 示例                 | 仓库业务源码未发现 ClickHouse client/schema/写入或查询调用；audit/telemetry 实际仍写 PostgreSQL。见 `deploy/compose/docker-compose.yml:76`、`.env.example:50`、`apps/web/lib/repository.ts:202`、`:229`                                                                                                                                       |

Redis/Kafka/S3 的 Web infrastructure health 都只是 TCP connect，不能证明认证、bucket 权限、Kafka metadata/topic、Redis命令成功。ClickHouse 不参与该 Web health。见 `apps/web/lib/infrastructure.ts:45`、`:56`、`:69`、`:79`。

compose 包含 PostgreSQL、Redis AOF、Kafka、MinIO、ClickHouse 五个 named volumes 及 worker，没有 Web service；数据服务端口发布到宿主机，默认账号为开发配置。见 `deploy/compose/docker-compose.yml:1`、`:19`、`:94`、`:131`。这套 compose 是本地依赖基线，不能据此宣称生产 HA、鉴权/TLS、卷备份或离线镜像交付完备。

生产校验只在 NODE_ENV/APP_ENV=production 生效；要求 DATABASE_URL、非占位 SERVICE_TOKEN；按 driver 进一步要求 REDIS_URL、S3 配置、KAFKA_BROKERS。它不强制生产用 s3/redis/kafka，也不校验 DB 默认密码、plain 管理员、TLS、bucket 存在或对象存储 secret 强度。见 `apps/web/lib/production-config.ts:1`、`:27`。

## 测试证据与未覆盖项

| 测试/门禁               | 仓库已有断言                                                          | 不能由此推出                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| migration:check         | SQL/journal/snapshot/hash/局部 DDL 规则；本次实际运行通过             | 真库升级、schema 语义一致、旧版本数据兼容、恢复可用                                                                                 |
| db:integration          | public 11 表 + admin 存在及 hash 非空                                 | 全 13 表完整结构、RBAC 权限正确、CRUD、迁移账本、事务回滚。见 `apps/web/scripts/db-integration.mjs:15`                              |
| Web unit/integration    | setup 默认删除 DATABASE_URL、强制 memory/local、隔离临时上传目录      | 大多数 test:integration 也不等于 PostgreSQL 集成。见 `apps/web/tests/setup-env.mjs:5`                                               |
| product/admin tests     | 断言无 DATABASE_URL 必须报错                                          | repository 真库持久化/事务行为。见 `apps/web/tests/unit/product-service.test.mjs:5`、`apps/web/tests/unit/admin-service.test.mjs:5` |
| upload memory tests     | helper 对超限 File size/Content-Length 抛 413                         | multipart 流式限制、缺 Content-Length、并发内存、S3 PUT 或回滚。见 `apps/web/tests/unit/security.test.mjs:83`                       |
| production config tests | missing/placeholder token、所选 driver 缺依赖配置、CLI 非零退出       | 数据库/Redis/S3/Kafka 真正可用。见 `apps/web/tests/unit/production-config.test.mjs:36`                                              |
| health integration      | status/service/time、configured/missing 与基础设施状态字段            | DB 查询、读写能力。见 `apps/web/tests/integration/health-service.test.mjs:5`                                                        |
| worker tests            | envelope、offset、retry、幂等调用顺序、readiness 等 helper/store stub | PostgreSQL 并发锁、失败窗口、真实 Kafka/存储恢复。见 `services/worker/tests/worker.test.mjs:163`、`:190`、`:236`                    |
| E2E smoke               | 起 Next dev，health 后登录、me、users/RBAC数组、outbox数组、未知路由  | 上传、S3、Redis限流、备份恢复、consumer。见 `apps/web/scripts/e2e.mjs:31`、`apps/web/scripts/smoke.mjs:53`                          |
| CI                      | 提供 PostgreSQL 17，先 db:migrate 再 verify                           | CI 无 Redis/Kafka/MinIO/ClickHouse services，无 backup restore 演练。见 `.github/workflows/verify.yml:12`、`:35`                    |

源码检索未找到直接覆盖 `s3-client`、`storage.ts` 实际对象读写、cleanup TTL/危险 root、db-backup create/verify/restore 的专门测试。现有 smoke 也没有上传请求。不能用总测试通过代替这些路径的证据。

## 对 pstack-x 改造的取舍建议

可作为结构参考的是 PostgreSQL 单一事实来源、Drizzle schema/SQL/journal、用户角色关联事务、统一 repository、schema/hash 门禁、明确的 upload adapter、独立运维备份命令和安全的测试环境隔离。

采用前应明确哪些基础设施真有业务需求。仅为复制模板，不应默认引入没有读写消费者的 ClickHouse、默认消耗 outbox 的 dry-run worker 或只提供 TCP 状态的就绪保证。

若改造包含真实文件和持久数据，优先补齐这几项：业务写入与 outbox 同一数据库事务；对象与元数据失败补偿及可重试清理；文件 provider/bucket/checksum 与生命周期；备份包含迁移账本并读取实测应用版本；verify 必须有 checksum；恢复先验证且具备原子/回滚与停写策略；在隔离 PostgreSQL/MinIO 中证明上传、升级、恢复和故障重试。报告中列出的缺口是源码边界，不是本次已经修复的功能。
