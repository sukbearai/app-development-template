# 目录与代码约定

包职责和依赖方向见[架构说明](architecture.md)。业务代码在各包的 modules 目录组织，平台能力保留明确入口。业务名称不自动决定路由、权限、表名或事件。

## 业务和平台目录

| 位置                                                       | 职责与公开入口                         |
| ---------------------------------------------------------- | -------------------------------------- |
| packages/contracts/src/modules/&lt;domain&gt;/contracts.ts | Zod 契约及派生类型，浏览器可使用       |
| packages/database/src/modules/&lt;domain&gt;/repository.ts | SQL 与持久化，写入接收事务上下文       |
| packages/server/src/modules/&lt;domain&gt;/service.ts      | 业务操作、授权和事务                   |
| packages/server/src/modules/&lt;domain&gt;/router.ts       | tRPC 适配，仅由根 trpc-router 组装     |
| services/worker/src/modules/&lt;domain&gt;/handler.ts      | 有独立领域消费时创建，仅供 worker 使用 |
| apps/web/app                                               | 页面与显式 HTTP handler                |
| apps/web/components/&lt;domain&gt;                         | 业务组件                               |
| apps/web/components/ui                                     | 跨业务展示组件                         |
| apps/web/components/providers                              | React provider 和生命周期组件          |
| apps/web/components/admin                                  | 管理端 shell 与导航                    |
| apps/web/lib                                               | 通用请求、格式化和表单支持             |
| apps/web/lib/hooks                                         | use-* 通用 hooks                       |
| apps/web/lib/&lt;domain&gt;                                | 业务专用客户端能力                     |
| apps/web/stories/&lt;domain&gt;                            | Storybook 示例                         |

同一领域在不同包使用同名目录。没有实际职责就不创建空文件。identity 共同拥有用户、角色、会话和权限政策；auth、users、roles 外部路由键保持独立。

数据库表仍由 `packages/database/src/schema.ts` 定义。contracts 的 primitives 保存共享 schema，async-contracts 保存后台消息协议，transport 保存通用 HTTP 类型。业务模块不通过包根 index 汇总导入。

平台允许路径的权威在 `scripts/convention-policy.mjs`，没有迁移豁免。新增平台文件需要明确职责并更新规则；普通业务模块无需登记。

## 命名与引用

生产源码文件最多 600 行有效代码，不计空行和纯注释行。Oxlint `max-lines` 以 error 执行，超限会阻止提交与 CI。适用范围为 apps 的 app、components、lib、src，以及 packages 和 services 的 src；测试、工具、Storybook 与声明文件不使用这一行数限制，其余 lint 规则继续生效。暂不限制函数行数。超限按实际职责拆分，不通过压缩排版或增加转发层规避。

文件和目录使用 kebab-case。组件和类型使用 PascalCase，函数使用 camelCase，schema 使用 Schema 后缀。禁止新建 utils、common、helpers、manager 杂项目录或文件。业务模块不用 index barrel，普通生产源码使用具名导出；App Router 保留文件按框架要求导出。

同模块可以调用私有实现。模块外只能引用该包对应的公共职责文件，不能通过相对路径、别名、类型引用或再导出访问私有实现。公共入口直接实现行为，不转发私有文件的原始导出。测试可以直接验证本 workspace 的实现，不使其成为生产公共 API。

跨包使用 workspace 包名，Web 内继续使用 `@/`。浏览器只允许 server 的 AppRouter 类型导入，不能值导入 server、database 或 Node-only 依赖。现有 wildcard exports 保留；私有性由仓库源码检查保证，不是面向任意外部消费者的运行时封装。

业务模块不读取 process.env。配置在平台解析入口读取，默认值不复制到 UI。`packages/server/src/runtime-health-config.ts` 负责运行健康的动态环境解析，保留原读取时机和默认值。

## 授权、事务与平台能力

`packages/server/src/password.ts` 是身份操作、初始化与恢复共用的密码实现。`packages/server/src/event-service.ts` 负责可信服务端审计与 outbox 事实写入，保持传入 tx 和独立写入两种语义。业务事务必须传入同一 tx，事实写入不能直接注册为公开 procedure。

受保护审计查询依赖 identity/service，身份写入通过 event-service，不依赖审计查询服务。这一方向避免文件级循环。

上传准入、内存限制和指标保留平台职责。HTTP handler 先检查 Origin 和权限，再获取名额、有界读取、调用上传 service，最终释放名额。运行指标读取同一准入实例，不能把准入推迟到已读取 File 的存储函数内。

## 测试发现

| 路径                                            | 执行方式                                     |
| ----------------------------------------------- | -------------------------------------------- |
| tests/unit/**/*.test.mjs                        | 原 workspace test:unit 自动递归发现          |
| tests/integration/**/*.test.mjs                 | 原 workspace test:integration 使用原资源环境 |
| packages/server/tests/web-runtime/**/*.test.mjs | server integration 第二组，使用 Web tsconfig |
| tests/fixtures                                  | 支持文件，不放可执行 _.test._                |

发现器稳定排序，通过参数数组运行测试。未分类测试、错误扩展名、符号链接和已声明空套件均失败。独立类型检查、collector、Storybook、E2E 与工具测试继续使用原入口。worker integration 仍创建和清理自己的 PostgreSQL/Kafka，external 入口需显式选择。

查看套件、文件和运行参数：

```sh
pnpm --filter @pstack/server test:unit --list
pnpm --filter @pstack/server test:integration --list
pnpm --filter @pstack/worker test:integration --list
```

目录检查不能证明测试没有外部资源依赖，也不能推导权限和事务语义。

## 检查入口

```sh
pnpm conventions:check
pnpm boundary:check
pnpm dependency:check
```

conventions:check 复用源码范围与边界解析，检查落点、公共入口、环境读取和测试归属。boundary 检查运行时安全，dependency 检查缺失引用与循环。新检查进入暂存快照、CI 工程分支和完整验证计划，不借 lint 隐式执行。

操作步骤见[业务开发步骤](module-development.md)。
