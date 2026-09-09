import { z } from "zod";
import { appOriginSchema, booleanString } from "./config-values";
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  OTEL_ENABLED: booleanString.default(false),
  OTEL_SERVICE_NAME: z.string().trim().min(1).max(128).default("pstack-web"),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z
    .url()
    .refine((value) => {
      const endpoint = new URL(value);
      return (
        ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash
      );
    }, "OTLP endpoint must be HTTP(S) without credentials, query or fragment")
    .default("http://localhost:4318/v1/traces"),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().max(4096).optional(),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
  APP_NAME: z.string().trim().min(1).default("Pstack X"),
  APP_ORIGIN: appOriginSchema.optional(),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("pstack_session"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(2592000).default(86400),
  LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS: z.coerce.number().int().positive().default(5000),
  RATE_LIMIT_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  LOGIN_RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(200),
  WEB_REPLICAS: z.coerce.number().int().positive().default(1),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  DATABASE_URL: z.string().trim().min(1).optional(),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().max(2147483647).default(5),
  UPLOAD_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  UPLOAD_STORAGE_SHARED: booleanString.default(false),
  UPLOAD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(2),
  METRICS_TOKEN: z
    .union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)])
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
  UPLOAD_STORAGE_DIR: z.string().trim().min(1).default(".uploads"),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  REDIS_URL: z.url().optional(),
  OBJECT_STORAGE_ENDPOINT: z.url().optional(),
  OBJECT_STORAGE_REGION: z.string().trim().min(1).default("us-east-1"),
  OBJECT_STORAGE_ACCESS_KEY: z.string().trim().min(1).optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().trim().min(1).optional(),
  OBJECT_STORAGE_BUCKET: z.string().trim().min(1).default("app-files"),
  OBJECT_STORAGE_FORCE_PATH_STYLE: booleanString.default(true),
});
