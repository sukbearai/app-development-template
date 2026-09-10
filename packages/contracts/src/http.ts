import { uploadRequestSchema, fileAssetSchema } from "./modules/uploads/contracts.ts";
import { helloResponseSchema, healthStatusSchema } from "./transport.ts";
import { nonEmptyStringSchema, jsonRecordSchema } from "./primitives.ts";
import { z } from "zod";
import { runtimeMetricsSchema } from "./runtime-metrics.ts";

import { telemetryRequestSchema, telemetryEventSchema } from "./modules/telemetry/contracts.ts";

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

const statusDescriptions = new Map<number, string>(
  Object.entries({
    200: "操作成功",
    201: "资源创建成功",
    400: "请求参数无效",
    401: "未认证或凭据无效",
    403: "权限不足或来源无效",
    404: "资源不存在",
    409: "资源冲突",
    413: "请求体超过限制",
    415: "不支持的媒体类型",
    429: "请求过于频繁",
    500: "服务器内部错误",
    503: "依赖不可用",
  }).map(([status, description]) => [Number(status), description]),
);

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
  metricsAuthenticated?: boolean;
  request?: {
    name: string;
    schema: z.ZodType;
    contentType: "application/json" | "multipart/form-data";
  };
  query?: { name: string; schema: z.ZodObject };
  responses: Record<number, HttpResponseContract>;
}

function response(name: string, schema: z.ZodType, status = 200): HttpResponseContract {
  return { name, schema, description: statusDescriptions.get(status) ?? `HTTP ${status}` };
}
function failures(...statuses: number[]): Record<number, HttpResponseContract> {
  return Object.fromEntries(
    statuses.map((status) => [status, response("ApiFailure", apiFailureSchema, status)]),
  );
}
function json(name: string, schema: z.ZodType) {
  return { name, schema, contentType: "application/json" as const };
}

export const apiOperations = [
  {
    operationId: "getApiSystemMetrics",
    method: "GET",
    path: "/api/system/metrics",
    routeFile: "app/api/system/metrics/route.ts",
    tag: "System",
    summary: "使用独立凭据读取进程和数据库聚合指标",
    metricsAuthenticated: true,
    responses: {
      200: response("RuntimeMetricsSuccess", apiSuccessSchema(runtimeMetricsSchema)),
      ...failures(401, 500, 503),
    },
  },
  {
    operationId: "getApiSystemHealth",
    method: "GET",
    path: "/api/system/health",
    routeFile: "app/api/system/health/route.ts",
    tag: "System",
    summary: "查询应用健康状态",
    responses: {
      200: response("HealthSuccess", apiSuccessSchema(healthStatusSchema), 200),
      ...failures(500),
      503: response("HealthSuccess", apiSuccessSchema(healthStatusSchema), 503),
    },
  },
  {
    operationId: "postApiUploads",
    method: "POST",
    path: "/api/uploads",
    routeFile: "app/api/uploads/route.ts",
    tag: "Files",
    summary: "上传文件并记录审计和 outbox",
    authenticated: true,
    request: {
      name: "UploadRequest",
      schema: uploadRequestSchema,
      contentType: "multipart/form-data",
    },
    responses: {
      200: response("FileSuccess", apiSuccessSchema(fileAssetSchema), 200),
      ...failures(415, 400, 401, 403, 413, 415, 500, 503),
    },
  },
  {
    operationId: "postApiTelemetry",
    method: "POST",
    path: "/api/telemetry",
    routeFile: "app/api/telemetry/route.ts",
    tag: "Observability",
    summary: "写入前端埋点事件",
    request: json("TelemetryRequest", telemetryRequestSchema),
    responses: {
      201: response("TelemetrySuccess", apiSuccessSchema(telemetryEventSchema), 201),
      ...failures(415, 400, 403, 413, 429, 500, 503),
    },
  },
  {
    operationId: "getApiHello",
    method: "GET",
    path: "/api/hello",
    routeFile: "app/api/hello/route.ts",
    tag: "System",
    summary: "验证 vinext HTTP 路由",
    responses: { 200: response("HelloResponse", helloResponseSchema, 200) },
  },
] as const satisfies readonly HttpOperationContract[];

export type ApiOperationId = (typeof apiOperations)[number]["operationId"];

export function apiOperation(operationId: ApiOperationId): HttpOperationContract {
  const operation = apiOperations.find((entry) => entry.operationId === operationId);
  if (!operation) throw new Error(`Unknown API operation: ${operationId}`);
  return operation;
}

export function parseApiResponse(
  operationId: ApiOperationId,
  status: number,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The selected operation schema validates this transport boundary.
  body: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The registered operation chooses the result type for immediate serialization.
): unknown {
  const contract = apiOperation(operationId).responses[status];
  if (!contract) throw new Error(`Undeclared HTTP status ${status} for ${operationId}`);
  return contract.schema.parse(body);
}

export function findApiOperation(method: string, pathname: string) {
  const segments = pathname.replace(/\/$/, "").split("/");
  return apiOperations.find((operation) => {
    if (operation.method !== method.toUpperCase()) return false;
    const expected = operation.path.split("/");
    return (
      expected.length === segments.length &&
      expected.every((part, index) =>
        part.startsWith("{") ? Boolean(segments[index]) : part === segments[index],
      )
    );
  });
}
