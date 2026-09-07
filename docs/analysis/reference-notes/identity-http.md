# 参考模板：身份、权限、HTTP 与管理台

参考仓库 `/Users/fayon/workspace/github/app-development-template`，HEAD `bf9dcdddb75f5946499d2c8a742b0c258c34f1d4`。2026-09-07 只读调查，开始与结束 `git status --short` 均为空。下列代码路径均相对于参考仓库；这是迁移前能力与风险分析，不是生产验收结论。

## 实现范围与文档范围

实际提供一个 Next.js 16 / React 19 管理台、PostgreSQL 会话和 RBAC、15 个 HTTP 操作、Zod 输入合同和基本前端请求层。身份数据没有内存降级，数据库缺失直接报错。管理台可以创建用户/角色、切换状态、上传文件和浏览运维数据，尚不包含具体领域业务闭环。

`docs/mvp.md:15` 定义初始管理角色，`:21-29` 的创建业务对象、审核、后台执行、归档仍是要求替换的示例步骤；`:50-52` 明确当前是管理骨架。`docs/requirements.md:3-14` 也是待填写模板，不能据此认定业务需求已落实。`docs/technical-design.md:88` 将 Redis sessions 列为基础设施用途，但实际 session 在 PostgreSQL，不应误迁为已实现的 Redis session 架构。

| 能力 | 当前实现与证据 | 边界 |
| --- | --- | --- |
| 账号密码 | `apps/web/lib/auth-service.ts:67-100` 查询用户、验证启用状态及密码、写会话、记登录审计、返回个人角色权限 | 无注册、MFA、SSO/OIDC、密码找回、密码重置 API；新用户密码最少 8 个 trim 后字符，但种子管理员例外 |
| 密码存储 | `apps/web/lib/password.ts:7-20` 随机盐 16 bytes、scrypt 64-byte key、timingSafeEqual | 保留 `plain:` 明文兼容；没有自动升级旧 hash |
| Session | `auth-service.ts:18-64` 随机 24-byte id + 24-byte secret，token=`id.secret`，数据库只存 secret SHA-256；检验撤销、固定过期、密钥和用户 enabled | 每次使用 touch lastUsedAt，但不滑动续期；无会话列表、全端登出、过期行清理入口 |
| Cookie/Bearer | `request-auth.ts:18-25,42-64` 优先 Authorization，其次 Cookie；HttpOnly、SameSite=Lax、Path=/、可配置 Secure | Bearer 实际用相同 session token；没有独立服务身份认证。`SERVICE_TOKEN` 只在生产配置检查中出现，未接入这些 HTTP 路由 |
| RBAC | `auth-service.ts:50-53,194-205` 用户角色并集、页面/API 独立守卫、资源 owner helper | 无租户/组织/项目范围或 ABAC；inactive 角色没有被过滤；owner helper 当前仅测试调用，没有生产资源路由消费 |
| 数据模型 | `apps/web/db/schema.ts:3-48` users/roles/permissions/user_roles/role_permissions/user_sessions，账号唯一、关联外键和复合主键 | status 是 text、映射层强制断言 union；不是数据库 enum/check 约束 |
| 登录节流 | `rate-limit.ts:26-66` 内存固定窗及最大 5000 keys 清理；可选 Redis INCR/EXPIRE；成功删除计数 | 默认 20 次/60s；键为 account + 原样 X-Forwarded-For；无可信代理解析、全局/IP 合并限额；Redis INCR 与 EXPIRE 非原子 |
| CSRF | `api-security.ts:4-6` 与 `request-auth.ts:27-39` 对带 session Cookie 且无 Authorization 的写请求校验 Origin | 无 Cookie 的登录/telemetry 不检查 Origin；允许请求 URL origin 或 forwarded host/proto 组合，需要部署端明确可信代理边界 |
| 输入合同 | `packages/shared/src/index.ts:3-75,96-100` Zod schemas，`validation.ts:4-12` 输出 400 + issues | 无字段最大长度；PATCH 全 optional，空对象合法；未定义账号/角色 ID 字符规则、关系 ID 去重和存在性友好错误 |
| 响应与 trace | `api-response.ts:17-61` `{traceId,data,meta}` / `{traceId,error:{code,message,details}}`；优先请求 x-trace-id | 未知异常原文回给客户端并多数映射为 400；readJson 解析失败返回 `{}`；未强制验证输出 Zod schema |
| 日志审计 | `logger.ts:6-45,57-80` 结构化访问日志、按字段名递归脱敏；`auth-service.ts:89,145,159,175,190` 成功登录及管理写入审计 | 登录 trace 硬编码 `login`，与请求 trace 断开；失败认证/注销不写业务审计；业务写入与 audit 分属事务 |
| 客户端请求 | `components/api-client.ts:16-57` same-origin credentials、JSON/FormData、错误 message、解包 data | 泛型强制断言无 runtime schema 验证；丢失 trace/status/code/details，未统一处理 401 或响应超时 |
| React Query | `components/api-query.ts:26` 提供 useApiQuery、AbortSignal；`query-provider.tsx:6-19` QueryClient retry=1 | 当前管理页是服务端直读 + router.refresh，搜索未见 useApiQuery 生产调用，不能认定管理台已采用查询缓存架构 |

## 请求链路

1. 登录页面提交 `requestJson('/api/auth/login')`。路由分配 trace 并包访问日志，执行 origin 检查、Zod 解析、登录节流，再查 PostgreSQL 用户与密码。创建 session 后单独写 audit，读取当前角色和权限，成功清除限流键，返回 token 和 HttpOnly Cookie。证据：`app/api/auth/login/route.ts:10-23`、`auth-service.ts:67-100`、`components/admin/login-form.tsx:20-39`。
2. API 读通过 `requireApiPermission` 提取 token 后调用 requirePermission。后者查 session、校验 secret、更新 lastUsedAt、查询启用用户和角色并集。写 API 先经 origin 检查再相同 RBAC；之后 parseInput、调用服务及 repository、包装响应。证据：`api-authz.ts:9-19`、`auth-service.ts:55-65,194-200`。
3. `/admin` layout 读取 Cookie，未登录跳 `/login?next=/admin`，没有 admin.read 显示 PermissionNotice；每个页面仍先 requirePermission 才读服务数据。布局和页面可以各自重复读 session/角色，且 GET 页面访问也 touchSession 写库。证据：`app/admin/layout.tsx:11-40`、`app/admin/page.tsx:12-16`。
4. 管理写入通过客户端 API 后 router.refresh 重新取服务端数据。创建用户或角色的主行与关联表在 repository 事务里；audit 在事务提交后执行。证据：`repository.ts:116-176`、`auth-service.ts:130-190`。

## 页面完整清单

共 9 个页面文件，加根 layout 和 admin layout。管理页全部需要 admin.read。

| 路径 | 页面能力与证据 |
| --- | --- |
| `/` | `app/page.tsx:6-13,24-47` 模板名、管理端和 Health 链接；Session Active 只看 Cookie 存在、未验证有效性；Verification Ready 为固定文字 |
| `/login` | `app/login/page.tsx:11-35` 有效 session 跳 /admin；`login-form.tsx:9-13,26-34` 接受 next，提交登录后跳转 |
| `/admin` | `app/admin/page.tsx:12-31` 用户/审计/埋点/文件/outbox 汇总与图表；`:43-70` 基线说明 |
| `/admin/users` | `app/admin/users/page.tsx:9-25,42-54` 查全部用户/角色/权限、创建账号、切换状态；API 支持的 displayName/roleIds 修改没有编辑表单 |
| `/admin/roles` | `app/admin/roles/page.tsx:9-23,41-57` 创建角色、权限选择、切换 active/inactive；API 支持的名称/权限集合修改没有编辑表单 |
| `/admin/permissions` | `app/admin/permissions/page.tsx:8-15,28-39` 权限目录与使用角色，只读，新增权限走迁移 |
| `/admin/files` | `app/admin/files/page.tsx:10-25,42-49` 最近文件元数据和上传，上传额外要 file.upload；无下载、删除或对象详情 API |
| `/admin/audit` | `app/admin/audit/page.tsx:9-16,31-37` 最近 100 条动作/对象/操作者/trace/时间，无筛选分页 |
| `/admin/outbox` | `app/admin/outbox/page.tsx:16-24,39-46` 最近事件 topic/status/attempts/nextAttemptAt/trace，无 retry 操作，无 async-health 专页 |

`components/admin/admin-shell.tsx:28-35,43-59,88-117` 有统一顶栏、响应式侧栏、当前路由高亮和退出入口。所有菜单都绑定同一 admin.read，所谓权限感知菜单目前粒度较粗。files/audit/outbox repository 各取最近 100 条；users/roles 是全量查询，未分页，见 `repository.ts:68-113,215-216,264-265,298`。

## HTTP 完整清单

13 个显式 route.ts，15 个操作；另有 catch-all 对 GET/POST/PUT/PATCH/DELETE 回 ROUTE_NOT_FOUND。下表证据均在 `apps/web/app/api`。

| 操作 | 认证/校验与返回 | 证据 |
| --- | --- | --- |
| POST `/api/auth/login` | origin helper、LoginRequest、限流；200 token/session/user/roles/permissions + Cookie | `auth/login/route.ts:10-23` |
| GET `/api/auth/me` | session；200 当前会话、用户、个人角色权限 | `auth/me/route.ts:6-13` |
| POST `/api/auth/logout` | origin helper；200 `{ok:true}` + 清 Cookie；当前未验证 session secret | `auth/logout/route.ts:7-15` |
| GET `/api/system/health` | 公开；200/503 成功包中的 HealthStatus | `system/health/route.ts:5-10` |
| GET `/api/admin/users` | admin.read；users/roles/permissions 全目录 | `admin/users/route.ts:8-17` |
| POST `/api/admin/users` | origin + admin.write + CreateUserRequest；201 User | `admin/users/route.ts:20-30` |
| PATCH `/api/admin/users/{id}` | origin + admin.write + UpdateUserRequest；200 User | `admin/users/[id]/route.ts:8-19` |
| GET `/api/admin/roles` | admin.read；Role[] | `admin/roles/route.ts:8-17` |
| POST `/api/admin/roles` | origin + admin.write + CreateRoleRequest；201 Role | `admin/roles/route.ts:20-30` |
| PATCH `/api/admin/roles/{id}` | origin + admin.write + UpdateRoleRequest；200 Role | `admin/roles/[id]/route.ts:8-19` |
| GET `/api/admin/audit-logs` | admin.read；AuditEvent[] | `admin/audit-logs/route.ts:6-15` |
| GET `/api/admin/outbox-events` | admin.read；OutboxEvent[] | `admin/outbox-events/route.ts:6-15` |
| GET `/api/admin/async-runtime-health` | admin.read；runtime plan、topic backlog、task counts、alerts 的快照，状态 blocked/degraded 仍 HTTP 200 | `admin/async-runtime-health/route.ts:6-15` |
| POST `/api/uploads` | origin + file.upload；Content-Length 预检，formData 内存解析，再 File/size 校验；200 FileAsset | `uploads/route.ts:12-25` |
| POST `/api/telemetry` | 无身份要求；origin helper + TelemetryRequest；201 TelemetryEvent，同时 outbox | `telemetry/route.ts:8-18` |

没有用户/角色 DELETE、权限 CRUD、文件读写列表 API、账号自服务 API。`system.read` 虽在 `db/migrations/0001_core.sql:93-97` 种子权限中，公开 health 路由不校验该权限。

## 合同及门禁的准确能力

共享 Zod 提供 User/Role/Permission/AuthSession、Login/Create/Update 请求、Health、Audit/Telemetry/File/Outbox、AdminSummary 和异步任务/健康结构，类型由 `z.infer` 导出，见 `packages/shared/src/index.ts:523-550`。ApiSuccess/ApiFailure 是手写 interface，OpenAPI schemas 是同文件第二套手写对象，见 `:230-247,508-521`。这减少散落位置，但仍非从 Zod 自动生成 OpenAPI。

`scripts/api-contracts.mjs:3-18` 登记 15 个操作、路由文件、关键源码字符串、请求体及状态码；`:164-175,194-224` 生成 OpenAPI。`contract-check.mjs:45-70` 比对生成结果、全部显式 route 文件、文档表格、关键字符串及共享导出。它没有执行 HTTP，也没有检查每个导出的 HTTP method 与登记表一致，更不验证运行响应符合 schema。

合同缺口已经可见：

- 所有成功响应都引用 `{ data: {} }` 的 ApiSuccess，未将 LoginResponse/User/HealthStatus 等绑定到具体操作，见 `api-contracts.mjs:104-115` 与 shared `:231-235`。
- 503 走统一 BadRequest 引用，描述/结构为 ApiFailure，但 health 实际返回 ApiSuccess/HealthStatus；见 `api-contracts.mjs:144-150` 与 health route `:9`。
- 多数受保护 admin 操作缺 401，创建缺 409，PATCH 缺 404，login 缺 400/403/429。Cookie 只在 bearerAuth description 中解释，没有独立 cookie security scheme，见 `api-contracts.mjs:4-18,212-218`。
- Zod 的 trim/min/default 与 OpenAPI 手工元数据未完全一致，未来扩展还需语义级合同测试。

## 不应直接迁移的问题

1. **角色停用不撤权，已隔离复现。** `auth-service.ts:50-53` 只匹配 roleIds，未过滤 active；`:194-200` 直接依赖该集合，登录/me 也共用。UI `roles/page.tsx:46-57` 把 inactive 呈现为停用。停用后仍能 admin.write 与 file.upload。页面 canWrite/canUpload 重复相同缺陷，见 users `:14`、roles `:14`、files `:15`。应把有效角色求值集中在服务端并覆盖真实拒绝请求。
2. **logout 不验证密钥，已隔离复现。** `auth-service.ts:208-213` 从任意 `id.secret` 取 id 后撤销，`repository.ts:198-199` 只按 id 更新；知道公开 session id 的调用者不需要正确 secret 就能撤销。session id 本来作为公开 metadata 返回，见 `auth-service.ts:40-47`。session id 随机不可轻易猜出，但不应把其保密性当认证。隔离探针未模拟真实获取他人 session id，也未进行真实 API 利用。
3. **生产迁移默认建立已知管理员。** `0001_core.sql:108-117` 无环境条件插入 admin/admin 且授予管理角色；`password.ts:14` 接受 plain hash；`production-config.ts:27-54` 不检查数据库种子账号，也无密码变更 API。需要明确初始化凭据/强制轮换流程，不能把当前种子作为生产身份方案。
4. **失败响应泄漏内部消息、混淆服务端失败。** `api-response.ts:33-52` 未知错误原文返回且默认 400，包含数据库配置/查询错误时无生产脱敏；一般路由 catch 后 withAccessLog 只看到普通 response，以 info 记录，见 `logger.ts:60-70`。应区分业务失败与 5xx、服务器保留内部证据。
5. **管理表单 await 后读取 event.currentTarget。** `admin-actions.tsx:28-40,124-135,218-221` 在异步请求成功后才 `.reset()`；React 事件 currentTarget 在同步分发结束后清空，可能写入已成功而 UI 报错、未 refresh。这是源码及框架事件语义判断，本次未启动浏览器复现。迁移时先捕获 form 节点。
6. **登录 next 仅检查 startsWith('/')。** `login-form.tsx:9-13,33` 接受 `//external-host/...` 协议相对 URL。应使用同源 URL 解析/明确允许路径，补浏览器跳转验证。当前未运行 Next router 的真实外跳探针。
7. **登录限流与代理信任未成套。** login route `:16` 原样使用 X-Forwarded-For，攻击者可换 header 生成新桶，account 维度也允许分散请求。origin helper 信任 forwarded host，见 `request-auth.ts:32-37`。是否外部可绕过取决于代理是否覆盖这些 header，本次不声称已验证生产代理漏洞。Redis `rate-limit.ts:51-52` INCR/EXPIRE 中途故障可能留下无 TTL 桶。
8. **业务提交与审计/返回不原子。** `auth-service.ts:144-145,158-159,174-175,189-190` 主写入已提交后 audit 失败会向客户端返回失败；再次创建可能冲突，首次成功没有审计。登录 `:88-89` 同样会产生客户端拿不到的 session。涉及事务设计，不能仅加 catch 忽略审计。
9. **角色创建并发可能给已有角色追加权限。** service `:164-174` 先查存在再创建；repository `:153-155` 主行冲突被忽略后仍插入 permission 关联。两次并发同 ID 创建会使第二次添加到先胜出的角色，同时响应仍构造自己的 name/status。属于源码可推导竞态，本次未连接数据库复现。
10. **Cookie TTL 与 session TTL 分离。** `env.ts:8` 支持 SESSION_TTL_SECONDS，session 使用该值，`request-auth.ts:58` 却固定 Max-Age=86400。自定义 TTL 后会提前丢 Cookie 或长期保留失效 Cookie。
11. **匿名 telemetry 无速率/体积上限。** telemetry route `:12-14` 对无 Cookie 请求直接允许，JSON payload 任意 record；`product-service.ts:28-34` 每次写 telemetry + outbox。需要根据实际入口决定公开接收策略；当前不是授权过的业务写 API。
12. **无效 JSON PATCH 可得到成功。** `readJson` 捕获解析异常变 `{}`，update schemas 全 optional；更新服务仍写 updatedAt/审计并返回 200。存在明确输入语义缺口。见 `api-response.ts:56-61`、shared `:58-75`、repository `:134-146`。

另有使用边界：用户可停用自己或最后一个管理员，无恢复保护；停用用户不会 revoke 会话，因此再启用且未过期时旧会话恢复有效；无 admin.read 的有效用户进入 /admin 只见 PermissionNotice 且没有 shell logout 按钮，/login 又把其跳回 /admin。相关证据 `auth-service.ts:55-64,149-160`、`app/admin/layout.tsx:24-30`、`app/login/page.tsx:23`。这些需由目标产品明确规则，不能当成模板已解决。

## 测试证据与缺口

- 本次实际运行 `node --test tests/unit/access-control-routes.test.mjs`，6/6 通过。`:16-103` 全为 readFile + 正则/字符串，只证明各文件存在守卫引用、菜单与路由文字，不证明守卫执行顺序或真实拒绝效果。
- 本次实际运行 `identity-probe.mjs`，使用 Node 内置类型擦除执行原 auth-service 函数体，repo 仅为记录调用的替身。输出 `inactiveRoleGrantsAdminWrite=true`、`invalidSecretRevokeCalls=["known-session-id"]`。脚本、命令与 stdout 在相邻 `identity-probe-evidence.md`；这是源码函数隔离证明，不是真实 HTTP/数据库/浏览器验证。
- `security.test.mjs:9-106` 有 scrypt、内存限流、Cookie Secure 选择、上传大小、owner helper 单测；未见验证 verifyRequestOrigin 的运行测试，也未覆盖 session 有效/过期/撤销、角色 inactive、Redis 故障。
- `admin-service.test.mjs:6-13` 仅断言无 DATABASE_URL 时列表/创建失败，并非 CRUD 成功或事务一致性集成测试。`api-response.test.mjs:5-10` 仅断言 ApiError 属性。
- `packages/shared/tests/contracts.test.mjs:9-19` 仅测登录 trim/空账号与 telemetry 默认值。没有全部输入/输出 schema、OpenAPI 语义一致性测试。
- Playwright 现有 `admin-login.spec.ts:4-17`、`admin-overview.spec.ts:3-12`、`auth.setup.ts:5-15` 验证首页到登录再到概览与复用登录态。没有创建用户/角色/上传、撤权、登出、错误展示验收，不能把“admin UI flow”理解成完整管理 CRUD。
- `scripts/smoke.mjs:41-83` 测 health、登录、me、users、outbox、404；不覆盖角色写入、CSRF、限流或 owner。smoke 与 UI 本次未运行，因为会启动/访问真实服务并通过登录写数据库，超出只读范围。
- 未安装参考仓库依赖、未运行全套测试/build/contract-check；首次 TypeScript 模块探针因依赖未安装失败，之后改用 Node 内置能力成功，不隐瞒该差别。

## 向 pstack-x 迁移的取舍

可以复用设计原则和能力目录：页面/API 双边界、显式路由清单、shared schema 先解析、Cookie/Bearer 共用会话、服务端授权与菜单可见性分离、用户/角色关联事务、trace envelope、管理台组件分类和响应式布局、契约文档门禁。

需要重新适配目标框架：Next cookies/navigation/NextResponse/route params、服务端页面数据读取与 router.refresh。可将密码、session secret 验证、有效权限求值、origin 策略、输入 schema 与 HTTP 响应策略放到框架外，再接目标路由；当前代码因 import 链把 ApiError/NextResponse 与 auth 绑定，不能当完全独立包复制。

不要原样复制上述 12 项问题、明文管理员种子、手工泛型断言及弱响应合同。迁移应先明确有效角色、会话撤销、初始化管理员、代理来源和错误分类，保留最小业务操作，再用真实 API 401/403/过期/撤销、并发同 ID 创建、审计失败，以及三个管理表单成功刷新路径作验收。Effect 接入方式由父任务独立评估。
