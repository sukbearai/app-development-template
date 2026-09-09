import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { registerProcessCleanup } from "@pstack/database/process-lifecycle";
import { findApiOperation } from "@pstack/contracts/http";
import { env } from "./env";

let initialization: Promise<void> | undefined;

async function initializeTracing() {
  const { createTraceProvider } = await import("./tracing-provider");
  const provider = createTraceProvider();
  provider.register();
  registerProcessCleanup(() => provider.shutdown());
}

export function traceLogFields() {
  if (!env.OTEL_ENABLED) return {};
  const span = trace.getSpan(context.active())?.spanContext();
  return span ? { otelTraceId: span.traceId, otelSpanId: span.spanId } : {};
}

export async function withHttpTrace(request: Request, handler: () => Promise<Response>) {
  if (!env.OTEL_ENABLED) return handler();
  initialization ??= initializeTracing();
  await initialization;
  const operation = findApiOperation(request.method, new URL(request.url).pathname);
  const method = operation?.method ?? "_OTHER";
  const route = operation?.path ?? "unmatched";
  const parent = propagation.extract(ROOT_CONTEXT, {
    traceparent: request.headers.get("traceparent") ?? "",
  });
  return trace.getTracer("pstack.http").startActiveSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": method, "http.route": route },
    },
    parent,
    async (span) => {
      try {
        const response = await handler();
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        const headers = new Headers(response.headers);
        headers.set("x-otel-trace-id", span.spanContext().traceId);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
