import test from "node:test";
import assert from "node:assert/strict";
import { uploadFile, validateUpload } from "../../components/upload-client.ts";
import { createBatchUploader } from "../../components/uppy-client.ts";
import { ApiRequestError } from "../../components/api-client.ts";
import { createAppQueryClient, handleApiSessionError } from "../../components/api-query-policy.ts";

const asset = {
  id: "file-test",
  fileName: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
  storageKey: "upload-test",
  uploadedAt: "2026-01-01T00:00:00.000Z",
};

class TestXHR extends EventTarget {
  static requests = [];
  upload = {};
  status = 0;
  response = null;
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send(body) {
    this.body = body;
    TestXHR.requests.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }
  respond(status, payload) {
    this.status = status;
    this.response = payload;
    this.onload?.();
    this.onloadend?.();
  }
}

function useXHR(t) {
  TestXHR.requests = [];
  t.mock.method(globalThis, "XMLHttpRequest", TestXHR);
}

// Node has no browser XMLHttpRequest; only the network boundary is replaced.
Object.defineProperty(globalThis, "XMLHttpRequest", {
  value: TestXHR,
  writable: true,
  configurable: true,
});
const file = () => new File(["abc"], "notes.txt", { type: "text/plain" });

async function nextRequest(index) {
  for (let i = 0; i < 100; i++) {
    if (TestXHR.requests[index]) return TestXHR.requests[index];
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Upload did not issue a request");
}

test("selection rejects empty and oversized files, accepts the exact server limit", () => {
  assert.match(validateUpload(new File([], "empty.txt"), 3), /空文件/);
  assert.match(validateUpload(file(), 2), /大小限制/);
  assert.equal(validateUpload(file(), 3), null);
});

test("single upload sends the file as multipart, reports progress, and waits for the server asset", async (t) => {
  useXHR(t);
  const progress = [];
  const pending = uploadFile({
    file: file(),
    signal: new AbortController().signal,
    onProgress: (value) => progress.push(value),
  });
  const xhr = await nextRequest(0);
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "/api/uploads");
  assert.equal(await xhr.body.get("file").text(), "abc");
  xhr.upload.onprogress({ loaded: 1, total: 2, lengthComputable: true });
  xhr.upload.onprogress({ loaded: 2, total: 2, lengthComputable: true });
  assert.deepEqual(progress, [50, 100]);
  xhr.respond(200, { traceId: "upload-trace", data: asset });
  assert.deepEqual(await pending, asset);
});

test("single upload preserves server error context and rejects malformed success", async (t) => {
  useXHR(t);
  for (const [index, status, response, expected] of [
    [
      0,
      413,
      {
        traceId: "size-trace",
        error: { code: "UPLOAD_TOO_LARGE", message: "文件太大" },
      },
      { code: "UPLOAD_TOO_LARGE", traceId: "size-trace" },
    ],
    [1, 200, { data: asset }, { kind: "invalid-response" }],
  ]) {
    const pending = uploadFile({
      file: file(),
      signal: new AbortController().signal,
      onProgress() {},
    });
    const rejected = assert.rejects(pending, expected);
    (await nextRequest(index)).respond(status, response);
    await rejected;
  }
});

test("cancelling an active or already cancelled upload does not send another request", async (t) => {
  useXHR(t);
  const controller = new AbortController();
  const pending = uploadFile({
    file: file(),
    signal: controller.signal,
    onProgress() {},
  });
  const rejected = assert.rejects(pending, { kind: "cancelled" });
  const xhr = await nextRequest(0);
  controller.abort();
  await rejected;
  assert.equal(xhr.aborted, true);
  await assert.rejects(uploadFile({ file: file(), signal: controller.signal, onProgress() {} }), {
    kind: "cancelled",
  });
  assert.equal(TestXHR.requests.length, 1);
});

test("Uppy rejects invalid files and uploads its queue as individual multipart requests", async (t) => {
  useXHR(t);
  const uppy = createBatchUploader(3);
  t.after(() => uppy.destroy());
  assert.throws(() => uppy.addFile({ name: "empty", data: new File([], "empty") }));
  assert.throws(() => uppy.addFile({ name: "large", data: new File(["abcd"], "large") }));
  uppy.addFile({ name: "one.txt", data: file() });
  uppy.addFile({ name: "two.txt", data: new File(["xyz"], "two.txt") });
  const pending = uppy.upload();
  const first = await nextRequest(0);
  assert.equal(first.url, "/api/uploads");
  assert.deepEqual([...first.body.keys()], ["file"]);
  assert.equal(TestXHR.requests.length, 1);
  first.respond(200, { traceId: "first-trace", data: asset });
  const second = await nextRequest(1);
  assert.equal(await second.body.get("file").text(), "xyz");
  second.respond(200, {
    traceId: "second-trace",
    data: { ...asset, fileName: "two.txt" },
  });
  const result = await pending;
  assert.equal(result.successful.length, 2);
  assert.equal(result.failed.length, 0);
});

test("Uppy surfaces server rejection without replaying a POST automatically", async (t) => {
  useXHR(t);
  const uppy = createBatchUploader(3);
  t.after(() => uppy.destroy());
  uppy.addFile({ name: "notes.txt", data: file() });
  const pending = uppy.upload();
  (await nextRequest(0)).respond(503, {
    traceId: "busy-trace",
    error: { code: "UPLOAD_BUSY", message: "上传繁忙" },
  });
  const result = await pending;
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /上传繁忙/);
  assert.equal(TestXHR.requests.length, 1);
});

test("Uppy cancellation aborts the active request and discards queued files", async (t) => {
  useXHR(t);
  const uppy = createBatchUploader(3);
  t.after(() => uppy.destroy());
  uppy.addFile({ name: "one.txt", data: file() });
  uppy.addFile({ name: "two.txt", data: new File(["xyz"], "two.txt") });
  const pending = uppy.upload();
  const active = await nextRequest(0);
  uppy.cancelAll();
  await pending;
  assert.equal(active.aborted, true);
  assert.equal(TestXHR.requests.length, 1);
  assert.deepEqual(uppy.getFiles(), []);
});

test("single upload network and timeout failures retain API failure kinds", async (t) => {
  useXHR(t);
  for (const [index, event, kind] of [
    [0, "onerror", "network"],
    [1, "ontimeout", "timeout"],
  ]) {
    const pending = uploadFile({
      file: file(),
      signal: new AbortController().signal,
      onProgress() {},
    });
    const rejected = assert.rejects(pending, { kind });
    (await nextRequest(index))[event]();
    await rejected;
  }
});

test("a single upload 401 clears private queries through the shared session handler", async (t) => {
  useXHR(t);
  let expired = 0;
  const client = createAppQueryClient(() => expired++);
  client.setQueryData(["private-files"], [asset]);
  const pending = uploadFile({
    file: file(),
    signal: new AbortController().signal,
    onProgress() {},
  }).catch((error) => handleApiSessionError(client, error));
  (await nextRequest(0)).respond(401, {
    traceId: "expired-trace",
    error: { code: "UNAUTHORIZED", message: "请登录" },
  });
  await pending;
  assert.equal(expired, 1);
  assert.equal(client.getQueryData(["private-files"]), undefined);
});

test("a Uppy 401 clears private queries and stops queued POSTs before the next file", async (t) => {
  useXHR(t);
  let expired = 0;
  const client = createAppQueryClient(() => expired++);
  client.setQueryData(["private-files"], [asset]);
  const uppy = createBatchUploader(3, (error) => handleApiSessionError(client, error));
  t.after(() => uppy.destroy());
  uppy.addFile({ name: "one.txt", data: file() });
  uppy.addFile({ name: "two.txt", data: new File(["xyz"], "two.txt") });
  const pending = uppy.upload();
  (await nextRequest(0)).respond(401, {
    traceId: "expired-trace",
    error: { code: "UNAUTHORIZED", message: "请登录" },
  });
  await pending;
  assert.equal(expired, 1);
  assert.equal(client.getQueryData(["private-files"]), undefined);
  assert.equal(TestXHR.requests.length, 1);
  assert.deepEqual(uppy.getFiles(), []);
});

test("Uppy wrapped API errors, cancellation, and stalls use API failure kinds", () => {
  const errors = [];
  const uppy = createBatchUploader(3, (error) => errors.push(error));
  const wrapped = new Error("transport wrapper", {
    cause: new ApiRequestError("请登录", {
      kind: "http",
      status: 401,
      code: "UNAUTHORIZED",
    }),
  });
  uppy.emit("upload-error", undefined, wrapped);
  uppy.emit("upload-stalled", new Error("stalled"), []);
  uppy.cancelAll();
  assert.deepEqual(
    errors.map((error) => error.kind),
    ["http", "timeout", "cancelled"],
  );
  assert.equal(errors[0].status, 401);
  uppy.destroy();
});
