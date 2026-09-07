import { Pool } from "pg";
import { Kafka, logLevel } from "kafkajs";
import { claimEvents, outboxKafkaMessageValue } from "../../src/outbox.ts";
const pool = new Pool({
  connectionString: process.env.WORKER_TEST_DATABASE_URL,
});
const client = await pool.connect();
const [event] = await claimEvents(client, {
  workerId: "crashed",
  batchSize: 1,
  leaseMs: 300,
});
client.release();
if (!event) throw new Error("No crash probe event");
const producer = new Kafka({
  clientId: "crash-probe",
  brokers: process.env.WORKER_TEST_KAFKA_BROKERS.split(","),
  logLevel: logLevel.NOTHING,
}).producer();
await producer.connect();
await producer.send({
  topic: event.topic,
  messages: [{ value: outboxKafkaMessageValue(event) }],
});
process.send({ sent: event.id });
await new Promise(() => {});
