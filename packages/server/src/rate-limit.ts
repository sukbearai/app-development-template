import { ApiError } from "./api-response";
import { env } from "./env";
import { redisDel, redisWindowCount } from "./redis-client";

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

function pruneOverflowBuckets() {
  while (buckets.size > env.LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) break;
    buckets.delete(oldestKey);
  }
}

export function assertRateLimit(
  key: string,
  options?: { limit?: number; windowMs?: number },
) {
  const limit = options?.limit || env.LOGIN_RATE_LIMIT_MAX;
  const windowMs =
    options?.windowMs || env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const now = Date.now();
  pruneExpiredBuckets(now);
  const current = buckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  pruneOverflowBuckets();
  if (bucket.count > limit) {
    throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    });
  }
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

export async function assertRequestRateLimit(
  key: string,
  options: { limit?: number; windowMs?: number } = {},
) {
  const limit = options.limit ?? env.LOGIN_RATE_LIMIT_MAX;
  const windowMs =
    options.windowMs ?? env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
  if (env.RATE_LIMIT_DRIVER === "redis") {
    if (!env.REDIS_URL)
      throw new Error("REDIS_URL is required when RATE_LIMIT_DRIVER=redis");
    const { count, ttlMs } = await redisWindowCount(
      env.REDIS_URL,
      key,
      windowMs,
    );
    if (count > limit) {
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
        retryAfterSeconds: Math.ceil(ttlMs / 1000),
      });
    }
    return;
  }
  assertRateLimit(key, { limit, windowMs });
}

export async function resetLoginRateLimit(key: string) {
  if (env.RATE_LIMIT_DRIVER === "redis") {
    if (env.REDIS_URL) await redisDel(env.REDIS_URL, key);
    return;
  }
  resetRateLimit(key);
}

export async function assertLoginRateLimit(key: string) {
  return assertRequestRateLimit(key);
}
