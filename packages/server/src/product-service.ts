import { requireWritePermission } from "./auth-service";
import { randomUUID } from "node:crypto";
import type {
  AdminSummary,
  AuditEvent,
  FileAsset,
  OutboxEvent,
  TelemetryEvent,
} from "@pstack/contracts";
import { env } from "./env";
import { logger } from "./logger";
import * as repo from "@pstack/database/repository";
import { putObject, deleteObject, storageLocation } from "./storage";
import {
  withTransaction,
  type TransactionContext,
} from "@pstack/database/client";
import { assertInMemoryUploadSize } from "./upload-memory-limits";

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
    await repo.insertAuditEvent(event, context);
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

export async function listAuditEvents() {
  return repo.getAuditEvents();
}

export async function recordTelemetry(
  input: Omit<TelemetryEvent, "id" | "occurredAt">,
) {
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

export async function storeUploadedFile(input: {
  file: File;
  token: string | undefined;
  traceId: string;
}) {
  assertInMemoryUploadSize({
    sizeBytes: input.file.size,
    maxBytes: env.UPLOAD_MAX_BYTES,
    label: "文件",
  });
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const id = `file_${randomUUID()}`;
  const intentId = `upload_${randomUUID()}`;
  const provider = env.UPLOAD_STORAGE_DRIVER;
  await withTransaction((tx) =>
    repo.insertUploadIntent(
      {
        id: intentId,
        storageKey: intentId,
        provider,
        storageLocation: storageLocation(provider),
      },
      tx,
    ),
  );
  try {
    const asset = await withTransaction(async (tx) => {
      const actor = await requireWritePermission(
        input.token,
        "file.upload",
        tx,
      );
      const intent = await repo.lockUploadIntent(intentId, tx);
      if (intent?.state !== "pending")
        throw new Error("Upload intent is no longer writable");
      const stored = await putObject(
        {
          key: intentId,
          bytes,
          contentType: input.file.type || "application/octet-stream",
        },
        provider,
      );
      const asset: FileAsset = {
        id,
        fileName: input.file.name,
        mimeType: input.file.type || "application/octet-stream",
        sizeBytes: bytes.length,
        storageKey: stored.storageKey,
        uploadedBy: actor.id,
        uploadedAt: new Date().toISOString(),
      };
      await repo.insertFileAsset(asset, tx);
      await recordAudit(
        {
          actorId: actor.id,
          action: "file.uploaded",
          targetType: "file",
          targetId: id,
          traceId: input.traceId,
        },
        tx,
      );
      await createOutboxEvent(
        {
          topic: "files.events",
          eventType: "file.uploaded",
          payload: {
            fileId: id,
            fileName: asset.fileName,
            storageProvider: stored.storageProvider,
          },
          traceId: input.traceId,
        },
        tx,
      );
      await repo.setUploadIntentState(intentId, "committed", tx);
      return asset;
    });
    logger.info("file uploaded", { fileId: id, sizeBytes: bytes.length });
    return asset;
  } catch (error) {
    // Retain intent if reconciliation also fails; retries use the same managed key.
    await reconcileUploadIntent(intentId).catch(() => undefined);
    throw error;
  }
}

export async function reconcileUploadIntent(id: string, dryRun = false) {
  return withTransaction(async (tx) => {
    const intent = await repo.lockUploadIntent(id, tx);
    if (
      !intent ||
      intent.state === "committed" ||
      (await repo.storageKeyReferenced(intent.storageKey, tx))
    )
      return "protected";
    if (intent.storageLocation !== storageLocation(intent.provider))
      return "storage_changed";
    if (dryRun) return "deletable";
    await repo.setUploadIntentState(id, "cleanup", tx);
    await deleteObject(intent.storageKey, intent.provider);
    await repo.setUploadIntentState(id, "deleted", tx);
    return "deleted";
  });
}
export async function reconcileUploads(
  options: { dryRun?: boolean; staleBefore?: Date } = {},
) {
  const intents = await repo.getStaleUploadIntents(
    options.staleBefore || new Date(Date.now() - 3600000),
  );
  return Promise.all(
    intents.map(async (intent) => ({
      id: intent.id,
      state: await reconcileUploadIntent(intent.id, options.dryRun),
    })),
  );
}

export async function listFiles() {
  return repo.getFileAssets();
}

export async function createOutboxEvent(
  input: {
    topic: string;
    eventType: string;
    payload: Record<string, unknown>;
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
    maxAttempts: 5,
    nextAttemptAt: now,
    traceId: input.traceId,
    createdAt: now,
    updatedAt: now,
  };
  if (tx) await repo.insertOutboxEvent(event, tx);
  else
    await withTransaction((context) => repo.insertOutboxEvent(event, context));
  return event;
}

export async function listOutboxEvents() {
  return repo.getOutboxEvents();
}

export async function adminSummary(): Promise<AdminSummary> {
  return repo.getAdminCounts();
}
