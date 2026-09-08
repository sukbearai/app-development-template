import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-response";
import { env } from "./env";

const expectedDigest = env.METRICS_TOKEN
  ? createHash("sha256").update(env.METRICS_TOKEN).digest() : undefined;

export function requireMetricsToken(request: Request) {
  const header = request.headers.get("authorization");
  if (!expectedDigest || !header || header.length > 263 || !/^Bearer [A-Za-z0-9_-]{32,256}$/i.test(header))
    throw new ApiError(401, "METRICS_UNAUTHORIZED", "运行指标凭据无效");
  const supplied = createHash("sha256").update(header.slice(7)).digest();
  if (!timingSafeEqual(expectedDigest, supplied))
    throw new ApiError(401, "METRICS_UNAUTHORIZED", "运行指标凭据无效");
}
