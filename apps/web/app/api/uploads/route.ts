import { authToken } from "@pstack/server/request-auth";
import { getTraceId, ok } from "@pstack/server/api-response";
import { requireApiWritePermission } from "@/lib/api-authz";
import { env } from "@pstack/server/env";
import { withAccessLog } from "@pstack/server/logger";
import { storeUploadedFile } from "@pstack/server/product-service";
import { assertInMemoryUploadSize, assertRequestContentLength, readBoundedFormData } from "@pstack/server/upload-memory-limits";
import { parseInput } from "@pstack/server/validation";
import { z } from "zod";

const uploadFileSchema = z.instanceof(File);

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiWritePermission(request, "file.upload");
    assertRequestContentLength(request, env.UPLOAD_MAX_BYTES, "上传请求");
    const formData = await readBoundedFormData(request, env.UPLOAD_MAX_BYTES);
    const file = parseInput(uploadFileSchema, formData.get("file"));
    assertInMemoryUploadSize({ sizeBytes: file.size, maxBytes: env.UPLOAD_MAX_BYTES, label: "上传文件" });
    return ok(await storeUploadedFile({ file, traceId, token: authToken(request) }), traceId);
  });
}
