# Effect v4 核心与 HTTP 对应用模板的适用性

建议先把 Effect 用在服务端应用服务、依赖构建、资源释放和测试中，保留现有认证业务与 Web 框架入口。HttpApi 能减少模板目前的契约重复，但它要求以 Effect Schema 为契约来源，且仍在 `unstable` 路径。不要把全量 Zod/HTTP 迁移作为模板第一步。

本次只读源码和测试，未安装依赖、未启动服务、未执行测试或构建。测试文件的存在是上游覆盖证据，不代表已在本机通过，更不代表 Next/vinext 集成通过。

## 核验范围

- Effect `/Users/fayon/workspace/github/effect`，HEAD `5a802043984727b0c5a291af39d1b9bbfa8d7b8b`，`packages/effect/package.json:4` 为 `4.0.0-rc.112`。调查开始时工作区干净。
- 模板 `/Users/fayon/workspace/github/app-development-template`，HEAD `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。调查开始时工作区干净。
- 已先读 Effect `.agents/AGENTS.md`、`LLMS.md`、`ai-docs/src/04_integration/10_managed-runtime.ts`、HTTP 入门/测试、日志、Effect 测试示例，再核对真实源码。模板也读取了 `AGENTS.md`。
- 下文 `effect/...` 和 `template/...` 分别以上述两个仓库为根；`pstack-x/...` 为当前工作区。行号指本次读取版本。

## 决策矩阵

“直接采用”指选定 Effect 后可直接使用的机制，不表示本次已引入，也不表示建议马上替换全部模板实现。

| 范围 | 决策 | 对模板的具体处理 | 证据 |
| --- | --- | --- | --- |
| session、密码、RBAC、资源归属 | 保留 | 保留业务规则、存储和审计；可改成 Effect service，但不能用 `HttpApiSecurity` 代替 | `template/apps/web/lib/auth-service.ts:18`、`:55`、`:67`、`:194`、`:203`、`:208`；`effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:526` |
| Cookie 写入同源检查 | 保留 | API 与页面授权仍是两个入口；Cookie 写操作继续执行同源检查 | `template/apps/web/lib/api-authz.ts:17`；`template/apps/web/lib/request-auth.ts:27` |
| `Effect<A,E,R>`、命名错误、服务接口 | 直接采用 | 在新服务模块显式声明成功、预期错误和依赖；边界映射 HTTP，业务不依赖 `NextResponse` | `effect/packages/effect/src/Effect.ts:117`；`effect/LLMS.md:137` |
| `Context.Service`、Layer、Scope | 直接采用 | 基础设施由 Layer 构建与释放，测试替换实现，不在每个 handler 创建连接池 | `effect/packages/effect/src/Context.ts:201`；`effect/packages/effect/src/Layer.ts:54`、`:1014`；`effect/packages/effect/src/Scope.ts:382` |
| ManagedRuntime 集成 | 直接采用 | 首先保留 Next/vinext route，服务端共享一个有明确生命周期的 runtime，入口调用 `runPromise`/`runPromiseExit` | `effect/packages/effect/src/ManagedRuntime.ts:98`、`:185`、`:196`、`:285` |
| 契约单一来源 | 借鉴 | 消除现有 Zod 与手写 OpenAPI schema 的重复维护；采用哪种 schema 前先确定 HTTP 迁移范围 | `template/packages/shared/src/index.ts:8`、`:230`；`effect/packages/effect/src/unstable/httpapi/OpenApi.ts:283` |
| Effect Schema 与 Standard Schema | 直接采用，限新契约 | 已采用 Effect Schema 的新模块可导出 Standard Schema；现有 Zod 先保持单一权威 | `effect/packages/effect/src/Schema.ts:1326` |
| HttpApi + typed client + OpenAPI | 暂缓全量迁移 | 先用一个真实业务小组证明协议、错误包裹、认证和部署，再决定是否成为模板默认方案 | `effect/packages/effect/package.json:40`；`effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:63` |
| Config/ConfigProvider | 借鉴，Effect 模块直接采用 | 统一解析与依赖配置，但保留 production、驱动条件和弱口令规则；显式区分服务端和公开配置 | `effect/packages/effect/src/Config.ts:877`、`:1315`、`:1487`；`template/apps/web/lib/production-config.ts:27` |
| 日志与 tracing | 借鉴，Effect 模块直接采用 | 用日志上下文贯穿调用，保持 traceId 和敏感字段规则；勿将格式化 logger 当成自动隐私过滤器 | `effect/packages/effect/src/Logger.ts:594`、`:965`、`:1027`；`template/apps/web/lib/logger.ts:6`、`:28`、`:57` |
| 测试 | 保留并扩展 | 现有 `tsx --test`、集成与浏览器测试保留；新增 Effect 服务用测试 Layer/TestClock；只有采用 HttpApi 后才引入 HttpApiTest | `template/packages/shared/package.json:11`；`effect/ai-docs/src/09_testing/10_effect-tests.ts:30`；`effect/packages/effect/src/unstable/httpapi/HttpApiTest.ts:42` |

## 当前 v4 API 的准确含义

`Effect.Effect<A, E = never, R = never>` 的三个类型参数分别表示成功值、预期失败、运行前必须提供的服务。`E` 不是所有 JavaScript 异常的穷举；未建模异常和中断仍需由运行边界按 Exit/Cause 处理。不要把第三个参数理解成返回上下文，也不要在领域代码中反复 `runPromise`。源码声明在 `effect/packages/effect/src/Effect.ts:117`，Promise 边界在 `:8985`，`ManagedRuntime.runPromiseExit` 保留 Exit 在 `effect/packages/effect/src/ManagedRuntime.ts:196`。

这个版本的名字是 **`Context.Service`**。`LLMS.md` 的默认服务写法与源码一致；`Context.Service<Service, Shape>()("app/Service")` 表示带标识的可注入服务。没有在本版本 `src/index.ts`/`Context.ts` 找到 `ServiceMap` 导出。不要照早期 v4 样例写 `ServiceMap.Service`，也不要混入 v3 的 `Context.Tag`/`Effect.Service`。迁移注释 `effect/migration/annotations/effect__Effect.yaml:407` 明确将服务定义替换到 `Context.Service`。

`Layer<ROut,E,RIn>` 表示提供的服务、构建失败和构建所需服务，见 `effect/packages/effect/src/Layer.ts:54`。`Layer.provide` 注入依赖；需要让依赖继续可见时使用 `Layer.provideMerge`，见 `:1431`、`:1549`。业务服务实现可用 `Layer.effect`，内部通过 `Effect.acquireRelease`/finalizer 管理资源。`Scope` 是资源生命周期，关闭时执行 finalizer；它不能保证进程被强杀后完成业务补偿，见 `effect/packages/effect/src/Scope.ts:52`、`:382`。

`ManagedRuntime.make` 接收没有剩余构建依赖的 Layer，缓存构建结果并拥有 scope。源码 `effect/packages/effect/src/ManagedRuntime.ts:285`、`:311`；上游测试证明同一个 runtime 重复执行只构建一次、共享 MemoMap、dispose 中断 fibers，见 `effect/packages/effect/test/ManagedRuntime.test.ts:6`、`:27`、`:65`。模板接入时应在服务端组合根创建 runtime，并明确开发热更新、进程停止、测试结束时谁调用 `dispose`。不能把它当作无生命周期的全局变量。

## Schema、Zod 和契约

模板 `packages/shared/src/index.ts:8` 起定义 Zod schema，但 `:230` 起又手写 `openApiSchemas`。`apps/web/scripts/api-contracts.mjs:3` 另外维护路径、方法和响应状态。当前模式有契约检查，但并非完全由运行时 schema 自动生成 OpenAPI。迁移价值主要在减少这些重复事实，而非把 schema 的名称换掉。

`Schema.toStandardSchemaV1` 返回符合验证协议的对象，保留输入/输出类型，并支持同步或异步验证，见 `effect/packages/effect/src/Schema.ts:1326` 和 `effect/packages/effect/test/schema/toStandardSchemaV1.test.ts:117`、`:135`。这可供接受 Standard Schema 的表单或其他库消费。它不是 Zod 与 Effect AST 的双向转换。当前查阅的 `Schema*.ts` 未找到 `fromStandardSchemaV1` 或 Zod 导入桥；HttpApi endpoint 的编解码类型直接基于 `Schema.Constraint`/`Schema.Top`，见 `effect/packages/effect/src/unstable/httpapi/HttpApiEndpoint.ts:81`、`:102`、`:142`。不能把现有 `ZodSchema` 直接传进去并假定自动获得全部 OpenAPI 元数据、转换和错误行为。

还需区分 Standard Schema 验证协议与 Standard JSON Schema。`Schema.toStandardJSONSchemaV1` 在源码中明确标为 experimental，见 `effect/packages/effect/src/Schema.ts:1336`。如采用 Effect 新契约，应单独验证 encoded/type 的差异、默认值、字符串数值转换、日期、错误路径和 JSON Schema 输出，不能靠结构相似来保证迁移等价。

建议保留现有 Zod 权威，Effect 服务边界可通过 `Effect.tryPromise` 等包装现有函数，但要把既有 `ApiError` 映射为明确错误类型。后续若选定 HttpApi，则逐个完整业务组迁移 schema、handler、client 和 OpenAPI，同时删除该组的旧定义，避免长期双写。

## HTTP、security 和框架接入

当前实现链为 `HttpApi/HttpApiGroup/HttpApiEndpoint` 定义契约，`HttpApiBuilder.group` 实现 handler，`HttpApiBuilder.layer` 注册到 `HttpRouter`，`OpenApi.fromApi` 生成 OpenAPI 3.1.0，`HttpApiClient.make` 构建运行时 typed client。依据 `effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:63`、`:126`，`OpenApi.ts:283`、`:305`，以及 `effect/ai-docs/src/51_http-server/10_basics.ts:85` 起的客户端例子。typed client 不等于已经生成可独立运行的零依赖 SDK。

`HttpApiSecurity` 声明 bearer/basic/apiKey 安全方案，`securityDecode` 从 header/cookie/query 提取凭据。其错误类型是 `never`，缺失或格式不匹配可返回空凭据，见 `effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:526`、`:539`、`:558`。必须由业务 middleware 判断是否接受。上游授权示例只是校验固定 `dev-token` 并注入固定用户，见 `effect/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24`。它没有提供可直接交付的账号系统。

模板的 session secret hash、有效期、撤销、用户启用状态、角色权限、对象归属、审计都应保留，源码 `template/apps/web/lib/auth-service.ts:18`、`:55`、`:88`、`:194`、`:203`、`:208`。Cookie/bearer 优先级、同源写检查和页面权限也不能从 OpenAPI security 自动推导。`securitySetCookie` 只负责设置 cookie，默认 secure/httpOnly，SameSite、有效期、部署策略仍需应用传入，见 `effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:592`。

Next/vinext 有两条接入路径：

1. 优先保留框架 route，调用 `ManagedRuntime.runPromise` 或 `runPromiseExit`。现有模板 `template/apps/web/app/api/admin/users/route.ts:20` 中的同源检查、权限、校验和响应包裹可逐步移到服务与边界适配层。调用时可透传 `request.signal`；`Effect.RunOptions` 定义见 `effect/packages/effect/src/Effect.ts:8768`。外部 SDK 是否实际取消，还取决于它是否接收 signal。
2. 采用 HttpApi 后，通过 `HttpRouter.toWebHandler` 获得 `{ handler, dispose }`，用框架 route 转发 `Request` 并返回 `Response`，见 `effect/packages/effect/src/unstable/http/HttpRouter.ts:1300`、`:1340`。无需在 Next/vinext 中额外启动 `NodeHttpServer`。注意 route 的第二个参数是框架 params 上下文，Effect handler 的第二个参数是 `Context`，不要无条件把两个函数签名当作相同；显式一层转发更清楚。

`HttpRouter.toWebHandler` 创建时就构建 Layer，异步构建未完成时请求等待，失败后请求继续拒绝；这与 ManagedRuntime 的首次构建时机不同，见 `effect/packages/effect/src/unstable/http/HttpRouter.ts:1289`。`HttpEffect.toWebHandlerWith` 将 request.signal 的 abort 转为 fiber 中断，见 `effect/packages/effect/src/unstable/http/HttpEffect.ts:304`。流式响应会转移请求 scope 到流消费生命周期，见 `:298`；相关上游测试在 `effect/packages/effect/test/unstable/http/HttpEffect.test.ts:113`、`:138`。这些证明桥接层的设计，不证明 vinext 部署的断连行为。

有一个容易误用的 middleware 细节：`HttpRouter.toWebHandler` options 中的 middleware 包住发送响应的整条链，修改响应不会影响最终发送结果。需要更改响应时用 `HttpRouter.middleware`，源码注释明确说明于 `effect/packages/effect/src/unstable/http/HttpRouter.ts:1323`。trace header、cookie 和 CORS 不能随意挂错层。

当前 pstack-x 只有 `app/api/hello/route.ts:1` 的 Web Response 示例和 `package.json:10` 的 vinext `1.0.0-beta.9`。从 Request/Response 类型契合可判断接入方向可行，但未验证 Next/vinext 的路由前缀、RSC、build、HMR、多 cookie、HEAD、stream abort、启动失败与资源释放。现在不能写成“已兼容”。

## Config、日志与测试

`Config.schema` 可以用 Effect Schema 定义配置，`ConfigProvider` 可注入环境记录或对象，适合测试无需修改全局 process.env。`Config.Boolean` 明确解析 true/false、yes/no、1/0 等，`Config.Redacted` 返回 Redacted 值，见 `effect/packages/effect/src/Config.ts:877`、`:1281`、`:1487`。可借鉴这个明确解析边界，替代模板 `env.ts:23` 的泛用 boolean coercion，但此次未执行行为验证，不把该点单独列为确认缺陷。

`ConfigProvider.fromEnv` 默认合并 process.env 和 import.meta.env，见 `effect/packages/effect/src/ConfigProvider.ts:926`。这不是“服务端秘密与客户端公开配置自动隔离”的机制。服务端配置模块仍须只在服务器引用，客户端只导入明确允许的公开字段。模板 `production-config.ts:27` 的数据库必需、驱动依赖、强 secret 检查仍属应用规则，不会因引入 Config 自动出现。

日志可使用 `Logger.layer([Logger.consoleJson])`、`Effect.annotateLogs`、`Effect.withLogSpan` 和 `Effect.fn("name")`。例子见 `effect/ai-docs/src/08_observability/10_logging.ts:11`、`:60`，实现见 `effect/packages/effect/src/Logger.ts:594`、`:965`。模板已有递归敏感字段过滤和 access log，见 `template/apps/web/lib/logger.ts:6`、`:28`、`:57`。迁移时必须复用敏感字段策略，并单独处理自由文本错误消息与堆栈。Redacted 只保护包装进去的值，不会识别任意普通字符串中的 token。traceId 响应协议也需显式保留，见 `template/apps/web/lib/api-response.ts:25`、`:43`。

测试建议采用最小分层：

- 现有认证、配置、日志、共享契约测试继续保留。模板已有 `apps/web/tests/unit/security.test.mjs`、`production-config.test.mjs`、`logger.test.mjs` 及浏览器登录 setup。
- Effect 服务用测试 Layer 注入仓储和时钟，验证预期错误、资源关闭、时间推进。上游 `@effect/vitest` 的 `it.effect` 自带 Scope，见 `effect/packages/vitest/src/index.ts:190`；TestClock 示例见 `effect/ai-docs/src/09_testing/10_effect-tests.ts:30`。
- 如果采用 HttpApi，`HttpApiTest.groups` 运行同一请求编码、路由、响应编码、客户端解码，不开 HTTP 端口，见 `effect/packages/effect/src/unstable/httpapi/HttpApiTest.ts:1`、`:42`。可验证缺凭据/无权限/输入错误/业务错误/成功，但不覆盖浏览器 Cookie、反向代理、真实数据库和运行容器。
- 最后一层仍须实际 Next/vinext route、真实登录与 Cookie 写入、跨站拒绝、流取消和构建后的 bundle 检查。必须分别记录源码契约证据、内存 HTTP 证据和真实框架证据。

不能直接照旧项目安装 Vitest 版本：`effect/packages/vitest/package.json:3` 同为 rc.112，`:52` 的 peer 要求 Vitest `>=5.0.0 <6.0.0`。模板目前是 `tsx --test`；只为少量 Effect 包引入单独测试入口比整体换测试框架更可控。

## 版本与 bundle 风险

Effect 核心版本仍为 rc；HTTP/httpapi 是显式 unstable 导出，见 `effect/packages/effect/package.json:4`、`:40`、`:41`。应固定精确版本，并让 `effect`、`@effect/platform-*`、`@effect/vitest` 使用相容版本，不能照混合 v3/v4 文档拼装 API。pstack-x 的 vinext 本身也是 beta，两个预发布组件的适配应有明确回退入口。

Effect 包声明 `sideEffects: []`，见 `effect/packages/effect/package.json:28`，具备 tree shaking 意图，但不是体积结论。本次没有构建或 bundle 数值。把 HttpApi runtime client 放进浏览器会引入 Effect、Schema、HTTP client 的实际依赖；只共享 TypeScript `import type` 与共享运行时 schema 的成本不同。

契约应放在独立且无服务器依赖的包，服务器实现、数据库、config、Node platform 放在 server-only 模块。上游在 `effect/ai-docs/src/51_http-server/10_basics.ts:13` 明确要求契约和服务器实现分离，授权实现也单独放在 `fixtures/server/Authorization.ts:14`。不能在 shared barrel 中重新导出 server Layer，再依赖 tree shaking 保密。可先让浏览器继续使用普通 fetch/现有客户端，仅在服务端使用 Effect；若后续采用 typed runtime client，再以实际构建的 client/server 依赖图与压缩体积判断是否值得。

## 建议的第一项验证

选一个已有、权限清晰、无长任务的 API 作为试点，保留 URL、成功/失败 envelope 和认证规则，先改为 Context.Service + Layer + ManagedRuntime。用该 API 验证构建只发生一次、缺配置失败、预期错误映射、取消与 dispose；然后再做独立 HttpApi 版本对照契约和浏览器 bundle。只有这些证据成立后，才决定让 HttpApi/Effect Schema 成为模板默认项。
