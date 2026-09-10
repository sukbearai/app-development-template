import type {
  FileAsset,
  FileAssetPage,
  FilePageQuery,
} from "@pstack/contracts/modules/uploads/contracts";

import { type TransactionContext, getDatabase, type DatabaseContext } from "../../client";

import { appFileAssets, appUploadIntents } from "../../schema";

import { sql, eq, and, asc, lte } from "drizzle-orm";

import { iso } from "../../row-values.ts";

export async function insertFileAsset(file: FileAsset, context: TransactionContext) {
  await context.insert(appFileAssets).values({
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    storageKey: file.storageKey,
    uploadedBy: file.uploadedBy,
    uploadedAt: new Date(file.uploadedAt),
  });
}

export async function getFileAssetPage(
  query: FilePageQuery,
  context: DatabaseContext = getDatabase(),
): Promise<FileAssetPage> {
  const rows = await context
    .select({
      file: appFileAssets,
      cursorTime: sql<string>`to_char(${appFileAssets.uploadedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(appFileAssets)
    .where(
      query.cursor
        ? sql`(${appFileAssets.uploadedAt}, ${appFileAssets.id}) < (${query.cursor.uploadedAt}::timestamptz, ${query.cursor.id})`
        : undefined,
    )
    .orderBy(
      sql`${appFileAssets.uploadedAt} desc nulls last`,
      sql`${appFileAssets.id} desc nulls last`,
    )
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ file }): FileAsset => ({
      ...file,
      uploadedBy: file.uploadedBy || undefined,
      uploadedAt: iso(file.uploadedAt),
    })),
    nextCursor:
      rows.length > query.limit && last ? { uploadedAt: last.cursorTime, id: last.file.id } : null,
  };
}

export async function insertUploadIntent(
  input: typeof appUploadIntents.$inferInsert,
  tx: TransactionContext,
) {
  await tx.insert(appUploadIntents).values(input);
}

export async function lockUploadIntent(id: string, tx: TransactionContext) {
  return (
    await tx.select().from(appUploadIntents).where(eq(appUploadIntents.id, id)).for("update")
  )[0];
}

export async function setUploadIntentState(
  id: string,
  state: (typeof appUploadIntents.$inferSelect)["state"],
  tx: TransactionContext,
  blockedReason: string | null = null,
) {
  await tx
    .update(appUploadIntents)
    .set({ state, blockedReason, updatedAt: new Date() })
    .where(eq(appUploadIntents.id, id));
}

export async function getStaleUploadIntents(
  before: Date,
  limit = 100,
  cursor?: { updatedAt: Date; id: string },
) {
  return getDatabase()
    .select()
    .from(appUploadIntents)
    .where(
      and(
        lte(appUploadIntents.updatedAt, before),
        sql`${appUploadIntents.state} in ('pending','writing','cleanup')`,
        cursor
          ? sql`(${appUploadIntents.updatedAt}, ${appUploadIntents.id}) > (${cursor.updatedAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(asc(appUploadIntents.updatedAt), asc(appUploadIntents.id))
    .limit(limit);
}

export async function storageKeyReferenced(storageKey: string, tx: TransactionContext) {
  return (
    (
      await tx
        .select({ id: appFileAssets.id })
        .from(appFileAssets)
        .where(eq(appFileAssets.storageKey, storageKey))
        .limit(1)
    ).length > 0
  );
}
