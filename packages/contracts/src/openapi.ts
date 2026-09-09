import { z } from "zod";
import * as schemas from "./schemas.ts";
import { apiFailureSchema, apiOperations, type HttpOperationContract } from "./http.ts";

export function jsonSchema(schema: z.ZodType, io: "input" | "output") {
  const { $schema: _dialect, ...definition } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
  });
  return definition;
}

const models = {
  User: schemas.userSchema,
  Role: schemas.roleSchema,
  Permission: schemas.permissionSchema,
  AuthSession: schemas.authSessionSchema,
  LoginResponse: schemas.loginResponseSchema,
  HealthStatus: schemas.healthStatusSchema,
  AuditEvent: schemas.auditEventSchema,
  TelemetryEvent: schemas.telemetryEventSchema,
  FileAsset: schemas.fileAssetSchema,
  OutboxEvent: schemas.outboxEventSchema,
  AdminSummary: schemas.adminSummarySchema,
  AsyncRuntimeHealth: schemas.asyncRuntimeHealthSchema,
  AsyncTaskEventMessage: schemas.asyncTaskEventMessageSchema,
  KafkaConsumerOffset: schemas.kafkaConsumerOffsetSchema,
  ApiFailure: apiFailureSchema,
};

export const openApiSchemas = Object.fromEntries([
  ...Object.entries(models).map(([name, schema]) => [name, jsonSchema(schema, "output")]),
  ...apiOperations.flatMap((entry) => {
    const operation: HttpOperationContract = entry;
    return [
      ...(operation.request
        ? [[operation.request.name, jsonSchema(operation.request.schema, "input")]]
        : []),
      ...(operation.query
        ? [[operation.query.name, jsonSchema(operation.query.schema, "input")]]
        : []),
      ...Object.values(operation.responses).map((entry) => [
        entry.name,
        jsonSchema(entry.schema, "output"),
      ]),
    ];
  }),
]);

type OpenApiOperation = {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: {
    name: string;
    in: string;
    required: boolean;
    schema: ReturnType<typeof jsonSchema>;
  }[];
  security?: Record<string, string[]>[];
  requestBody?: { required: boolean; content: Record<string, { schema: { $ref: string } }> };
  responses: Record<
    string,
    { description: string; content: { "application/json": { schema: { $ref: string } } } }
  >;
};
export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const entry of apiOperations) {
    const operation: HttpOperationContract = entry;
    const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: jsonSchema(schemas.nonEmptyStringSchema, "input"),
    }));
    if (operation.query) {
      for (const [name, schema] of Object.entries(operation.query.schema.shape)) {
        parameters.push({
          name,
          in: "query",
          required: !schema.safeParse(undefined).success,
          schema: jsonSchema(schema, "input"),
        });
      }
    }
    const optional: Pick<OpenApiOperation, "parameters" | "security" | "requestBody"> = {};
    if (parameters.length) optional.parameters = parameters;
    if (operation.metricsAuthenticated) optional.security = [{ metricsBearerAuth: [] }];
    if (operation.authenticated) optional.security = [{ bearerAuth: [] }, { cookieAuth: [] }];
    if (operation.request)
      optional.requestBody = {
        required: true,
        content: {
          [operation.request.contentType]: {
            schema: { $ref: `#/components/schemas/${operation.request.name}` },
          },
        },
      };
    paths[operation.path] ??= {};
    paths[operation.path][operation.method.toLowerCase()] = {
      operationId: operation.operationId,
      summary: operation.summary,
      tags: [operation.tag],
      ...optional,
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          {
            description: response.description,
            content: {
              "application/json": { schema: { $ref: `#/components/schemas/${response.name}` } },
            },
          },
        ]),
      ),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "pstack application API",
      version: "0.1.0",
      description: "由 @pstack/contracts 的 Zod schema 和 HTTP 操作登记生成。",
    },
    servers: [{ url: "http://localhost:3100", description: "本地开发服务" }],
    paths,
    components: {
      securitySchemes: {
        metricsBearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "仅接受 METRICS_TOKEN 独立凭据，不接受用户会话或 Cookie。",
        },
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "session-token" },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "pstack_session",
          description:
            "默认 Cookie 名称，可通过 SESSION_COOKIE_NAME 配置。Cookie 会话的写请求必须携带同源 Origin。",
        },
      },
      schemas: openApiSchemas,
    },
  };
}
