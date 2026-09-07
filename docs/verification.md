# 初始改造交付与验证

本记录是初始改造的历史验证，不代表后续生产评估问题全部关闭。最新修复状态见 [生产评估修复](production-repair-plan.md)。

2026-09-07，pstack-x 已完成本次应用模板改造。本记录描述本地改造验收结果；Git 发布以仓库提交历史为准，未部署到已有环境。两个参考仓库未修改。

## 已交付能力

| 范围 | 当前实现 |
| --- | --- |
| Monorepo | 根工程及 web、contracts、database、server、worker 六个 workspace |
| 管理端 | 原 9 个页面，用户、角色、权限、文件、审计与 outbox |
| HTTP | 原 15 个业务操作及 hello；Zod 派生 OpenAPI；输入和输出均校验 |
| 身份 | scrypt、数据库会话、Cookie/Bearer、active 角色授权、事务内撤权复核、最后管理员保护 |
| 数据 | 原实体能力、安全迁移基线、历史保留与显式旧库升级、完整性和约束漂移检查 |
| 文件 | local/S3、实际字节上限、持久上传意图、存储位置绑定、失败补偿、引用保护 |
| 后台 | Kafka outbox、租约代次、原子幂等与回执、重试/重放、毒消息隔离、退出与强杀恢复 |
| 运维 | Compose 可选服务、备份恢复、配置检查、模板初始化、CI、项目技能和浏览器证据 |

## 实際执行结果

| 命令 | 结果与范围 |
| --- | --- |
| `pnpm verify` | 通过，11 项工具检查、38 项单元测试、21 项 PostgreSQL/Redis/MinIO/Kafka 集成测试、3 条浏览器流程 |
| 聚合内 `test:production` | 实际构建与启动，完成 API smoke，备份应用数据库、恢复至空库、再次迁移与登录成功 |
| `pnpm test:backup` | 单独备份负向验证通过；缺校验和、缺确认、非空目标均拒绝；并发同名对象冲突时回滚且保留原数据 |
| `pnpm test:containers` | 最终源码构建 Web/worker 镜像，镜像内迁移与初始化，真实 Web API、Kafka 发布消费与重复回执、SIGTERM 正常退出通过 |
| Compose 全 profile config | 通过；包含 Redis、Kafka、MinIO 初始化和 ClickHouse 可选配置 |
| 校验脚本中断 | SIGTERM 后本次容器、子进程和监听端口消失 |
| 项目技能校验 | runtime 与 browser 两个技能格式检查通过 |

最后的 CI 路由补充了生产启动与容器检查，并复跑 10 项运维工具测试。未运行远端 GitHub Actions；CI 配置使用上述本地已执行入口。

## 可复核证据

证据目录被 gitignore 排除，源脚本与测试可重新执行。

- 聚合输出：`.verification/template-implementation/verify.log`。
- 最终浏览器：`.verification/pstack-x/run-i8pByv0z/`，包含 trace、截图、doctor 与源哈希。
- 聚合内生产恢复：`.verification/app/run-zVFio4/`。
- 最终容器：`.verification/containers/run-1LFDoD/summary.json` 及 Web/worker 日志。
- 备份负向验证：`.verification/template-implementation/backup.log`。
- 中断检查：`.verification/template-implementation/interrupt-review.txt`。
- 决策轨迹：`.verification/template-implementation/decisions.tsv`。
- 改造前快照：`.verification/template-implementation/before.tgz`。

独立 GPT-6 Astra 审查发现的授权时序、响应额外字段、数据库漂移、恢复竞态和包边界问题均已修复并验证。该审查为相同模型的独立实例，不构成跨模型验证。

## 能力边界

Effect 的设计思想用于依赖、事务、错误及资源职责；Effect 运行时仍是可选后续试点。当前主链不依赖其 RC 或 unstable 模块。

后台默认 handler 记录数据库回执，用于证明中间件链路。具体业务的外部副作用仍需接收方幂等设计和单独验收。ClickHouse 保留可选部署能力，没有捏造旧模板不存在的分析业务；其 profile 做了配置验证，未运行分析读写。

备份工具覆盖 PostgreSQL 和迁移账本，不包含对象文件或 Kafka 位点。应用恢复测试沿用本次测试的 local 文件目录，不是分布式一致备份证明。现有业务库、远端部署和现场环境未操作。
