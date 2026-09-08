import assert from "node:assert/strict";
import test from "node:test";
import { captureKafkaCheckpoint } from "../src/recovery.ts";

function broker({ low = "0", high = "10", committed = "10", advance = false } = {}) {
  return {
    async describeCluster() { return { clusterId: "checkpoint-test" }; },
    async listTopics() { return ["app.tasks"]; },
    async describeConfigs() {
      return { resources: [{ resourceName: "app.tasks", errorCode: 0,
        configEntries: [{ configName: "cleanup.policy", configValue: "delete" }] }] };
    },
    async fetchTopicOffsets() {
      const snapshot = [{ partition: 0, low, high }];
      if (advance) high = committed = String(BigInt(high) + 1n);
      return snapshot;
    },
    async fetchOffsets() {
      return [{ topic: "app.tasks", partitions: [{ partition: 0, offset: committed }] }];
    },
  };
}

test("checkpoint remains replayable when publishing and consumption advance during capture", async () => {
  const checkpoint = await captureKafkaCheckpoint(broker({ advance: true }), "logical", "transport", ["app.tasks"]);
  assert.deepEqual(checkpoint.partitions, [{ topic: "app.tasks", partition: 0, low: "0", high: "10", nextOffset: "10" }]);
});

test("checkpoint still refuses committed offsets outside retained history", async () => {
  for (const options of [{ low: "5", committed: "4" }, { high: "10", committed: "11" }, { low: "5", committed: "-1" }]) {
    await assert.rejects(captureKafkaCheckpoint(broker(options), "logical", "transport", ["app.tasks"]));
  }
  const fresh = await captureKafkaCheckpoint(broker({ committed: "-1" }), "logical", "transport", ["app.tasks"]);
  assert.equal(fresh.partitions[0].nextOffset, "0");
});
