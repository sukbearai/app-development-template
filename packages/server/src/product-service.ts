import { recordAudit, createOutboxEvent } from "./event-service";
import { requirePermission, requireWritePermission } from "./auth-service";
import { randomUUID } from "node:crypto";
import { fileAssetSchema } from "@pstack/contracts";
import type { AdminSummary, FileAsset, FilePageQuery, TelemetryEvent } from "@pstack/contracts";
import { env } from "./env";
import { logger } from "./logger";
import * as repo from "@pstack/database/repository";
import { putObject, deleteObject, storageLocation } from "./storage";
import { withTransaction } from "@pstack/database/client";
import { assertInMemoryUploadSize } from "./upload-memory-limits";
import { parseInput } from "./validation";

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

export async function storeUploadedFile(input: {
  file: File;
  token: string | undefined;
  traceId: string;
}) {
  const fileName = parseInput(fileAssetSchema.shape.fileName, input.file.name);
  assertInMemoryUploadSize({
    sizeBytes: input.file.size,
    maxBytes: env.UPLOAD_MAX_BYTES,
    label: "文件",
  });
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const id = `file_${randomUUID()}`;
  const intentId = `upload_${randomUUID()}`;
  const provider = env.UPLOAD_STORAGE_DRIVER;
  await withTransaction(async (tx) => {
    await requireWritePermission(input.token, "file.upload", tx);
    await repo.insertUploadIntent(
      {
        id: intentId,
        storageKey: intentId,
        provider,
        storageLocation: storageLocation(provider),
        state: "writing",
        leaseUntil: new Date(Date.now() + 60000),
      },
      tx,
    );
  });
  let writeCompleted = false;
  try {
    const stored = await putObject(
      {
        key: intentId,
        bytes,
        contentType: input.file.type || "application/octet-stream",
      },
      provider,
    );
    writeCompleted = true;
    const asset = await withTransaction(async (tx) => {
      const actor = await requireWritePermission(input.token, "file.upload", tx);
      const intent = await repo.lockUploadIntent(intentId, tx);
      if (
        intent?.state !== "writing" ||
        !intent.leaseUntil ||
        intent.leaseUntil.getTime() <= Date.now()
      )
        throw new Error("Upload intent is no longer writable");
      const asset: FileAsset = {
        id,
        fileName,
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
    await withTransaction(async (tx) => {
      const intent = await repo.lockUploadIntent(intentId, tx);
      if (
        !intent ||
        intent.state === "committed" ||
        (await repo.storageKeyReferenced(intent.storageKey, tx))
      )
        return;
      // An aborted S3 request can still finish remotely. Never delete an uncertain write.
      await repo.setUploadIntentState(
        intentId,
        writeCompleted || provider === "local" ? "cleanup" : "blocked",
        tx,
        writeCompleted || provider === "local" ? null : "upload_outcome_unknown",
      );
    })
      .then(() => reconcileUploadIntent(intentId))
      .catch(() => undefined);
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
    if (intent.state === "deleted") return "deleted";
    if (intent.state === "pending" && intent.provider === "s3") {
      if (!dryRun) await repo.setUploadIntentState(id, "blocked", tx, "upload_outcome_unknown");
      return "upload_outcome_unknown";
    }
    if (intent.state === "writing") {
      if (intent.leaseUntil && intent.leaseUntil.getTime() > Date.now()) return "busy";
      if (!dryRun) await repo.setUploadIntentState(id, "blocked", tx, "upload_outcome_unknown");
      return "upload_outcome_unknown";
    }
    if (intent.state === "blocked" && intent.blockedReason === "upload_outcome_unknown")
      return "upload_outcome_unknown";
    if (intent.storageLocation !== storageLocation(intent.provider)) {
      if (!dryRun) await repo.setUploadIntentState(id, "blocked", tx, "storage_changed");
      return "storage_changed";
    }
    if (dryRun) return "deletable";
    await repo.setUploadIntentState(id, "cleanup", tx);
    await deleteObject(intent.storageKey, intent.provider);
    await repo.setUploadIntentState(id, "deleted", tx);
    return "deleted";
  });
}
export async function resolveBlockedUpload(
  id: string,
  evidence: { writerStopped: true; remoteWriteSettled: true },
) {
  if (!/^upload_[a-f0-9-]+$/.test(id)) throw new Error("Invalid managed upload intent ID");
  if (evidence.writerStopped !== true || evidence.remoteWriteSettled !== true)
    throw new Error("Confirm the uploader is stopped and remote writes are settled before cleanup");
  await withTransaction(async (tx) => {
    const intent = await repo.lockUploadIntent(id, tx);
    if (
      !intent ||
      intent.state === "committed" ||
      (await repo.storageKeyReferenced(intent.storageKey, tx))
    )
      return;
    if (intent.state !== "blocked") throw new Error("Upload is not blocked");
    if (intent.storageLocation !== storageLocation(intent.provider))
      throw new Error("Restore the recorded storage location before cleanup");
    await repo.setUploadIntentState(id, "cleanup", tx);
  });
  return reconcileUploadIntent(id);
}

export async function reconcileUploads(
  options: {
    dryRun?: boolean;
    staleBefore?: Date;
    batchSize?: number;
    maxBatches?: number;
  } = {},
) {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 10;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 100
  )
    throw new Error("Invalid upload cleanup bounds");
  const before = options.staleBefore || new Date(Date.now() - 3600000);
  let cursor: { updatedAt: Date; id: string } | undefined;
  const results: { id: string; state: string }[] = [];
  for (let batch = 0; batch < maxBatches; batch++) {
    const intents = await repo.getStaleUploadIntents(before, batchSize, cursor);
    if (!intents.length) break;
    for (let start = 0; start < intents.length; start += 4) {
      const group = await Promise.all(
        intents.slice(start, start + 4).map(async (intent) => ({
          id: intent.id,
          state: await reconcileUploadIntent(intent.id, options.dryRun).catch(async () => {
            if (!options.dryRun)
              await withTransaction(async (tx) => {
                const current = await repo.lockUploadIntent(intent.id, tx);
                if (
                  current &&
                  current.state !== "committed" &&
                  current.state !== "deleted" &&
                  current.state !== "writing" &&
                  !(await repo.storageKeyReferenced(current.storageKey, tx))
                )
                  await repo.setUploadIntentState(intent.id, "blocked", tx, "cleanup_failed");
              });
            return "cleanup_failed";
          }),
        })),
      );
      results.push(...group);
    }
    const last = intents[intents.length - 1];
    cursor = { updatedAt: last.updatedAt, id: last.id };
    if (intents.length < batchSize) break;
  }
  return results;
}

export async function listFiles(token: string | undefined, query: FilePageQuery) {
  await requirePermission(token, "admin.read");
  return repo.getFileAssetPage(query);
}

export async function listOutboxEvents() {
  return repo.getOutboxEvents();
}

export async function adminSummary(): Promise<AdminSummary> {
  return repo.getAdminCounts();
}
