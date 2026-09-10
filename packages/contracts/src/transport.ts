import { z } from "zod";

import { nonEmptyStringSchema, isoDateTimeSchema } from "./primitives.ts";

export const healthStatusSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: nonEmptyStringSchema,
  time: isoDateTimeSchema,
  dependencies: z.record(z.string(), z.string()),
  configIssues: z.array(nonEmptyStringSchema).optional(),
});

export interface ApiSuccess<T = unknown> {
  traceId: string;
  data: T;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Extension metadata has no domain fields; each operation validates its envelope.
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  traceId: string;
  error: {
    code: string;
    message: string;
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Failure diagnostics are an extensible JSON object in the HTTP contract.
    details?: Record<string, unknown>;
  };
}

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export function readPageSearchParams(params: URLSearchParams) {
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}

export const helloResponseSchema = z.object({ message: z.literal("Hello from vinext") });
