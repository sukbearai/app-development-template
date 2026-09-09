export { apiOperations as apiRoutes } from "@pstack/contracts/http";
export { buildOpenApiDocument } from "@pstack/contracts/openapi";

import { apiOperations } from "@pstack/contracts/http";

export function buildApiMarkdown() {
  return `# HTTP API\n\n本文只记录对外 REST 接口。应用内部的认证和管理操作通过 /api/trpc 调用，不进入 OpenAPI 或 REST SDK。\n\n本文和 openapi.json 由 packages/contracts/src/http.ts 登记的操作与 Zod schema 生成。执行 pnpm api:docs 更新。\n\n除 /api/hello 返回 message 外，响应包含 traceId 和 data；失败响应包含 traceId 和 error。健康检查的 503 仍返回 data，描述具体依赖状态。\n\n/api/system/metrics 仅接受独立 METRICS_TOKEN Bearer 凭据，不接受用户会话或 Cookie。其他受保护接口接受 Bearer 会话令牌或 HttpOnly Cookie。Cookie 写请求校验同源 Origin。业务授权以服务端有效权限为准。\n\n| 方法 | 路径 | 说明 | 响应状态 |\n| --- | --- | --- | --- |\n${apiOperations.map((route) => `| \`${route.method}\` | \`${route.path}\` | ${route.summary} | ${Object.keys(route.responses).join(", ")} |`).join("\n")}\n\n上传使用 multipart/form-data 的 file 字段，大小由 UPLOAD_MAX_BYTES 限制。每进程并发由 UPLOAD_MAX_CONCURRENT 限制，超限返回 503 UPLOAD_BUSY 和 Retry-After。匿名埋点可能返回 429。默认值只在请求解析时应用，输出契约仍要求完整数据。\n`;
}
