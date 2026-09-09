# 改造前分析复核

日期为 2026-09-07。本次接手时，工作区已有完整分析、五份分项调查、四个架构候选及独立评审。复核保留这些材料，以实际源码和可重跑探针检查结论。两个参考仓库保持只读，未改造 pstack-x 应用代码。

## 当前基线与执行结果

| 检查                           | 本次结果                                                           | 证据范围                                                                                    |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 旧模板 HEAD                    | `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`，工作区干净             | 与已有报告一致                                                                              |
| Effect HEAD                    | `5a802043984727b0c5a291af39d1b9bbfa8d7b8b`，工作区干净             | 与已有报告一致                                                                              |
| 重建 inventory 并运行 cmp      | 与现存 inventory.json 逐字节一致                                   | 149 个文件、4 个 package、18 份 Markdown、9 页面、14 route 文件、15 业务操作、13 表、3 迁移 |
| migration-check.mjs            | 3 迁移、3 SQL hash、2 snapshot hash 通过                           | 静态检查，不连接数据库                                                                      |
| access-control-routes.test.mjs | 6/6 通过                                                           | 源码守卫，不证明真实授权正确                                                                |
| identity-probe.mjs             | 停用角色授权、错误 secret 撤销两项缺陷再次复现                     | 原函数体、仓储替身                                                                          |
| Effect 发布包探针              | 资源共享、dispose 释放、失败释放、HTTP 200/400 与 OpenAPI 生成通过 | 固定 rc.112 发布包、进程内 Request/Response                                                 |
| Zod 发布包探针                 | 字符串 false 被转成 true；登录 schema 可生成 JSON Schema           | 固定 Zod 4.4.3、原 schema 隔离执行                                                          |
| redis-probe.mjs                | 普通 INCR 成功；AUTH 和 SELECT 多响应被原客户端错误拒绝            | 原客户端、loopback TCP 响应替身                                                             |

重跑入口见 [探针说明](scripts/README.md)。Effect 发布包不是本地源码构建，版本相同不证明字节相同。

## 源码复核与修订

Effect Migrator 在 `packages/effect/src/unstable/sql/Migrator.ts:225` 使用 PostgreSQL 表锁，`:308` 用一个事务执行待应用迁移。它依迁移 ID 跳过历史项，不提供 Drizzle 的 schema diff 生成，也没有已应用迁移文件的 checksum 对照。保留 Drizzle 生成与迁移所有者的建议成立。

`packages/effect/src/unstable/sql/SqlClient.ts:253` 的事务实现覆盖嵌套 savepoint、失败和中断回滚。`packages/effect/src/unstable/workflow/DurableQueue.ts:10` 明确至少一次投递，并要求 handler 幂等。进程资源管理、数据库原子性与外部副作用幂等仍是不同责任。

新增 Redis 问题。旧模板 `apps/web/lib/redis-client.ts:42` 将 AUTH、SELECT 和业务命令拼接发送，`:35` 在收到第一段响应后就结束读取。`:7` 的整数解析器不跳过前面的 +OK。协议探针用正常响应复现了这项失败。实施验收需覆盖真实 Redis 的密码、数据库选择、分片响应和原子限流，不能只测无认证本机连接。

收窄 offset 风险。旧 `processAsyncConsumerMessage` 的 `commitOffset` 在业务 try 内，提交失败会调用 store.fail。默认 runner 把真实 Kafka 提交放在 helper 外，所以主报告现已明确注入 helper 的适用条件。

补充重试退出的两个分支。旧 `async-consumer.ts:543` 对未来重试时间等待后退出 batch；已到期或无等待时间则进入 `:638` 的 onRetryableFailure，拒绝等待结果并停止 consumer。当前没有自动重启 consumer 的 supervisor。实施阶段要分别验证等待后重投和停止后恢复。

## 采用决定与未验收项

仍推荐保留 vinext、Zod、Drizzle/PostgreSQL，先建立 contracts、database、server 和 worker 的依赖及事务边界。Effect 的 Layer、Scope、ManagedRuntime 作为后续 worker 试点。HttpApi、Effect SQL/Migrator、Workflow/Cluster 不作为首阶段默认依赖。

按 Foundational Thinking 原则，先建立共享类型、事务所有权与验证入口，再迁移页面和后台功能。按 Prove It Works 原则，分别标注静态检查、函数探针、协议替身和真实集成，不把前几类当作生产验收。

真实 PostgreSQL 迁移与恢复、Redis/Kafka/MinIO 集成、vinext 登录与管理页面兼容、生产构建制品和故障恢复尚未执行。ClickHouse 只对齐可选部署入口，不声称旧模板已有分析业务。实施阶段的完整退出条件见 [综合方案](template-effect-assessment.md)。
