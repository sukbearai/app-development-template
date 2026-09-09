import { createWebLifecycle } from "../../../../apps/web/scripts/process-lifecycle.mjs";

const lifecycle = createWebLifecycle();
process.pstackWebLifecycle = lifecycle;
const { withAccessLog } = await import("../../src/logger.ts");
const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
const response = await withAccessLog(
  new Request("http://localhost/api/trpc/users.update?token=query-secret", {
    method: "POST",
    headers: {
      traceparent: parent,
      tracestate: "private=state-secret",
      baggage: "secret=baggage-secret",
      authorization: "Bearer authorization-secret",
      cookie: "session=cookie-secret",
    },
    body: "body-secret",
  }),
  "custom-trace-secret",
  async () => {
    await Promise.resolve();
    throw new Error("exception-secret");
  },
);
console.log(
  JSON.stringify({
    responseTraceId: response.headers.get("x-otel-trace-id"),
    status: response.status,
  }),
);
await lifecycle.drain();
