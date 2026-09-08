import { ApiError } from "./api-response";
import { env } from "./env";

let active = 0;
let rejectedTotal = 0;

export function uploadAdmissionSnapshot() {
  return { active, limit: env.UPLOAD_MAX_CONCURRENT, rejectedTotal };
}

export async function withUploadAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= env.UPLOAD_MAX_CONCURRENT) {
    rejectedTotal++;
    throw new ApiError(503, "UPLOAD_BUSY", "上传并发已达上限，请稍后重试");
  }
  active++;
  try {
    return await operation();
  } finally {
    active--;
  }
}
