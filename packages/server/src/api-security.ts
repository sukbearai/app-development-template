import { ApiError } from "./api-response";
import { verifyRequestOrigin } from "./request-auth";

export function assertSafeWriteOrigin(request: Request) {
  if (verifyRequestOrigin(request)) return;
  throw new ApiError(403, "CSRF_ORIGIN_INVALID", "请求来源无效");
}
