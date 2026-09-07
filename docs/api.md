# HTTP API

本文和 openapi.json 由 packages/contracts/src/http.ts 登记的操作与 Zod schema 生成。执行 pnpm api:docs 更新。

除 /api/hello 返回 message 外，响应包含 traceId 和 data；失败响应包含 traceId 和 error。健康检查的 503 仍返回 data，描述具体依赖状态。

受保护接口接受 Bearer 会话令牌或 HttpOnly Cookie。Cookie 写请求校验同源 Origin。业务授权以服务端有效权限为准。

| 方法 | 路径 | 说明 | 响应状态 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | 账号密码登录 | 200, 400, 401, 403, 413, 415, 429, 500, 503 |
| `GET` | `/api/auth/me` | 获取当前用户、角色和权限 | 200, 401, 500, 503 |
| `POST` | `/api/auth/logout` | 退出登录并失效当前会话 | 200, 401, 403, 500, 503 |
| `GET` | `/api/system/health` | 查询应用健康状态 | 200, 500, 503 |
| `GET` | `/api/admin/users` | 查询用户、角色和权限 | 200, 401, 403, 500, 503 |
| `POST` | `/api/admin/users` | 创建用户 | 201, 400, 401, 403, 409, 413, 415, 500, 503 |
| `PATCH` | `/api/admin/users/{id}` | 更新用户 | 200, 400, 401, 403, 404, 409, 413, 415, 500, 503 |
| `GET` | `/api/admin/roles` | 查询角色 | 200, 401, 403, 500, 503 |
| `POST` | `/api/admin/roles` | 创建角色 | 201, 400, 401, 403, 409, 413, 415, 500, 503 |
| `PATCH` | `/api/admin/roles/{id}` | 更新角色 | 200, 400, 401, 403, 404, 409, 413, 415, 500, 503 |
| `GET` | `/api/admin/audit-logs` | 查询审计日志 | 200, 401, 403, 500, 503 |
| `GET` | `/api/admin/outbox-events` | 查询 outbox 事件 | 200, 401, 403, 500, 503 |
| `GET` | `/api/admin/async-runtime-health` | 查询异步运行时计划和任务积压 | 200, 401, 403, 500, 503 |
| `POST` | `/api/uploads` | 上传文件并记录审计和 outbox | 200, 400, 401, 403, 413, 415, 500, 503 |
| `POST` | `/api/telemetry` | 写入前端埋点事件 | 201, 400, 403, 413, 415, 429, 500, 503 |
| `GET` | `/api/hello` | 验证 vinext HTTP 路由 | 200 |

上传使用 multipart/form-data 的 file 字段，大小由 UPLOAD_MAX_BYTES 限制。匿名埋点和登录可能返回 429。默认值只在请求解析时应用，输出契约仍要求完整数据。
