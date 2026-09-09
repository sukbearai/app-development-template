import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { env } from "./env";

function exporterHeaders() {
  return Object.fromEntries(
    (env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
      .split(",")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) throw new Error("Invalid OTEL_EXPORTER_OTLP_HEADERS");
        try {
          const key = decodeURIComponent(entry.slice(0, separator).trim());
          const value = decodeURIComponent(entry.slice(separator + 1).trim());
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value))
            throw new Error("Invalid header");
          return [key, value];
        } catch {
          throw new Error("Invalid OTEL_EXPORTER_OTLP_HEADERS");
        }
      }),
  );
}

export function createTraceProvider() {
  const exporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    headers: exporterHeaders(),
    timeoutMillis: 3000,
  });
  return new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACES_SAMPLER_ARG),
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 512,
        maxExportBatchSize: 128,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 5000,
      }),
    ],
  });
}
