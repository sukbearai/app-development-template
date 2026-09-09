import { Kafka } from "kafkajs";
import { getPool } from "@pstack/database/client";
import { runAsyncRuntime, runOutboxLoop } from "../../src/async-runtime.ts";

const mode = process.argv[2];
const pool = getPool();
if (mode === "connect-reject-hang" || mode === "consumer-no-join") {
  process.env.OUTBOX_PUBLISHER = "kafka";
  process.env.OUTBOX_DRY_RUN = "0";
  process.env.KAFKA_BROKERS = process.env.WORKER_TEST_KAFKA_BROKERS;
}
if (mode === "consumer-no-join") {
  const allocate = Kafka.prototype.consumer;
  Kafka.prototype.consumer = function (...args) {
    const consumer = allocate.apply(this, args);
    // KafkaJS can resolve run while a failed group join schedules a restart.
    consumer.run = async () => {
      process.stdout.write("run returned without group join\n");
    };
    return consumer;
  };
}
if (mode === "connect-reject-hang") {
  const allocate = Kafka.prototype.admin;
  Kafka.prototype.admin = function (...args) {
    const admin = allocate.apply(this, args);
    admin.connect = async () => {
      process.stdout.write("connect rejected\n");
      throw new Error("Fixture connect rejection");
    };
    admin.disconnect = async () => {
      process.stdout.write("disconnect pending\n");
      await new Promise(() => {});
    };
    return admin;
  };
}
if (mode === "cleanup-hang" || mode === "falsy-hang" || mode === "cleanup-reject-live") {
  // An unreleased real PostgreSQL client keeps Pool.end pending.
  await pool.connect();
} else if (mode === "cleanup-failure") {
  await pool.end();
}
if (mode === "cleanup-reject-live") {
  pool.end = async () => {
    throw new Error("Fixture disconnect rejection with checked-out client");
  };
}
if (mode === "falsy-failure" || mode === "falsy-hang") {
  pool.query = async () => {
    throw undefined;
  };
}
try {
  if (mode === "consumer-no-join") await runAsyncRuntime([]);
  else await runOutboxLoop(["--iterations", "1"]);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      errorCount: error.errors.length,
      undefinedFailure: error.errors.includes(undefined),
    })}\n`,
  );
  process.exitCode = 1;
}
