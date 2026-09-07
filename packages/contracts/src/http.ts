import { z } from "zod";
import {
  changePasswordRequestSchema, resetUserPasswordRequestSchema, changePasswordResponseSchema, resetUserPasswordResponseSchema,
  nonEmptyStringSchema, jsonRecordSchema, loginRequestSchema, loginResponseSchema,
  createUserRequestSchema, updateUserRequestSchema, createRoleRequestSchema,
  updateRoleRequestSchema, telemetryRequestSchema, telemetryEventSchema,
  userSchema, roleSchema, permissionSchema, healthStatusSchema, auditEventSchema,
  outboxEventSchema, asyncRuntimeHealthSchema, fileAssetSchema,
} from "./schemas.ts";

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ traceId: nonEmptyStringSchema, data, meta: jsonRecordSchema.optional() });
}

export const apiFailureSchema = z.object({
  traceId: nonEmptyStringSchema,
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    details: jsonRecordSchema.optional(),
  }),
});

export const currentUserResponseSchema = loginResponseSchema.omit({ token: true });
export const userDirectorySchema = z.object({
  users: z.array(userSchema), roles: z.array(roleSchema), permissions: z.array(permissionSchema),
});
export const logoutResponseSchema = z.object({ ok: z.literal(true) });
export const helloResponseSchema = z.object({ message: z.literal("Hello from vinext") });
export const uploadRequestSchema = z.object({ file: z.file() });

const statusDescriptions: Record<number, string> = {
  200: "操作成功", 201: "资源创建成功", 400: "请求参数无效", 401: "未认证或凭据无效",
  403: "权限不足或来源无效", 404: "资源不存在", 409: "资源冲突", 413: "请求体超过限制",
  415: "不支持的媒体类型", 429: "请求过于频繁", 500: "服务器内部错误", 503: "依赖不可用",
};

export interface HttpResponseContract {
  name: string;
  schema: z.ZodType;
  description: string;
}
export interface HttpOperationContract {
  operationId: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  routeFile: string;
  tag: string;
  summary: string;
  authenticated?: boolean;
  request?: { name: string; schema: z.ZodType; contentType: "application/json" | "multipart/form-data" };
  responses: Record<number, HttpResponseContract>;
}

function response(name: string, schema: z.ZodType, status = 200): HttpResponseContract {
  return { name, schema, description: statusDescriptions[status] ?? `HTTP ${status}` };
}
function failures(...statuses: number[]): Record<number, HttpResponseContract> {
  return Object.fromEntries(statuses.map((status) => [status, response("ApiFailure", apiFailureSchema, status)]));
}
function json(name: string, schema: z.ZodType) {
  return { name, schema, contentType: "application/json" as const };
}

export const apiOperations = [
  {
    operationId: "postApiAuthPassword", method: "POST", path: "/api/auth/password",
    routeFile: "app/api/auth/password/route.ts", tag: "Auth", summary: "验证当前密码并修改密码，撤销所有会话",
    authenticated: true, request: json("ChangePasswordRequest", changePasswordRequestSchema),
    responses: { 200: response("ChangePasswordSuccess", apiSuccessSchema(changePasswordResponseSchema)), ...failures(400, 401, 403, 409, 413, 415, 429, 500, 503) },
  },
  {
    operationId: "postApiAdminUsersIdPassword", method: "POST", path: "/api/admin/users/{id}/password",
    routeFile: "app/api/admin/users/[id]/password/route.ts", tag: "Admin", summary: "管理员重置其他用户密码并撤销其所有会话",
    authenticated: true, request: json("ResetUserPasswordRequest", resetUserPasswordRequestSchema),
    responses: { 200: response("ResetUserPasswordSuccess", apiSuccessSchema(resetUserPasswordResponseSchema)), ...failures(400, 401, 403, 404, 409, 413, 415, 500, 503) },
  },
  {
    operationId: "postApiAuthLogin", method: "POST", path: "/api/auth/login",
    routeFile: "app/api/auth/login/route.ts", tag: "Auth", summary: "账号密码登录",
    request: json("LoginRequest", loginRequestSchema),
    responses: { 200: response("LoginSuccess", apiSuccessSchema(loginResponseSchema), 200), ...failures(415, 400, 401, 403, 413, 429, 500, 503) },
  },
  {
    operationId: "getApiAuthMe", method: "GET", path: "/api/auth/me",
    routeFile: "app/api/auth/me/route.ts", tag: "Auth", summary: "获取当前用户、角色和权限",
    authenticated: true,
    responses: { 200: response("CurrentUserSuccess", apiSuccessSchema(currentUserResponseSchema), 200), ...failures(401, 500, 503) },
  },
  {
    operationId: "postApiAuthLogout", method: "POST", path: "/api/auth/logout",
    routeFile: "app/api/auth/logout/route.ts", tag: "Auth", summary: "退出登录并失效当前会话",
    authenticated: true,
    responses: { 200: response("LogoutSuccess", apiSuccessSchema(logoutResponseSchema), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "getApiSystemHealth", method: "GET", path: "/api/system/health",
    routeFile: "app/api/system/health/route.ts", tag: "System", summary: "查询应用健康状态",
    responses: { 200: response("HealthSuccess", apiSuccessSchema(healthStatusSchema), 200), ...failures(500), 503: response("HealthSuccess", apiSuccessSchema(healthStatusSchema), 503) },
  },
  {
    operationId: "getApiAdminUsers", method: "GET", path: "/api/admin/users",
    routeFile: "app/api/admin/users/route.ts", tag: "Admin", summary: "查询用户、角色和权限",
    authenticated: true,
    responses: { 200: response("UserDirectorySuccess", apiSuccessSchema(userDirectorySchema), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "postApiAdminUsers", method: "POST", path: "/api/admin/users",
    routeFile: "app/api/admin/users/route.ts", tag: "Admin", summary: "创建用户",
    authenticated: true,
    request: json("CreateUserRequest", createUserRequestSchema),
    responses: { 201: response("UserSuccess", apiSuccessSchema(userSchema), 201), ...failures(415, 400, 401, 403, 409, 413, 500, 503) },
  },
  {
    operationId: "patchApiAdminUsersId", method: "PATCH", path: "/api/admin/users/{id}",
    routeFile: "app/api/admin/users/[id]/route.ts", tag: "Admin", summary: "更新用户",
    authenticated: true,
    request: json("UpdateUserRequest", updateUserRequestSchema),
    responses: { 200: response("UserSuccess", apiSuccessSchema(userSchema), 200), ...failures(415, 400, 401, 403, 404, 409, 413, 500, 503) },
  },
  {
    operationId: "getApiAdminRoles", method: "GET", path: "/api/admin/roles",
    routeFile: "app/api/admin/roles/route.ts", tag: "Admin", summary: "查询角色",
    authenticated: true,
    responses: { 200: response("RoleListSuccess", apiSuccessSchema(z.array(roleSchema)), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "postApiAdminRoles", method: "POST", path: "/api/admin/roles",
    routeFile: "app/api/admin/roles/route.ts", tag: "Admin", summary: "创建角色",
    authenticated: true,
    request: json("CreateRoleRequest", createRoleRequestSchema),
    responses: { 201: response("RoleSuccess", apiSuccessSchema(roleSchema), 201), ...failures(415, 400, 401, 403, 409, 413, 500, 503) },
  },
  {
    operationId: "patchApiAdminRolesId", method: "PATCH", path: "/api/admin/roles/{id}",
    routeFile: "app/api/admin/roles/[id]/route.ts", tag: "Admin", summary: "更新角色",
    authenticated: true,
    request: json("UpdateRoleRequest", updateRoleRequestSchema),
    responses: { 200: response("RoleSuccess", apiSuccessSchema(roleSchema), 200), ...failures(415, 400, 401, 403, 404, 409, 413, 500, 503) },
  },
  {
    operationId: "getApiAdminAuditLogs", method: "GET", path: "/api/admin/audit-logs",
    routeFile: "app/api/admin/audit-logs/route.ts", tag: "Admin", summary: "查询审计日志",
    authenticated: true,
    responses: { 200: response("AuditListSuccess", apiSuccessSchema(z.array(auditEventSchema)), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "getApiAdminOutboxEvents", method: "GET", path: "/api/admin/outbox-events",
    routeFile: "app/api/admin/outbox-events/route.ts", tag: "Admin", summary: "查询 outbox 事件",
    authenticated: true,
    responses: { 200: response("OutboxListSuccess", apiSuccessSchema(z.array(outboxEventSchema)), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "getApiAdminAsyncRuntimeHealth", method: "GET", path: "/api/admin/async-runtime-health",
    routeFile: "app/api/admin/async-runtime-health/route.ts", tag: "Admin", summary: "查询异步运行时计划和任务积压",
    authenticated: true,
    responses: { 200: response("AsyncRuntimeHealthSuccess", apiSuccessSchema(asyncRuntimeHealthSchema), 200), ...failures(401, 403, 500, 503) },
  },
  {
    operationId: "postApiUploads", method: "POST", path: "/api/uploads",
    routeFile: "app/api/uploads/route.ts", tag: "Files", summary: "上传文件并记录审计和 outbox",
    authenticated: true,
    request: { name: "UploadRequest", schema: uploadRequestSchema, contentType: "multipart/form-data" },
    responses: { 200: response("FileSuccess", apiSuccessSchema(fileAssetSchema), 200), ...failures(415, 400, 401, 403, 413, 415, 500, 503) },
  },
  {
    operationId: "postApiTelemetry", method: "POST", path: "/api/telemetry",
    routeFile: "app/api/telemetry/route.ts", tag: "Observability", summary: "写入前端埋点事件",
    request: json("TelemetryRequest", telemetryRequestSchema),
    responses: { 201: response("TelemetrySuccess", apiSuccessSchema(telemetryEventSchema), 201), ...failures(415, 400, 403, 413, 429, 500, 503) },
  },
  {
    operationId: "getApiHello", method: "GET", path: "/api/hello",
    routeFile: "app/api/hello/route.ts", tag: "System", summary: "验证 vinext HTTP 路由",
    responses: { 200: response("HelloResponse", helloResponseSchema, 200) },
  },
] as const satisfies readonly HttpOperationContract[];

export type ApiOperationId = typeof apiOperations[number]["operationId"];

export function apiOperation(operationId: ApiOperationId): HttpOperationContract {
  const operation = apiOperations.find((entry) => entry.operationId === operationId);
  if (!operation) throw new Error(`Unknown API operation: ${operationId}`);
  return operation;
}

export function parseApiResponse(operationId: ApiOperationId, status: number, body: unknown): unknown {
  const contract = apiOperation(operationId).responses[status];
  if (!contract) throw new Error(`Undeclared HTTP status ${status} for ${operationId}`);
  return contract.schema.parse(body);
}

export function findApiOperation(method: string, pathname: string) {
  const segments = pathname.replace(/\/$/, "").split("/");
  return apiOperations.find((operation) => {
    if (operation.method !== method.toUpperCase()) return false;
    const expected = operation.path.split("/");
    return expected.length === segments.length && expected.every((part, index) =>
      part.startsWith("{") ? Boolean(segments[index]) : part === segments[index]);
  });
}
