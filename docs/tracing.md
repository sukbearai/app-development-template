# Optional HTTP tracing

The Web API supports OpenTelemetry over OTLP HTTP/JSON. Set `OTEL_ENABLED=true` to enable it. The default is `false`, which creates no provider or exporter. This integration traces handlers wrapped in `withAccessLog`; it does not instrument browser errors, page rendering, database queries or workers.

| Variable                             | Default                           | Purpose                                                                   |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `OTEL_ENABLED`                       | `false`                           | Enable server HTTP spans                                                  |
| `OTEL_SERVICE_NAME`                  | `pstack-web`                      | Resource service name                                                     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:4318/v1/traces` | Full HTTP(S) trace endpoint, without credentials, query or fragment       |
| `OTEL_EXPORTER_OTLP_HEADERS`         | unset                             | Comma-separated `key=value` exporter headers, with percent-encoded values |
| `OTEL_TRACES_SAMPLER_ARG`            | `1`                               | Root trace sampling probability, between 0 and 1                          |

Supply exporter credentials through the deployment secret mechanism. For example, `authorization=Bearer%20...` sends a bearer token to the configured collector. Do not add it to source control. Use HTTPS when the collector is outside the trusted local network.

Valid W3C `traceparent` headers preserve the upstream trace and sampling decision. New roots use the configured probability. Incoming `tracestate` and `baggage` are discarded. Spans include only the registered route template, known method and response status. They exclude URL query strings, raw paths, request or response bodies, cookies, authorization, user identifiers and exception messages. Unknown routes use `unmatched`. Configure `OTEL_SERVICE_NAME` as a fixed deployment name without secrets.

Responses include `x-otel-trace-id` when enabled. Structured access and error logs include `otelTraceId` and `otelSpanId` alongside the existing application `traceId`, which remains the API envelope and durable event identifier. Search the logs by either identifier to find the other. No user-supplied application trace ID is exported as a span attribute.

The first admitted API request initializes the provider once. Each request runs inside an asynchronous span context. On SIGTERM or SIGINT, the production Web lifecycle first drains admitted requests, then shuts down the provider and flushes queued spans. Export attempts have a three-second timeout; the existing Web shutdown deadline remains the outer limit. An unavailable collector does not change an application response. A failed final export is reported as a Web cleanup failure with exit status 1. Queue overflow or forced process termination can lose spans. Development servers do not run the production drain lifecycle.

## Verify with a local collector

Start an isolated collector from the repository root:

```sh
docker run --rm --name pstack-otel-proof -p 127.0.0.1:4318:4318 \
  -v "$PWD/deploy/otel-collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector:0.148.0
```

Run the HTTP fixture in another terminal. It uses no database and drains the same lifecycle used by the production Web process:

```sh
OTEL_ENABLED=true OTEL_SERVICE_NAME=pstack-local-proof \
  pnpm --filter @pstack/server exec tsx tests/fixtures/tracing.mjs
```

The collector prints a `POST /api/trpc/users.update` server span with status 500 and trace ID `0123456789abcdef0123456789abcdef`. The fixture intentionally throws to exercise error attribution. Its exception text and request secrets must be absent from the collector output. The response record and access log share the exported trace ID. Stop the disposable collector after inspecting the output.

`pnpm --filter @pstack/server test:unit` also runs a real OTLP HTTP receiver and checks default-off behavior, propagation, log correlation, exporter authentication, sanitized payloads, shutdown flush and collector failure.

`pnpm --filter @pstack/server test:tracing-collector` repeats the official collector check with a disposable container and an ephemeral loopback port, then removes the container. It does not connect to an application database.
