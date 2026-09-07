import type { AsyncConsumerHandler } from "./async-consumer";

/** Database receipt projection only. External side effects require receiver-owned idempotency. */
export const handleDomainEvent: AsyncConsumerHandler = async (task) => {
  switch (task.taskType) {
    case "demo.echo":
      return { kind: "echo", value: task.payload };
    case "telemetry.recorded":
    case "telemetry.created":
    case "audit.recorded":
    case "file.uploaded":
    case "files.uploaded":
      return {
        kind: "event_receipt",
        sourceEventId: task.sourceEventId,
        eventType: task.taskType,
        payload: task.payload,
      };
    default:
      throw new Error(`Unsupported async event type: ${task.taskType}`);
  }
};
