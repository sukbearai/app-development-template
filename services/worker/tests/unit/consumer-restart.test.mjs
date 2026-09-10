import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { createKafkaConsumer, runKafkaConsumer } from "../../src/async-consumer.ts";

const require = createRequire(import.meta.url);
const Runner = require("kafkajs/src/consumer/runner");
const Cluster = require("kafkajs/src/cluster");

for (const stopping of [false, true]) {
  test(`KafkaJS pending crash ${stopping ? "cannot restart after cancellation" : "still restarts while active"}`, async (t) => {
    let runner;
    let starts = 0;
    // Keep KafkaJS's actual crash/restart orchestration; replace only broker work.
    t.mock.method(Runner.prototype, "start", async function () {
      runner = this;
      starts++;
    });
    t.mock.method(Runner.prototype, "stop", async () => {});
    t.mock.method(Cluster.prototype, "disconnect", nextTurn);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const consumer = createKafkaConsumer({
      groupId: "lifecycle-restart-regression",
      brokers: ["127.0.0.1:1"],
      signal: controller.signal,
    });
    t.after(async () => {
      controller.abort();
      await consumer.disconnect();
    });
    await consumer.run();
    const crash = runner.onCrash(
      Object.assign(new Error("Retriable fetch failure"), {
        retriable: true,
        retryTime: 25,
      }),
    );
    if (stopping) controller.abort();
    await consumer.stop();
    await consumer.disconnect();
    assert.equal(starts, 1, "cleanup must finish before the pending restart timer fires");
    await crash;
    t.mock.timers.tick(25);
    assert.equal(starts, stopping ? 1 : 2);
  });
}

test("helper-owned timeout fences a crash that finishes after cleanup", async (t) => {
  let runner;
  let starts = 0;
  let disconnects = 0;
  const initialized = Promise.withResolvers();
  const disconnecting = Promise.withResolvers();
  const releaseCrash = Promise.withResolvers();
  t.mock.method(Runner.prototype, "start", async function () {
    runner = this;
    starts++;
    this.instrumentationEmitter.emit("consumer.group_join", {});
  });
  t.mock.method(Runner.prototype, "stop", async () => {});
  t.mock.method(Cluster.prototype, "connect", async () => {});
  t.mock.method(Cluster.prototype, "addMultipleTargetTopics", async () => {});
  t.mock.method(Cluster.prototype, "disconnect", async () => {
    if (++disconnects === 1) {
      disconnecting.resolve();
      await releaseCrash.promise;
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = runKafkaConsumer({
    groupId: "lifecycle-owned-restart-regression",
    brokers: ["127.0.0.1:1"],
    maxWaitMs: 25,
    onReady: initialized.resolve,
    eachMessage: async () => {
      throw new Error("Unexpected message");
    },
  });
  const rejected = assert.rejects(
    operation,
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((cause) => cause.message === "Kafka consumer timed out"),
  );
  await initialized.promise;
  const crash = runner.onCrash(
    Object.assign(new Error("Retriable fetch failure"), {
      retriable: true,
      retryTime: 25,
    }),
  );
  t.after(async () => {
    releaseCrash.resolve();
    await crash;
  });
  await disconnecting.promise;
  t.mock.timers.tick(25);
  await rejected;
  assert.ok(disconnects >= 2, "helper cleanup must complete while crash disconnect is pending");
  releaseCrash.resolve();
  await crash;
  t.mock.timers.tick(25);
  assert.equal(starts, 1);
});

test("consumer cleanup keeps connection and disconnect failures", async (t) => {
  const connectionError = new Error("broker connection failed");
  const disconnectError = new Error("broker disconnect failed");
  t.mock.method(Cluster.prototype, "connect", async () => {
    throw connectionError;
  });
  t.mock.method(Cluster.prototype, "disconnect", async () => {
    throw disconnectError;
  });
  await assert.rejects(
    runKafkaConsumer({
      groupId: "lifecycle-dual-failure",
      brokers: ["127.0.0.1:1"],
      eachMessage: async () => {
        throw new Error("Unexpected message");
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(connectionError));
      assert.ok(error.errors.includes(disconnectError));
      return true;
    },
  );
});

test("cancelled consumer still reports owned cleanup failures", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const disconnectError = new Error("cancelled consumer disconnect failed");
  t.mock.method(Cluster.prototype, "connect", async () => {
    throw new Error("Cancelled consumer connected");
  });
  t.mock.method(Cluster.prototype, "disconnect", async () => {
    throw disconnectError;
  });
  await assert.rejects(
    runKafkaConsumer({
      groupId: "lifecycle-cancelled-cleanup",
      brokers: ["127.0.0.1:1"],
      signal: controller.signal,
      eachMessage: async () => {
        throw new Error("Unexpected message");
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [disconnectError]);
      return true;
    },
  );
});
