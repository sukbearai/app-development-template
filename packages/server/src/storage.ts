import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { deleteS3Object, putS3Object } from "./s3-client";
export type StorageProvider = "local" | "s3";
function localPath(key: string) {
  if (!/^upload_[a-f0-9-]+$/.test(key))
    throw new Error("Invalid managed storage key");
  return path.resolve(env.UPLOAD_STORAGE_DIR, key);
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
    await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { storageKey: input.key, storageProvider: "local" as const };
}
export async function deleteObject(key: string, provider: StorageProvider) {
  if (provider === "s3") return deleteS3Object(key);
  await rm(localPath(key), { force: true });
  await rm(`${localPath(key)}.tmp`, { force: true });
}

export function storageLocation(
  provider: StorageProvider = env.UPLOAD_STORAGE_DRIVER,
) {
  return provider === "local"
    ? path.resolve(env.UPLOAD_STORAGE_DIR)
    : `${env.OBJECT_STORAGE_ENDPOINT}/${env.OBJECT_STORAGE_BUCKET}`;
}
