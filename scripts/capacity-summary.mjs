import { z } from "zod";
import { tsImport } from "tsx/esm/api";
import { capacityFailure, summarizeFailures } from "./capacity-diagnostics.mjs";

const { parseApiResponse } = await tsImport("../packages/contracts/src/http.ts", import.meta.url);
const operationIds = {
  upload: "postApiUploads",
  metrics: "getApiSystemMetrics",
};

const { loginResponseSchema, roleSchema } = await tsImport(
  "../packages/contracts/src/modules/identity/contracts.ts",
  import.meta.url,
);
const procedureData = {
  login: loginResponseSchema,
  read: z.array(roleSchema),
  write: roleSchema,
};

export function parseCapacityResponse(operation, status, payload) {
  const dataSchema = procedureData[operation];
  if (dataSchema) {
    if (status >= 400) {
      return z
        .object({
          error: z.object({
            message: z.string(),
            code: z.number().int(),
            data: z.object({
              code: z.string().min(1),
              httpStatus: z.literal(status),
              businessCode: z.string().min(1),
              traceId: z.string().min(1),
            }),
          }),
          result: z.never().optional(),
        })
        .parse(payload);
    }
    return z
      .object({
        result: z.object({ data: dataSchema }),
        error: z.never().optional(),
      })
      .parse(payload);
  }
  return parseApiResponse(operationIds[operation], status, payload);
}

function latencyPercentiles(observations) {
  const durations = observations.map((item) => item.durationMs).sort((a, b) => a - b);
  const percentile = (fraction) =>
    durations.length ? durations[Math.ceil(durations.length * fraction) - 1] : null;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

export function summarizeRequests(observations, elapsedMs) {
  const successful = observations.filter((item) => item.outcome === "success").length;
  return {
    issued: observations.length,
    successful,
    uploadBusy: observations.filter((item) => item.outcome === "upload_busy").length,
    failed: observations.filter((item) => item.outcome === "failed").length,
    elapsedMs,
    requestsPerSecond: elapsedMs > 0 ? (observations.length * 1000) / elapsedMs : 0,
    successfulPerSecond: elapsedMs > 0 ? (successful * 1000) / elapsedMs : 0,
    latencyMs: latencyPercentiles(observations),
    latencyMsByOutcome: Object.fromEntries(
      ["success", "upload_busy", "failed"].map((outcome) => [
        outcome,
        latencyPercentiles(observations.filter((item) => item.outcome === outcome)),
      ]),
    ),
    ...summarizeFailures(observations),
  };
}

export function summarizeMetrics(samples) {
  const peak = (read) => (samples.length ? Math.max(...samples.map(read)) : null);
  return {
    samples: samples.length,
    firstObservedAt: samples.at(0)?.observedAt ?? null,
    lastObservedAt: samples.at(-1)?.observedAt ?? null,
    rssBytesPeak: peak((sample) => sample.process.rssBytes),
    heapUsedBytesPeak: peak((sample) => sample.process.heapUsedBytes),
    poolTotalPeak: peak((sample) => sample.databasePool.total),
    poolWaitingPeak: peak((sample) => sample.databasePool.waiting),
    uploadsActivePeak: peak((sample) => sample.uploads.active),
    uploadRejectedDelta: samples.length
      ? samples.at(-1).uploads.rejectedTotal - samples[0].uploads.rejectedTotal
      : null,
  };
}

export function assessCapacityResponse(operation, response, body) {
  let payload;
  try {
    payload = parseCapacityResponse(operation, response.status, body);
  } catch (error) {
    return { outcome: "failed", diagnostic: capacityFailure("response_contract", error) };
  }
  if (
    operation === "upload" &&
    response.status === 503 &&
    payload?.error?.code === "UPLOAD_BUSY" &&
    /^[1-9]\d*$/.test(response.headers.get("retry-after") ?? "")
  )
    return { outcome: "upload_busy" };
  const data = procedureData[operation] ? payload.result?.data : payload.data;
  return response.status === 200 && data !== undefined && !payload.error
    ? { outcome: "success", data }
    : { outcome: "failed", diagnostic: capacityFailure("response_status") };
}

export function responseOutcome(operation, response, body) {
  return assessCapacityResponse(operation, response, body).outcome;
}
