import { ApiError } from "./api-response";

const multipartFormDataOverheadBytes = 1024 * 1024;

export function assertInMemoryUploadSize(input: {
  sizeBytes: number;
  maxBytes: number;
  label: string;
}) {
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new ApiError(400, "UPLOAD_EMPTY", `${input.label}不能为空`);
  }
  if (input.sizeBytes > input.maxBytes) {
    throw new ApiError(
      413,
      "UPLOAD_TOO_LARGE",
      `${input.label}不能超过 ${formatBytes(input.maxBytes)}；当前接口会在服务端内存中解析上传内容，超大文件请改用分片或对象存储上传链路`,
      { sizeBytes: input.sizeBytes, maxBytes: input.maxBytes },
    );
  }
}

export function assertRequestContentLength(
  request: Request,
  maxBytes: number,
  label: string,
) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength <= 0) return;
  assertInMemoryUploadSize({
    sizeBytes: contentLength,
    maxBytes: maxBytes + multipartFormDataOverheadBytes,
    label,
  });
}

function formatBytes(value: number) {
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${trimNumber(gib)}GB`;
  const mib = value / 1024 ** 2;
  return `${trimNumber(mib)}MB`;
}

function trimNumber(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

export async function readBoundedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  assertRequestContentLength(request, maxBytes, "上传请求");
  if (!request.body)
    throw new ApiError(400, "UPLOAD_EMPTY", "上传请求不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes + multipartFormDataOverheadBytes) {
        await reader.cancel();
        throw new ApiError(413, "UPLOAD_TOO_LARGE", "上传请求超过大小限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  try {
    return await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type") || "" },
    }).formData();
  } catch {
    throw new ApiError(400, "INVALID_MULTIPART", "上传请求格式无效");
  }
}
