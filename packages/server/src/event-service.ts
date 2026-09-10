import { randomUUID } from "node:crypto";
import type { AuditEvent } from "@pstack/contracts/modules/audit/contracts";
import type { OutboxEvent } from "@pstack/contracts/modules/outbox/contracts";
import * as repo_audit from "@pstack/database/modules/audit/repository";
import * as repo_outbox from "@pstack/database/modules/outbox/repository";
import { withTransaction, type TransactionContext } from "@pstack/database/client";
import { env } from "./env";

export async function recordAudit(
  input: Omit<AuditEvent, "id" | "createdAt">,
  tx?: TransactionContext,
) {
  const event: AuditEvent = {
    id: `audit_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input,
  };
  const persist = async (context: TransactionContext) => {
    await repo_audit.insertAuditEvent(event, context);
    await createOutboxEvent(
      {
        topic: "audit.events",
        eventType: "audit.recorded",
        payload: {
          auditId: event.id,
          action: event.action,
          actorId: event.actorId,
        },
        traceId: event.traceId,
      },
      context,
    );
  };
  if (tx) await persist(tx);
  else await withTransaction(persist);
  return event;
}

export async function createOutboxEvent(
  input: {
    topic: string;
    eventType: string;
    payload: OutboxEvent["payload"];
    traceId: string;
  },
  tx?: TransactionContext,
) {
  const now = new Date().toISOString();
  const event: OutboxEvent = {
    id: `evt_${randomUUID()}`,
    topic: input.topic,
    eventType: input.eventType,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    nextAttemptAt: now,
    traceId: input.traceId,
    createdAt: now,
    updatedAt: now,
  };
  if (tx) await repo_outbox.insertOutboxEvent(event, tx);
  else await withTransaction((context) => repo_outbox.insertOutboxEvent(event, context));
  return event;
}
