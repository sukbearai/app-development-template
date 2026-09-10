import type { jsonRecordSchema } from "@pstack/contracts/primitives";
export interface paths {
  "/api/system/metrics": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 使用独立凭据读取进程和数据库聚合指标 */
    get: operations["getApiSystemMetrics"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/system/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 查询应用健康状态 */
    get: operations["getApiSystemHealth"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/uploads": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 上传文件并记录审计和 outbox */
    post: operations["postApiUploads"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/telemetry": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 写入前端埋点事件 */
    post: operations["postApiTelemetry"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/hello": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 验证 vinext HTTP 路由 */
    get: operations["getApiHello"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    HealthStatus: {
      /** @enum {string} */
      status: "ok" | "degraded";
      service: string;
      /** Format: date-time */
      time: string;
      dependencies: {
        [key: string]: string;
      };
      configIssues?: string[];
    };
    TelemetryEvent: {
      id: string;
      event: string;
      route?: string;
      traceId: string;
      /** Format: date-time */
      occurredAt: string;
      payload?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    FileAsset: {
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      uploadedBy?: string;
      /** Format: date-time */
      uploadedAt: string;
    };
    ApiFailure: {
      traceId: string;
      error: {
        code: string;
        message: string;
        details?: ReturnType<typeof jsonRecordSchema.parse>;
      };
    };
    RuntimeMetricsSuccess: {
      traceId: string;
      data: {
        /** @constant */
        version: 1;
        /** Format: date-time */
        observedAt: string;
        process: {
          uptimeSeconds: number;
          rssBytes: number;
          heapUsedBytes: number;
        };
        databasePool: {
          total: number;
          idle: number;
          waiting: number;
          max: number;
        };
        uploads: {
          active: number;
          limit: number;
          rejectedTotal: number;
        };
        http: {
          operationId: string;
          status: number;
          count: number;
          durationMsTotal: number;
          durationMsMax: number;
        }[];
        database:
          | {
              /** @constant */
              status: "available";
              /** Format: date-time */
              observedAt: string;
              outbox: {
                pending: number;
                processing: number;
                failed: number;
                deadLetter: number;
                published: number;
                oldestPendingAgeMs: number;
                staleLocks: number;
              };
              tasks: {
                pending: number;
                running: number;
                succeeded: number;
                failed: number;
                deadLetter: number;
                canceled: number;
                oldestUnfinishedAgeMs: number;
              };
              quarantine: {
                message: number;
                recovery: number;
              };
              uploads: {
                pending: number;
                writing: number;
                cleanup: number;
                blocked: number;
              };
            }
          | {
              /** @constant */
              status: "unavailable";
              /** Format: date-time */
              observedAt: string;
            };
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    HealthSuccess: {
      traceId: string;
      data: {
        /** @enum {string} */
        status: "ok" | "degraded";
        service: string;
        /** Format: date-time */
        time: string;
        dependencies: {
          [key: string]: string;
        };
        configIssues?: string[];
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    UploadRequest: {
      /** Format: binary */
      file: File;
    };
    FileSuccess: {
      traceId: string;
      data: {
        id: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        storageKey: string;
        uploadedBy?: string;
        /** Format: date-time */
        uploadedAt: string;
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    TelemetryRequest: {
      event: string;
      route?: string;
      /** @default {} */
      payload: ReturnType<typeof jsonRecordSchema.parse>;
    };
    TelemetrySuccess: {
      traceId: string;
      data: {
        id: string;
        event: string;
        route?: string;
        traceId: string;
        /** Format: date-time */
        occurredAt: string;
        payload?: ReturnType<typeof jsonRecordSchema.parse>;
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    HelloResponse: {
      /** @constant */
      message: "Hello from vinext";
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getApiSystemMetrics: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["RuntimeMetricsSuccess"];
        };
      };
      /** @description 未认证或凭据无效 */
      401: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 服务器内部错误 */
      500: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 依赖不可用 */
      503: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
    };
  };
  getApiSystemHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["HealthSuccess"];
        };
      };
      /** @description 服务器内部错误 */
      500: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 依赖不可用 */
      503: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["HealthSuccess"];
        };
      };
    };
  };
  postApiUploads: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "multipart/form-data": components["schemas"]["UploadRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["FileSuccess"];
        };
      };
      /** @description 请求参数无效 */
      400: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 未认证或凭据无效 */
      401: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 权限不足或来源无效 */
      403: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 请求体超过限制 */
      413: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 不支持的媒体类型 */
      415: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 服务器内部错误 */
      500: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 依赖不可用 */
      503: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
    };
  };
  postApiTelemetry: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["TelemetryRequest"];
      };
    };
    responses: {
      /** @description 资源创建成功 */
      201: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["TelemetrySuccess"];
        };
      };
      /** @description 请求参数无效 */
      400: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 权限不足或来源无效 */
      403: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 请求体超过限制 */
      413: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 不支持的媒体类型 */
      415: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 请求过于频繁 */
      429: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 服务器内部错误 */
      500: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 依赖不可用 */
      503: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
    };
  };
  getApiHello: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["HelloResponse"];
        };
      };
    };
  };
}
