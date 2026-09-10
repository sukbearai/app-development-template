# 约定优于配置设计方案

本方案让开发者按固定位置添加业务代码和测试，沿用统一请求与配置策略。现有包继续负责运行时隔离，业务模块只改变包内组织。

状态为设计评审稿 v2。当前代码基线为 `85c15839e9accdea3c66bb5044ba413c849f6b85`。本文代码块中的目标路径和新增命令尚未实施。设计评分不代表实现、集成或上线验证通过。

## 设计依据与范围

[项目规则](../AGENTS.md)已经定义包职责、服务授权、事务、HTTP 契约和迁移要求。[质量门禁](quality-gates.md)已经检查源码覆盖、运行时边界、循环和缺失依赖。[客户端开发](client-development.md)已有 tRPC 推导、请求策略和表单约定。

缺口在于包内业务归属、组件与请求库的位置、公共入口和测试发现。当前 server 的 39 个 TS 文件有 36 个位于 src 根目录。database 的 repository.ts 汇集多项业务，共 722 行。行数说明当前形态，不作为强制拆分阈值。

本次交付设计与评审记录。未来实施保持外部 URL、tRPC key、权限标识、数据库表名、默认值和测试语义。SDK、Kafka 包、部署脚本与迁移历史沿用现有专用布局。

## 开发者如何增加一个业务

以假设的 projects 业务为例，开发者先定义行为、权限和验收，再按需要添加文件。

```text
packages/contracts/src/modules/projects/contracts.ts
packages/database/src/modules/projects/repository.ts
packages/server/src/modules/projects/service.ts
packages/server/src/modules/projects/router.ts
apps/web/app/admin/projects/page.tsx
apps/web/components/projects/project-form.tsx
packages/server/tests/unit/projects.test.mjs
packages/server/tests/integration/projects.test.mjs
```

没有数据库操作就不创建 repository，没有页面就不创建组件，没有异步消费就不创建 handler。单个模块不要求覆盖全部包，也不要求存在全部职责文件。

内部业务通过 tRPC 接入。模块 router 在根 appRouter 静态注册一次。浏览器从 AppRouter 推导输入、输出和 query key，不再创建业务 URL 配置或另一份接口类型。

```ts
// 目标 router 中，保留真实权限选择和服务层复核。
import {
  createProjectRequestSchema,
  projectSchema,
} from "@pstack/contracts/modules/projects/contracts";
import { createProject } from "./service";
// 既有 procedure.input(...).output(...).mutation(...)
// 把 input、ctx.token、ctx.traceId 传给 createProject。
```

```ts
// trpc-router.ts 静态挂入，AppRouter 的推导方式保持不变。
import { projectsRouter } from "./modules/projects/router";
// appRouter = trpc.router({ ...现有键, projects: projectsRouter });
// export type AppRouter = typeof appRouter;
```

```ts
// 浏览器在组件中沿用现有 useTRPC 和 TanStack Query。
const trpc = useTRPC();
const create = useMutation(trpc.projects.create.mutationOptions());
```

只有真实外部消费者需要 HTTP 时，才增加显式 handler、HTTP operation，并执行现有 OpenAPI 与 SDK 生成命令。目录名称不自动授予权限、不自动暴露路由、不生成表名或 Kafka topic。

## 采用包内业务聚合

比较两个结构方向后，采用各包内的 modules 目录。它让业务私有辅助代码有确定归属，也让检查器区分业务代码和平台基础设施，不靠持续扩充文件名前缀。

| 方向                                         | 收益                                       | 代价与取舍                                               |
| -------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| 保留职责平铺，用 projects-service 等后缀关联 | 迁移较少，贴近当前布局                     | 多文件业务仍散落在技术目录，私有辅助文件缺少稳定归属     |
| 现有包内按业务聚合                           | 同业务文件相邻，公共与私有入口可按结构检查 | 需要一次导入路径迁移，路径较长                           |
| 每业务创建全栈 package                       | 同业务集中                                 | 打破既有浏览器与 Node 边界，引入新打包和依赖策略，不采用 |

采用第二种方向，但保留数据库中央 schema 和现有通配 exports。第一版不同时重写数据库定义入口或包发布策略。

```text
packages/contracts/src/
  modules/<domain>/contracts.ts    该业务 Zod schema 与派生类型
  primitives.ts                   已有共用基础 schema 的唯一归属
  http.ts                         外部 HTTP operation 权威
  index.ts                        现有平台公共入口，不汇总新增业务
packages/database/src/
  modules/<domain>/repository.ts   业务 SQL 与行映射
  schema.ts                       保留完整表定义，唯一 Drizzle 入口
  client.ts                       pool、事务和上下文
packages/server/src/
  modules/<domain>/service.ts      业务授权、事务及操作
  modules/<domain>/router.ts       tRPC 传输适配
  modules/<domain>/<subject>.ts    确有必要的私有辅助实现
  trpc.ts                         procedure 与传输上下文
  trpc-router.ts                  静态组装与 AppRouter 类型
  env.ts / env-schema.ts           已有配置解析边界
apps/web/
  app/                            vinext 页面与 HTTP handler
  components/<domain>/            业务组件
  components/ui/                  跨业务展示组件
  components/providers/           React provider
  components/admin/              管理端 shell、导航等组合组件
  lib/                            通用请求能力
  lib/hooks/                      通用 hooks
  lib/<domain>/                   确实存在的业务客户端逻辑
  stories/<domain>/               Storybook，复用现有发现机制
services/worker/src/
  modules/<domain>/handler.ts      仅实际业务消费行为
  ...现有调度、恢复与进程生命周期
```

modules 不创建运行时抽象。没有 Module 接口、自动装载器、依赖注入容器或 CRUD DSL。service 仍直接调用 repository，一次业务操作的授权与事务集中在原有职责层。

identity 包含身份认证、用户、角色和会话。这些行为共同使用身份锁和权限约束，首批按一个领域迁移。文件可以继续拆分为私有辅助实现，不强迫一个 service 无限增长。外部 auth、users、roles 三个 tRPC key 保持不变，router.ts 可具名导出三个 router。

身份依赖方向固定为根 trpc-router 导入 identity/router，identity/router 导入 trpc 与 identity/service，trpc 的权限 procedure 只导入 identity/service。identity/service 不导入 router 或 trpc，保留 sessionActor、permissionsForUser、身份锁和权限函数的共同所有权。它依赖 database/identity 与现有平台 event-service、password。event-service 依赖 database 的 audit/outbox 仓储，绝不导入 identity 或受保护查询 service。audit/service 可以导入 identity/service 执行查询授权。通过依赖图与权限行为测试验证，不为拆目录公开这些私有函数。recordAudit 与 createOutboxEvent 留在现有 event-service，保留可选 tx 的现有语义；业务事务内调用必须传入同一个 tx，独立事实写入可沿用现有自建事务行为。

```text
trpc-router -> identity/router -> trpc -> identity/service
                            \-> identity/service
audit/service -> identity/service -> event-service -> database/audit + database/outbox
identity/service -> password + database/identity
bootstrap-admin + recover-admin -> password + database/identity + event-service
```

图中 database/audit 与 database/outbox 指对应 repository 公共入口。event-service 自身不做用户查询授权，只承担已有可信服务端事实写入，不能被直接注册成公开 procedure。保留它是因为其职责已经完整，不是兼容转发。

## 固定命名、公共入口与复用边界

1. 文件和目录采用 kebab-case。领域名使用业务词，例如 identity、uploads、telemetry、projects，不机械强制所有名称单数或复数。跨包同一领域使用同名目录，已有领域优先复用。
2. 标准职责文件为 contracts.ts、repository.ts、service.ts、router.ts、handler.ts。只创建实际需要的文件。其余辅助文件按知识命名，不新增 utils、common、helpers 或 manager 作为杂项容器。
3. 函数用 camelCase 动词名称，类型和 React 组件用 PascalCase。schema 用 Schema 后缀，输入沿用 createProjectRequestSchema，类型从 schema 推导。迁移不改外部字段和操作名。
4. 普通源码使用具名导出。App Router 的保留文件和构建配置按框架要求使用默认导出。该检查只覆盖生产源码，不把故事文件和第三方代码当作普通模块。
5. 同模块可以相对导入私有辅助文件。模块外只导入下表公共职责文件，不能通过相对路径、别名或再导出绕过。
6. 模块内禁止导入本模块的公共汇总入口再回到自身，避免循环。不给每个模块加 index.ts 或转发 facade。
7. 通用 UI 只负责展示与交互，不读业务服务。第二个真实业务需要同一能力时才考虑提取，提取前检查语义是否相同。服务或 repository 不因为只有一个调用者而自动删除，保留其实际权限或持久化职责。

| 提供方        | 模块外允许入口                       | 使用限制                                              |
| ------------- | ------------------------------------ | ----------------------------------------------------- |
| contracts     | modules/&lt;domain&gt;/contracts.ts  | 浏览器安全，包含 Zod schema 和派生类型                |
| database      | modules/&lt;domain&gt;/repository.ts | 仅既有 Node 允许层，写操作沿用显式 TransactionContext |
| server        | modules/&lt;domain&gt;/service.ts    | 仅既有 Node 允许层，调用不得绕过服务授权              |
| server router | modules/&lt;domain&gt;/router.ts     | 仅 server 的根 trpc-router.ts 组装                    |
| worker        | modules/&lt;domain&gt;/handler.ts    | 仅 worker 调度与处理映射使用，不暴露给 Web            |

平台根目录已有入口继续按现有包方向使用。浏览器从 server 导入 AppRouter 的 type-only 特例保留，其他 server 值导入继续拒绝。现有 Web 服务端对 database 的允许关系不在本方案中重定义；业务写入仍通过应用 service。

以下平台能力是长期合法入口，不属于业务私有文件，也不放进迁移例外。

| 平台入口             | 实际调用方                               | 维持的行为                                             |
| -------------------- | ---------------------------------------- | ------------------------------------------------------ |
| password             | identity、bootstrap-admin、recover-admin | 密码散列与校验的唯一实现                               |
| event-service        | 现有服务和管理员操作                     | 审计与 outbox 同事务写入，已有无 tx 调用语义保留       |
| upload-admission     | Web 上传 handler、runtime-metrics        | 读取请求前获取名额，finally 释放，指标读取同一计数实例 |
| upload-memory-limits | Web 上传 handler、uploads/service        | 限制 body 读取字节、文件与内存大小                     |
| runtime-metrics      | 现有监控入口                             | 聚合请求、数据库和上传计数                             |

上传调用顺序保持为 handler 的 Origin/写权限检查、withUploadAdmission、Content-Length 检查、有界读取 multipart、文件大小检查、uploads/service 持久化，最后释放名额。不得把准入推迟到已经拿到 File 的存储函数中。监控继续直接读取平台 admission 快照，不通过业务查询或复制状态。

现有 package exports 通配符可以解析多级路径，已用 Node 的 import.meta.resolve 验证存在目标文件。本方案保留通配映射，模块私有性由源码检查保证。它不是面对任意外部消费者的运行时封装；当前这些包是仓库内部 private workspace。

根目录平台文件采用检查器中的固定路径规则，与业务模块规则分开。实施前逐个分类现有根文件，记录其职责；新基础设施入口需要修改规则和评审。新增普通业务不用添加例外或注册清单。迁移期旧业务路径清单与长期合法平台规则必须分开，结束时删除前者。

## 默认行为与显式业务决定

| 事项                             | 默认来源                 | 开发者仍需决定                   |
| -------------------------------- | ------------------------ | -------------------------------- |
| 内部请求类型、options、query key | tRPC 与 contracts        | 实际操作和缓存失效时机           |
| 输入默认值和约束                 | 现有 Zod schema          | 新业务合法边界，不复制到 UI 常量 |
| 超时、重试、错误提示             | 现有客户端请求策略       | 确有业务需要的覆盖               |
| 环境配置                         | 各现有运行时配置解析入口 | 外部地址、凭据与部署容量         |
| 测试文件选择                     | 所在目录与扩展名         | 测试依赖的执行环境               |
| 路由与处理器                     | 静态 import 和登记       | 权限、公开范围、顺序和事件语义   |

保持 server、database、Kafka、worker 各自合法的配置所有权，不建立新的全局配置中心。本轮不变更默认值、环境变量加载顺序或 .env.example 的内容。业务模块不新增 process.env 读取；确需新环境配置时，在原有入口定义并测试，再传入业务能力。

本方案减少的是每个业务的路径配置、测试文件列表、重复请求类型和分散默认值。显式 router 注册、HTTP operation 和真实表定义拥有不同语义，继续分别维护，不合并为一份大型模块描述文件。

## 测试按环境发现，保留资源生命周期

目标套件目录如下。不存在某类任务的 workspace 不创建对应空目录；一旦脚本声明执行某套件，其发现结果为零就失败。

```text
<workspace>/tests/unit/**/*.test.mjs
<workspace>/tests/integration/**/*.test.mjs
packages/server/tests/web-runtime/**/*.test.mjs
<workspace>/tests/fixtures/
```

发现器递归收集并排序文件，用 spawn 的参数数组交给现有 runner，不依赖 shell 的双星号展开。--list 输出实际选择的套件、文件、loader 与 tsconfig。tests 下未分类的 _.test._、重叠归属和错误扩展名失败。fixtures 不得藏有可执行测试。

| 执行环境                                                  | 目标机制                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| contracts、database、server、Kafka、worker、SDK、Web unit | 各 workspace 保持既有 test:unit 命令，调用共享发现器              |
| server integration                                        | 按 integration 与 web-runtime 两组顺序执行，后者保留 Web tsconfig |
| database integration                                      | 保持既有资源获取方式，仅改变文件发现                              |
| worker integration                                        | 原专用脚本创建并销毁 PostgreSQL/Kafka，环境就绪后执行发现结果     |
| worker integration:external                               | 仍是显式外部环境入口，不作为默认验证替代                          |
| E2E、UI、production、Storybook、collector                 | 保留原独立命令、目录和资源所有权，不交给普通发现器                |
| scripts/tests 与 tools/anti-slop                          | 保留现有专用工具测试任务                                          |

迁移前枚举每条现有测试命令实际执行的文件、runner 参数和资源启动入口。建立旧路径到新路径的映射，要求每个旧测试恰好保留在对应执行环境。专用 test:auth-production 这类子集命令允许再次选择已有测试，但不能成为它唯一的默认覆盖入口。collector 和独立 .mjs 验证脚本不因不带 .test 而被误报为遗漏。

目录只能决定执行环境，不能静态证明一个测试不访问外部资源。unit 的外部资源约束通过实际执行与评审验证。新增失败断言必须被原 test:unit 命令发现并导致失败，再修正为通过。报告测试集合，不能只比较测试总数。

## 用现有工具执行约定

新增 conventions:check，读取现有 sourceRoots，不维护第二份生产根目录清单。业务根从文件系统推导，不要求每个模块填写 manifest。检查规则固定在工具代码内，不创建可配置规则 DSL。

| 检查                           | 负责人                                 | 必须失败的反例                             |
| ------------------------------ | -------------------------------------- | ------------------------------------------ |
| 业务落点、命名、平台根文件分类 | 新约定检查器                           | 新业务 service 平铺到根目录，未分类根文件  |
| 公共职责入口与私有引用         | 在现有边界解析结果上扩展               | 相对路径、别名、再导出访问另一模块私有文件 |
| 浏览器传递依赖和包方向         | 现有 boundary:check                    | 客户端经共享模块引入 server 或数据库       |
| 循环、缺失导入                 | 现有 dependency:check                  | 模块互相导入形成运行时循环                 |
| 测试归属、遗漏与空套件         | 共享发现器，约定检查调用同一逻辑       | 测试放错目录、声明的套件为空               |
| HTTP/OpenAPI、类型、迁移       | 现有 contract/typecheck/migration 检查 | 合同漂移、类型无效、迁移历史改变           |

不复制一套 import 解析器。先把边界检查器已有的纯路径与语法解析能力提取为脚本内部共享函数，旧边界负例保持通过，再扩展模块入口判断。解析结果包含 type-only 边以检查私有 API，原运行时安全与循环检查继续按运行时边判定。

AST 正反例包含普通 import/export、逐项 type-only、export type、import type equals、ImportTypeNode 的 import("...").Type、require 和字面量动态 import。路径用相对路径、workspace 子路径、tsconfig 别名分别验证。私有引用检查覆盖生产模块及其传递引用；单元测试可直接测试本 workspace 实现，不因此把私有文件公开给其他生产模块。测试发现规则仍覆盖完整 tests 目录。

工具接口草图如下，实际仍采用现有 mjs 工具链。

```ts
type Suite = "unit" | "integration" | "web-runtime";
type Finding = { file: string; rule: string; message: string };
declare function discoverTests(workspace: string, suite: Suite): Promise<readonly string[]>;
declare function checkConventions(root: string): Promise<readonly Finding[]>;
```

检查器只报告文件、规则和修正方向，不自动搬迁、生成权限或修改注册表。conventions:check 同时接入 CORE_GATES、GATE_SCHEDULING 的 phase 0、CI engineering 分支和原生暂存快照 hook。hook 的必需文件检查与测试夹具同步更新，原 lint、duplication、dependency 三项继续执行。不要把新检查藏进 lint 的副作用。

约定检查必须在暂存快照执行，不能读原工作区规则。检查部分暂存、删除、文件名空格以及缺少工具文件时的行为。报告如归档，映射回暂存内容并保持每次运行独立。

## 存量迁移映射

实施分批进行，每批完成全部调用者迁移并移除旧 API。共享基础设施不为目录对称搬迁。

| 当前职责                                   | 目标归属                                  | 保留事项                                              |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------- |
| auth-service、auth/users/roles router      | server modules/identity                   | 身份锁、权限、会话与三组外部 router key               |
| 用户分页、角色、session SQL 与 schema 契约 | database/contracts modules/identity       | SQL 行为和认证数据模型                                |
| product-service 的文件、上传意图与协调     | server/database/contracts modules/uploads | 对象存储适配保留在平台，租约和恢复策略不变            |
| product-service 的遥测写入与列表           | modules/telemetry                         | 同事务 outbox 和现有 HTTP 接口                        |
| audit 查询、查询契约与持久化               | modules/audit                             | 事实写入仍通过平台 event-service，事务内传入同一个 tx |
| outbox 查询及投递状态 SQL                  | modules/outbox                            | worker 认领与生命周期仍归 worker                      |
| adminSummary、运行健康及聚合 SQL           | modules/runtime                           | 聚合监控不是业务模块之间的反向依赖                    |
| retention 与数据库历史维护                 | database 平台维护入口                     | 运维批处理边界与 dry-run                              |
| request clients、策略、通用 hooks          | web lib 与 lib/hooks                      | use client 指令和实际运行边界                         |
| query provider、业务表单、通用展示         | providers、对应业务、ui                   | admin shell 留 components/admin                       |

先从现有函数的 import/call graph 生成迁移清单，表中按职责映射而不是按旧文件整块搬运。一个旧文件涉及多个目标时逐批移走函数。已有剩余函数可暂留原文件，但禁止加转发以保留已迁走的入口。

admin-directory-service 拆为 identity 的用户分页和 audit 的审计分页。event-service 保留 recordAudit 与 createOutboxEvent 的事实写入职责和原有 tx 语义；audit/outbox 模块的 service 仅负责需要业务授权的查询与应用操作。不得为了目录统一把事实写入函数汇出到受保护查询 service。根 router 内联的 audit、outbox、runtime 全部移到对应模块 router，根只负责静态组装。

平台根目录保留配置、transport、观测和资源管理文件。server 包括 api-response、api-security、bootstrap-admin、config-values、deployment-config、env-schema、env、health-service、http-metrics、infrastructure、logger、metrics-auth、production-config、rate-limit、recover-admin、redis-client、request-auth、s3-client、storage、tracing-provider、tracing、trpc-handler、trpc-metrics、trpc、trpc-router、validation 和 index。password、event-service、upload-admission、upload-memory-limits 与 runtime-metrics 保留为平台能力。password 同时服务管理员 bootstrap/recover 和 identity；上传 admission 与内存限制由 HTTP handler 和 runtime-metrics 共同调用，具有协议及资源控制职责。async-runtime-health-service 归 runtime。database 保留 client、environment、index、schema、schema-check、process-lifecycle、operational-metrics，admin-pages 按 identity/audit 拆分。contracts 的 admin-pages 按 identity/audit 实际定义拆分，outbox-health 与 runtime-metrics 保留为监控平台契约和纯计算能力，http/openapi/index 作为平台聚合入口。具体扩展名沿用现有文件。

worker 当前通用 async-runtime、outbox 投递、domain-handler 调度、恢复与进程文件保留平台布局。新的领域消费者才进入 modules。平台代码仍可导入公共 service 或 handler，模块不得导入其调度器形成反向循环。SDK 生成文件与 Kafka 连接配置不适用业务模块命名规则。

contracts 的共用基础 schema 移到 primitives，业务契约直接引用它；平台 HTTP registry 直接引用各业务权威 schema。新模块不反向依赖汇总 index，防止形成循环。旧 schemas.ts 中的剩余定义逐批归类，最后删除已空的聚合文件并移除旧业务根导出。

database/schema.ts 永久保留现有表定义，本轮没有 schema 定义搬迁或预期 SQL 变更。repository.ts 的 SQL 按对应职责迁走，最后删除混合文件。迁移 SQL、journal、hash 均不得因目录调整变化。

## 实施单元与验收

| 单元              | 交付与依赖                                                                   | 完成证据                                                          |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| U1 测试发现       | 先记录执行清单，迁移测试并保留所有 runner 环境                               | 旧新路径集合映射完整，新增失败测试被发现，空套件和未分类测试失败  |
| U2 规则与一个样本 | 依赖 U1，新增检查与精确旧路径清单，迁移 identity 完整调用链                  | typecheck、边界负例、暂存快照证据，身份业务真实数据库与浏览器保持 |
| U3 其余业务归属   | 依赖 U2，依次迁移 uploads、telemetry、audit、outbox、runtime 和相关 Web 代码 | 每批旧导出零引用，事务/上传恢复/页面行为对应验证通过              |
| U4 收敛与教程     | 依赖 U3，删除旧路径清单及兼容入口，文档用真实已迁移功能示范                  | 全量约定检查、测试集合无遗漏、pnpm verify 及适用生产构建验证通过  |

每批先记录当前行为，修改后执行 lint、duplication:check、dependency:check、boundary:check、typecheck、contract:check、migration:check 和受影响测试。不得刷新重复基线、增加宽泛忽略或绕过 hook 获得通过。新规则引起既有合法代码失败时，应修正规则边界并保留反例。

U2 至少验证登录、创建和更新用户、创建和更新角色、无权限拒绝、Cookie Origin、事务内失败时业务行与 audit/outbox 一起回滚。用既有隔离验证入口提供 PostgreSQL，页面通过 Chromium 驱动。不能仅调用内部函数代替 HTTP/浏览器路径。

管理员初始化和恢复继续验证空库初始化、已有账号凭据不符、legacy 凭据恢复、会话撤销及并发凭据变化拒绝。密码原语保持原平台入口和唯一实现，不为迁移新增转发 service。依赖负例包含 identity 与 audit 的文件级循环；合法正例包含平台事实写入和受保护审计查询分别调用。

U3 上传必须覆盖成功、失败意图与恢复；worker 路径变化须验证真实 PostgreSQL/Kafka 消费及关闭。服务符号移动不能改变业务操作拥有事务、worker 使用传入客户端的约束。

上传还须证明并发饱和时不读取 body、超出 Content-Length 限制时拒绝读取、有界读取超限或 multipart 解析失败时释放名额，指标反映同一个活动上传计数。这些是读取前资源保护的验收，不能由成功上传替代。

CI 分类测试证明源码、规则和测试发现器变更会执行新 gate。仅版本元数据变化和相同 Git tree 的有效复用按现有策略处理，不无故重跑全套检查。hook 用已暂存的新规则运行，未暂存修复不能让暂存违规通过。

路径变化分别检查 TypeScript、tsx、vinext 开发/构建、最终生产镜像中涉及的动态加载与子进程入口。Node 解析探针只是前置证据，不能替代这些验证。

完整交付要求旧业务路径引用为零、迁移例外为零、聚合文件已删除或仅保留命名明确的单一平台能力，新增业务不改测试清单或源码扫描范围。权限语义、领域名是否合理、共享是否必要仍需评审，不宣称静态脚本能够证明。

每个单元在独立提交中保持可验证状态。遇到失败先修复当前单元，不继续铺开迁移。纯源码迁移通过回退该单元提交恢复，数据库历史无需回滚；未通过实际验证不得描述为生产交付。

## 生成器和交付成本

第一版不增加业务生成器。四份独立候选均认为权限、数据模型和事务不能由业务名推导，空 service/router/repository 没有足够价值。现有 OpenAPI、SDK 和 Drizzle 继续生成有权威输入的机械结果。

后续至少完成两个真实新增业务，记录重复创建的文件和接线步骤，再判断是否需要小生成器。如果有，默认输出 diff，目标存在时整次拒绝，重复执行不覆盖业务。不能生成假权限、成功空壳或无断言测试。该生成器不属于本方案完成条件。

不承诺缺少实测依据的工期。U1 后能评估测试迁移成本，U2 后根据一个完整样本的 import 数量、改动文件和验证用时估算 U3。当前明确接受一次路径迁移成本，以减少后续每个业务的组织选择。

## 设计评审规则

固定五项评分为适配与正确性 25%、约定完整度 20%、开发体验与复杂度 20%、自动执行与验证 20%、迁移与交付 15%。四个 GPT-6 Astra 独立评审同一冻结版本，均严格大于 8.0 且无未解决阻断才通过。保留每轮原始评分和发现，修订内容后再评审，不用平均数掩盖单项评审不通过。

评审记录单独交付。当前没有实施证据，后续实施需要重新通过上述真实验证。
