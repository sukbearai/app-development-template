import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env";
let client: S3Client | undefined;
function getClient() {
  if (
    !env.OBJECT_STORAGE_ENDPOINT ||
    !env.OBJECT_STORAGE_ACCESS_KEY ||
    !env.OBJECT_STORAGE_SECRET_KEY
  )
    throw new Error("S3 configuration is incomplete");
  client ??= new S3Client({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION,
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY,
    },
    // A retried PUT can succeed while an earlier disconnected attempt still writes.
    maxAttempts: 1,
  });
  return client;
}
export async function putS3Object(input: {
  key: string;
  bytes: Buffer;
  contentType: string;
}) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.OBJECT_STORAGE_BUCKET,
      Key: input.key,
      Body: input.bytes,
      ContentType: input.contentType,
    }),
    { abortSignal: AbortSignal.timeout(10000) },
  );
  return { storageKey: input.key, storageProvider: "s3" as const };
}
export async function deleteS3Object(key: string) {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: env.OBJECT_STORAGE_BUCKET, Key: key }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
}
export async function headS3Object(key: string) {
  return getClient().send(
    new HeadObjectCommand({ Bucket: env.OBJECT_STORAGE_BUCKET, Key: key }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
}
export async function probeS3() {
  await getClient().send(
    new HeadBucketCommand({ Bucket: env.OBJECT_STORAGE_BUCKET }),
    { abortSignal: AbortSignal.timeout(3000) },
  );
}
export function closeS3() {
  client?.destroy();
  client = undefined;
}
