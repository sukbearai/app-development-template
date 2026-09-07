import { mkdir, rename, rm, open } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { deleteS3Object, putS3Object } from "./s3-client";
export type StorageProvider = "local" | "s3";
function localPath(key: string) {
  if (!/^upload_[a-f0-9-]+$/.test(key))
    throw new Error("Invalid managed storage key");
  return path.resolve(env.UPLOAD_STORAGE_DIR, key);
}
async function syncDirectory(directoryPath: string) {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function syncDirectoryAncestors(directoryPath: string) {
  // Another upload may have created a directory that is not durable yet.
  for (let current = directoryPath; ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (path.dirname(current) === current) return;
  }
}

export async function putObject(
  input: { key: string; bytes: Buffer; contentType: string },
  provider: StorageProvider = env.UPLOAD_STORAGE_DRIVER,
) {
  if (provider === "s3") return putS3Object(input);
  const destination = localPath(input.key);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(input.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    await syncDirectoryAncestors(path.dirname(destination));
  } finally {
    await rm(temporary, { force: true });
  }
  return { storageKey: input.key, storageProvider: "local" as const };
}
export async function deleteObject(key: string, provider: StorageProvider) {
  if (provider === "s3") return deleteS3Object(key);
  await rm(localPath(key), { force: true });
  await rm(`${localPath(key)}.tmp`, { force: true });
  await syncDirectory(path.dirname(localPath(key)));
}

export function storageLocation(
  provider: StorageProvider = env.UPLOAD_STORAGE_DRIVER,
) {
  return provider === "local"
    ? path.resolve(env.UPLOAD_STORAGE_DIR)
    : `${env.OBJECT_STORAGE_ENDPOINT}/${env.OBJECT_STORAGE_BUCKET}`;
}
