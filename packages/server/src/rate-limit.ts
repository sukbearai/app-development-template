import { ApiError } from "./api-response";
import { env } from "./env";
import { redisWindowCount } from "./redis-client";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function pruneExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function assertRateLimit(key: string, options?: { limit?: number; windowMs?: number }) {
  const limit = options?.limit ?? env.LOGIN_RATE_LIMIT_MAX;
  const windowMs = options?.windowMs ?? env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const now = Date.now();
  pruneExpiredBuckets(now);
  const current = buckets.get(key);
  if (!current && buckets.size >= env.LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS) {
    let resetAt = Infinity;
    for (const bucket of buckets.values()) resetAt = Math.min(resetAt, bucket.resetAt);
    throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    });
  }
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  if (bucket.count > limit) {
    throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    });
  }
}

export async function assertRequestRateLimit(
  key: string,
  options: { limit?: number; windowMs?: number } = {},
) {
  const limit = options.limit ?? env.LOGIN_RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
  if (env.RATE_LIMIT_DRIVER === "redis") {
    if (!env.REDIS_URL) throw new Error("REDIS_URL is required when RATE_LIMIT_DRIVER=redis");
    const { count, ttlMs } = await redisWindowCount(env.REDIS_URL, key, windowMs);
    if (count > limit) {
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
        retryAfterSeconds: Math.ceil(ttlMs / 1000),
      });
    }
    return;
  }
  assertRateLimit(key, { limit, windowMs });
}

export async function assertLoginRateLimit(key: string) {
  return assertRequestRateLimit(key);
}

export async function assertOverallLoginRateLimit() {
  await assertRequestRateLimit("login:overall", { limit: env.LOGIN_RATE_LIMIT_GLOBAL_MAX });
}
