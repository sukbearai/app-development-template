import { loadEnvironment } from "@pstack/database/environment";
import { z } from "zod";

export const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_NAME: z.string().trim().min(1).default("Pstack X"),
  APP_ORIGIN: z.url().optional(),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("pstack_session"),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(2592000)
    .default(86400),
  LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
  RATE_LIMIT_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  DATABASE_URL: z.string().trim().min(1).optional(),
  UPLOAD_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
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
// Entrypoints load .env.local then .env without overriding the process environment.
export const env = envSchema.parse(loadEnvironment());
