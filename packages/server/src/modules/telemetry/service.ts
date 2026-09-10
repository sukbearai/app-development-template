import * as repo from "@pstack/database/modules/telemetry/repository";
import { createOutboxEvent } from "../../event-service";
import { randomUUID } from "node:crypto";
import type { TelemetryEvent } from "@pstack/contracts/modules/telemetry/contracts";
import { withTransaction } from "@pstack/database/client";

export async function recordTelemetry(input: Omit<TelemetryEvent, "id" | "occurredAt">) {
  const event: TelemetryEvent = {
    id: `tel_${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    ...input,
  };
  await withTransaction(async (tx) => {
    await repo.insertTelemetryEvent(event, tx);
    await createOutboxEvent(
      {
        topic: "telemetry.events",
        eventType: "telemetry.recorded",
        payload: { eventId: event.id, event: event.event, route: event.route },
        traceId: event.traceId,
      },
      tx,
    );
  });
  return event;
}

export async function listTelemetryEvents() {
  return repo.getTelemetryEvents();
}
