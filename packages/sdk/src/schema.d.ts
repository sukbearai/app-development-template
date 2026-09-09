import type { jsonRecordSchema } from "@pstack/contracts/schemas";
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
  "/api/auth/password": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 验证当前密码并修改密码，撤销所有会话 */
    post: operations["postApiAuthPassword"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/users/{id}/password": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 管理员重置其他用户密码并撤销其所有会话 */
    post: operations["postApiAdminUsersIdPassword"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/auth/login": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 账号密码登录 */
    post: operations["postApiAuthLogin"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/auth/me": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 获取当前用户、角色和权限 */
    get: operations["getApiAuthMe"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/auth/logout": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 退出登录并失效当前会话 */
    post: operations["postApiAuthLogout"];
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
  "/api/admin/users": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 分页搜索用户、角色和权限 */
    get: operations["getApiAdminUsers"];
    put?: never;
    /** 创建用户 */
    post: operations["postApiAdminUsers"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/users/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 更新用户 */
    patch: operations["patchApiAdminUsersId"];
    trace?: never;
  };
  "/api/admin/roles": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 查询角色 */
    get: operations["getApiAdminRoles"];
    put?: never;
    /** 创建角色 */
    post: operations["postApiAdminRoles"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/roles/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 更新角色 */
    patch: operations["patchApiAdminRolesId"];
    trace?: never;
  };
  "/api/admin/audit-logs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 分页搜索审计日志 */
    get: operations["getApiAdminAuditLogs"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/outbox-events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 查询 outbox 事件 */
    get: operations["getApiAdminOutboxEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/admin/async-runtime-health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 查询异步运行时计划和任务积压 */
    get: operations["getApiAdminAsyncRuntimeHealth"];
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
    User: {
      id: string;
      account: string;
      displayName: string;
      /** @enum {string} */
      status: "enabled" | "disabled";
      roleIds: string[];
      /** Format: date-time */
      createdAt: string;
    };
    Role: {
      id: string;
      name: string;
      permissionIds: string[];
      /** @enum {string} */
      status: "active" | "inactive";
    };
    Permission: {
      id: string;
      name: string;
    };
    AuthSession: {
      id: string;
      userId: string;
      /** Format: date-time */
      expiresAt: string;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      lastUsedAt: string;
    };
    LoginResponse: {
      token: string;
      session: {
        id: string;
        userId: string;
        /** Format: date-time */
        expiresAt: string;
        /** Format: date-time */
        createdAt: string;
        /** Format: date-time */
        lastUsedAt: string;
      };
      user: {
        id: string;
        account: string;
        displayName: string;
        /** @enum {string} */
        status: "enabled" | "disabled";
        roleIds: string[];
        /** Format: date-time */
        createdAt: string;
      };
      roles: {
        id: string;
        name: string;
        permissionIds: string[];
        /** @enum {string} */
        status: "active" | "inactive";
      }[];
      permissions: {
        id: string;
        name: string;
      }[];
    };
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
    AuditEvent: {
      id: string;
      actorId?: string;
      action: string;
      targetType?: string;
      targetId?: string;
      traceId: string;
      /** Format: date-time */
      createdAt: string;
      metadata?: ReturnType<typeof jsonRecordSchema.parse>;
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
    OutboxEvent: {
      id: string;
      topic: string;
      eventType: string;
      payload: ReturnType<typeof jsonRecordSchema.parse>;
      /** @enum {string} */
      status: "pending" | "processing" | "published" | "failed" | "dead_letter";
      attempts: number;
      maxAttempts: number;
      /** Format: date-time */
      nextAttemptAt: string;
      lockedBy?: string;
      /** Format: date-time */
      lockedAt?: string;
      /** Format: date-time */
      publishedAt?: string;
      errorCode?: string;
      lastError?: string;
      traceId: string;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    AdminSummary: {
      users: number;
      auditEvents: number;
      telemetryEvents: number;
      files: number;
      outboxPending: number;
    };
    AsyncRuntimeHealth: {
      /** @constant */
      service: "async-runtime";
      /** @enum {string} */
      status: "ok" | "degraded" | "blocked";
      /** @constant */
      mode: "async_runtime_health";
      runtimePlan: {
        outboxIntervalMs: number;
        topics: string[];
        publisher: string;
        kafka: {
          brokersConfigured: number;
          clientId: string;
          consumerGroupId: string;
        };
        asyncTask: {
          defaultMaxAttempts: number;
          retryBaseMs: number;
          retryMaxMs: number;
          idempotencyTtlHours: number;
        };
      };
      outboxByTopic: {
        topic: string;
        pending: number;
        processing: number;
        failed: number;
        deadLetter: number;
        published: number;
        total: number;
        oldestPendingAgeMs: number;
      }[];
      tasks: {
        pending: number;
        running: number;
        succeeded: number;
        failed: number;
        deadLetter: number;
        canceled: number;
        total: number;
      };
      alerts: {
        /** @enum {string} */
        severity: "warning" | "critical";
        reason: string;
        message: string;
        metric?: string;
        value?: number;
        threshold?: number;
        topic?: string;
      }[];
      blockedReasons: string[];
      /** Format: date-time */
      checkedAt: string;
    };
    AsyncTaskEventMessage: {
      /** @description At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes. */
      eventId: string;
      /** @description At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes. */
      eventType: string;
      /** @description At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes. */
      traceId: string;
      /** @description At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes. */
      taskId?: string;
      /** @description At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes. */
      idempotencyKey?: string;
      attemptCount?: number;
      maxAttempts?: number;
      /** Format: date-time */
      nextRetryAt?: string;
      /** Format: date-time */
      occurredAt?: string;
      payload: unknown;
    };
    KafkaConsumerOffset: {
      topic: string;
      partition: number;
      offset: string;
      /** @description At most 256 UTF-8 bytes. Whitespace is preserved as part of the consumer group identity. */
      consumerGroup: string;
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
    ChangePasswordRequest: {
      currentPassword: string;
      newPassword: string;
    };
    ChangePasswordSuccess: {
      traceId: string;
      data: {
        /** @constant */
        reauthenticate: true;
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    ResetUserPasswordRequest: {
      newPassword: string;
    };
    ResetUserPasswordSuccess: {
      traceId: string;
      data: {
        /** @constant */
        updated: true;
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    LoginRequest: {
      account: string;
      password: string;
    };
    LoginSuccess: {
      traceId: string;
      data: {
        token: string;
        session: {
          id: string;
          userId: string;
          /** Format: date-time */
          expiresAt: string;
          /** Format: date-time */
          createdAt: string;
          /** Format: date-time */
          lastUsedAt: string;
        };
        user: {
          id: string;
          account: string;
          displayName: string;
          /** @enum {string} */
          status: "enabled" | "disabled";
          roleIds: string[];
          /** Format: date-time */
          createdAt: string;
        };
        roles: {
          id: string;
          name: string;
          permissionIds: string[];
          /** @enum {string} */
          status: "active" | "inactive";
        }[];
        permissions: {
          id: string;
          name: string;
        }[];
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    CurrentUserSuccess: {
      traceId: string;
      data: {
        session: {
          id: string;
          userId: string;
          /** Format: date-time */
          expiresAt: string;
          /** Format: date-time */
          createdAt: string;
          /** Format: date-time */
          lastUsedAt: string;
        };
        user: {
          id: string;
          account: string;
          displayName: string;
          /** @enum {string} */
          status: "enabled" | "disabled";
          roleIds: string[];
          /** Format: date-time */
          createdAt: string;
        };
        roles: {
          id: string;
          name: string;
          permissionIds: string[];
          /** @enum {string} */
          status: "active" | "inactive";
        }[];
        permissions: {
          id: string;
          name: string;
        }[];
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    LogoutSuccess: {
      traceId: string;
      data: {
        /** @constant */
        ok: true;
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
    UserPageQuery: {
      page?: string | number;
      limit?: string | number;
      /** @default  */
      search: string;
      /**
       * @default desc
       * @enum {string}
       */
      direction: "asc" | "desc";
      /**
       * @default all
       * @enum {string}
       */
      status: "all" | "enabled" | "disabled";
      /**
       * @default createdAt
       * @enum {string}
       */
      sort: "createdAt" | "account" | "displayName";
    };
    UserDirectorySuccess: {
      traceId: string;
      data: {
        page: number;
        limit: number;
        total: number;
        users: {
          id: string;
          account: string;
          displayName: string;
          /** @enum {string} */
          status: "enabled" | "disabled";
          roleIds: string[];
          /** Format: date-time */
          createdAt: string;
        }[];
        roles: {
          id: string;
          name: string;
          permissionIds: string[];
          /** @enum {string} */
          status: "active" | "inactive";
        }[];
        permissions: {
          id: string;
          name: string;
        }[];
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    CreateUserRequest: {
      account: string;
      displayName: string;
      password: string;
      /** @default [] */
      roleIds: string[];
      /**
       * @default enabled
       * @enum {string}
       */
      status: "enabled" | "disabled";
    };
    UserSuccess: {
      traceId: string;
      data: {
        id: string;
        account: string;
        displayName: string;
        /** @enum {string} */
        status: "enabled" | "disabled";
        roleIds: string[];
        /** Format: date-time */
        createdAt: string;
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    UpdateUserRequest: {
      displayName?: string;
      roleIds?: string[];
      /** @enum {string} */
      status?: "enabled" | "disabled";
    };
    RoleListSuccess: {
      traceId: string;
      data: {
        id: string;
        name: string;
        permissionIds: string[];
        /** @enum {string} */
        status: "active" | "inactive";
      }[];
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    CreateRoleRequest: {
      id: string;
      name: string;
      /** @default [] */
      permissionIds: string[];
      /**
       * @default active
       * @enum {string}
       */
      status: "active" | "inactive";
    };
    RoleSuccess: {
      traceId: string;
      data: {
        id: string;
        name: string;
        permissionIds: string[];
        /** @enum {string} */
        status: "active" | "inactive";
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    UpdateRoleRequest: {
      name?: string;
      permissionIds?: string[];
      /** @enum {string} */
      status?: "active" | "inactive";
    };
    AuditPageQuery: {
      page?: string | number;
      limit?: string | number;
      /** @default  */
      search: string;
      /**
       * @default desc
       * @enum {string}
       */
      direction: "asc" | "desc";
      /** @default  */
      action: string;
      /**
       * @default createdAt
       * @enum {string}
       */
      sort: "createdAt" | "action";
    };
    AuditListSuccess: {
      traceId: string;
      data: {
        page: number;
        limit: number;
        total: number;
        items: {
          id: string;
          actorId?: string;
          action: string;
          targetType?: string;
          targetId?: string;
          traceId: string;
          /** Format: date-time */
          createdAt: string;
          metadata?: ReturnType<typeof jsonRecordSchema.parse>;
        }[];
      };
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    OutboxListSuccess: {
      traceId: string;
      data: {
        id: string;
        topic: string;
        eventType: string;
        payload: ReturnType<typeof jsonRecordSchema.parse>;
        /** @enum {string} */
        status: "pending" | "processing" | "published" | "failed" | "dead_letter";
        attempts: number;
        maxAttempts: number;
        /** Format: date-time */
        nextAttemptAt: string;
        lockedBy?: string;
        /** Format: date-time */
        lockedAt?: string;
        /** Format: date-time */
        publishedAt?: string;
        errorCode?: string;
        lastError?: string;
        traceId: string;
        /** Format: date-time */
        createdAt: string;
        /** Format: date-time */
        updatedAt: string;
      }[];
      meta?: ReturnType<typeof jsonRecordSchema.parse>;
    };
    AsyncRuntimeHealthSuccess: {
      traceId: string;
      data: {
        /** @constant */
        service: "async-runtime";
        /** @enum {string} */
        status: "ok" | "degraded" | "blocked";
        /** @constant */
        mode: "async_runtime_health";
        runtimePlan: {
          outboxIntervalMs: number;
          topics: string[];
          publisher: string;
          kafka: {
            brokersConfigured: number;
            clientId: string;
            consumerGroupId: string;
          };
          asyncTask: {
            defaultMaxAttempts: number;
            retryBaseMs: number;
            retryMaxMs: number;
            idempotencyTtlHours: number;
          };
        };
        outboxByTopic: {
          topic: string;
          pending: number;
          processing: number;
          failed: number;
          deadLetter: number;
          published: number;
          total: number;
          oldestPendingAgeMs: number;
        }[];
        tasks: {
          pending: number;
          running: number;
          succeeded: number;
          failed: number;
          deadLetter: number;
          canceled: number;
          total: number;
        };
        alerts: {
          /** @enum {string} */
          severity: "warning" | "critical";
          reason: string;
          message: string;
          metric?: string;
          value?: number;
          threshold?: number;
          topic?: string;
        }[];
        blockedReasons: string[];
        /** Format: date-time */
        checkedAt: string;
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
  postApiAuthPassword: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ChangePasswordRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ChangePasswordSuccess"];
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
      /** @description 资源冲突 */
      409: {
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
  postApiAdminUsersIdPassword: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ResetUserPasswordRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ResetUserPasswordSuccess"];
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
      /** @description 资源不存在 */
      404: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 资源冲突 */
      409: {
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
  postApiAuthLogin: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["LoginRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["LoginSuccess"];
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
  getApiAuthMe: {
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
          "application/json": components["schemas"]["CurrentUserSuccess"];
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
  postApiAuthLogout: {
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
          "application/json": components["schemas"]["LogoutSuccess"];
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
  getApiAdminUsers: {
    parameters: {
      query?: {
        page?: string | number;
        limit?: string | number;
        search?: string;
        direction?: "asc" | "desc";
        status?: "all" | "enabled" | "disabled";
        sort?: "createdAt" | "account" | "displayName";
      };
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
          "application/json": components["schemas"]["UserDirectorySuccess"];
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
  postApiAdminUsers: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateUserRequest"];
      };
    };
    responses: {
      /** @description 资源创建成功 */
      201: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["UserSuccess"];
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
      /** @description 资源冲突 */
      409: {
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
  patchApiAdminUsersId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateUserRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["UserSuccess"];
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
      /** @description 资源不存在 */
      404: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 资源冲突 */
      409: {
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
  getApiAdminRoles: {
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
          "application/json": components["schemas"]["RoleListSuccess"];
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
  postApiAdminRoles: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateRoleRequest"];
      };
    };
    responses: {
      /** @description 资源创建成功 */
      201: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["RoleSuccess"];
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
      /** @description 资源冲突 */
      409: {
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
  patchApiAdminRolesId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateRoleRequest"];
      };
    };
    responses: {
      /** @description 操作成功 */
      200: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["RoleSuccess"];
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
      /** @description 资源不存在 */
      404: {
        headers: {
          [name: string]: string;
        };
        content: {
          "application/json": components["schemas"]["ApiFailure"];
        };
      };
      /** @description 资源冲突 */
      409: {
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
  getApiAdminAuditLogs: {
    parameters: {
      query?: {
        page?: string | number;
        limit?: string | number;
        search?: string;
        direction?: "asc" | "desc";
        action?: string;
        sort?: "createdAt" | "action";
      };
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
          "application/json": components["schemas"]["AuditListSuccess"];
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
  getApiAdminOutboxEvents: {
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
          "application/json": components["schemas"]["OutboxListSuccess"];
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
  getApiAdminAsyncRuntimeHealth: {
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
          "application/json": components["schemas"]["AsyncRuntimeHealthSuccess"];
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
