import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { envSchema } from "../src/env.ts";
import { readBoundedFormData } from "../src/upload-memory-limits.ts";
import { fail, readJson } from "../src/api-response.ts";
import { redact, withAccessLog } from "../src/logger.ts";
import { verifyRequestOrigin, setSessionCookie } from "../src/request-auth.ts";
test("passwords require scrypt and verify the complete digest", async () => {
  assert.equal(await verifyPassword("admin", "plain:admin"), false);
  const encoded = await hashPassword("a-strong-generated-password");
  assert.equal(
    await verifyPassword("a-strong-generated-password", encoded),
    true,
  );
  assert.equal(await verifyPassword("wrong", encoded), false);
});
test("boolean config and cookie TTL use explicit values", () => {
  assert.equal(
    envSchema.parse({ OBJECT_STORAGE_FORCE_PATH_STYLE: "false" })
      .OBJECT_STORAGE_FORCE_PATH_STYLE,
    false,
  );
  assert.throws(() =>
    envSchema.parse({ OBJECT_STORAGE_FORCE_PATH_STYLE: "yes" }),
  );
  const response = setSessionCookie(new Response(), "id.secret");
  assert.match(response.headers.get("set-cookie"), /Max-Age=86400/);
});
test("forged forwarded headers cannot establish cookie write origin", () => {
  const request = new Request("https://app.example/api/users", {
    method: "POST",
    headers: {
      cookie: "pstack_session=id.secret",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(verifyRequestOrigin(request), false);
});
test("JSON parse and unknown error boundaries preserve safe status", async () => {
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    ),
    (error) => error.code === "INVALID_JSON",
  );
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    ),
    (error) => error.status === 415,
  );
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(65537),
      }),
    ),
    (error) => error.status === 413,
  );
  const response = fail(
    new Error("postgres://admin:secret@example/database"),
    "trace",
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(
    JSON.stringify(
      redact({
        nested: { password: "sensitive" },
        error: new Error("postgres://user:pass@db/x token=hidden"),
      }),
    ),
    /sensitive|hidden|user:pass/,
  );
});
test("actual stream bytes enforce upload ceiling without content length", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: new Uint8Array(1024 * 1024 + 20),
  });
  await assert.rejects(
    readBoundedFormData(request, 10),
    (error) => error.status === 413,
  );
  const form = new FormData();
  form.append("file", new File(["hello"], "hello.txt"));
  const valid = await readBoundedFormData(
    new Request("https://example.test", { method: "POST", body: form }),
    100,
  );
  assert.equal(await valid.get("file").text(), "hello");
});
test("HTTP boundary rejects an invalid success body", async () => {
  const response = await withAccessLog(
    new Request("http://localhost/api/auth/login", { method: "POST" }),
    "trace",
    async () =>
      Response.json({ traceId: "trace", data: { broken: true }, meta: {} }),
  );
  assert.equal(response.status, 500);
});

test("HTTP boundary removes undeclared output fields and preserves cookies", async () => {
  const response = await withAccessLog(
    new Request("http://localhost/api/admin/users", { method: "POST" }), "trace",
    async () => Response.json({ traceId: "trace", data: { id: "user", account: "test", displayName: "Test", status: "enabled", roleIds: [], createdAt: new Date().toISOString(), passwordHash: "synthetic-secret" }, meta: {} }, { status: 201, headers: { "set-cookie": "test=value; HttpOnly" } }),
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /test=value/);
  assert.equal("passwordHash" in (await response.json()).data, false);
});
