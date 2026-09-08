import { ZodError, type ZodSchema } from "zod";
import { ApiError } from "./api-response";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Zod validates untrusted request input at this boundary.
export function parseInput<T>(schema: ZodSchema<T>, input: unknown) {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(400, "VALIDATION_FAILED", "请求参数无效", {
        issues: error.issues,
      });
    }
    throw error;
  }
}
