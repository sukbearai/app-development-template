import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApiDocument } from "../src/openapi.ts";
import { databaseMetricsSchema } from "../src/runtime-metrics.ts";

test("metrics use dedicated bearer security without session or cookie alternatives", () => {
  const document = buildOpenApiDocument();
  assert.deepEqual(document.paths["/api/system/metrics"].get.security, [{ metricsBearerAuth: [] }]);
  assert.equal(document.components.securitySchemes.metricsBearerAuth.scheme, "bearer");
  assert.deepEqual(document.paths["/api/uploads"].post.security, [
    { bearerAuth: [] },
    { cookieAuth: [] },
  ]);
});
test("database unavailable observations cannot masquerade as healthy empty aggregates", () => {
  const observedAt = new Date().toISOString();
  assert.deepEqual(
    databaseMetricsSchema.parse({ status: "unavailable", observedAt, outbox: { pending: 0 } }),
    { status: "unavailable", observedAt },
  );
  assert.equal(databaseMetricsSchema.safeParse({ status: "available", observedAt }).success, false);
});
