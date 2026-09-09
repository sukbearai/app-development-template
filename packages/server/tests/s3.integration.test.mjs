import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { S3Client, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "real MinIO upload, HEAD, failed commit compensation and reference protection",
  { timeout: 120000 },
  async () => {
    const suffix = randomUUID();
    const pgName = `pstack-s3-pg-${suffix}`;
    const minioName = `pstack-s3-${suffix}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      pgName,
      "-e",
      "POSTGRES_PASSWORD=isolated-test-only",
      "-e",
      "POSTGRES_DB=s3_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bullseye",
    );
    let s3, closeDatabase, closeS3;
    try {
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        minioName,
        "-e",
        "MINIO_ROOT_USER=isolated-test-user",
        "-e",
        "MINIO_ROOT_PASSWORD=isolated-test-password",
        "-p",
        "127.0.0.1::9000",
        "minio/minio:RELEASE.2025-04-22T22-12-26Z",
        "server",
        "/data",
      );
      process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${docker("port", pgName, "5432/tcp").split(":").at(-1)}/s3_test`;
      process.env.UPLOAD_STORAGE_DRIVER = "s3";
      process.env.OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${docker("port", minioName, "9000/tcp").split(":").at(-1)}`;
      process.env.OBJECT_STORAGE_ACCESS_KEY = "isolated-test-user";
      process.env.OBJECT_STORAGE_SECRET_KEY = "isolated-test-password";
      process.env.OBJECT_STORAGE_BUCKET = "integration-files";
      process.env.OBJECT_STORAGE_FORCE_PATH_STYLE = "true";
      const database = await import("@pstack/database/client");
      closeDatabase = database.closeDatabase;
      for (let i = 0; i < 40; i++) {
        try {
          await database.getPool().query("select 1");
          break;
        } catch {
          await pause(250);
        }
      }
      execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        env: process.env,
        encoding: "utf8",
      });
      s3 = new S3Client({
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
        },
      });
      for (let i = 0; i < 40; i++) {
        try {
          await s3.send(new CreateBucketCommand({ Bucket: "integration-files" }));
          break;
        } catch (error) {
          if (i === 39) throw error;
          await pause(250);
        }
      }
      const storage = await import("../src/s3-client.ts");
      closeS3 = storage.closeS3;
      const product = await import("../src/product-service.ts");
      const { bootstrapAdministrator } = await import("../src/bootstrap-admin.ts");
      const { login } = await import("../src/auth-service.ts");
      const credentials = {
        account: "s3-admin",
        password: "s3-strong-test-password",
      };
      await bootstrapAdministrator(credentials);
      const token = (await login(credentials)).token;
      await storage.probeS3();
      const asset = await product.storeUploadedFile({
        token,
        file: new File(["persistent-bytes"], "asset.txt"),
        traceId: "s3-success",
      });
      assert.equal((await storage.headS3Object(asset.storageKey)).ContentLength, 16);
      assert.equal(await product.reconcileUploadIntent(asset.storageKey), "protected");
      await database
        .getPool()
        .query(
          "create function test_reject_asset() returns trigger language plpgsql as $$ begin raise exception 'injected metadata failure'; end $$; create trigger test_reject_asset before insert on app_file_assets for each row execute function test_reject_asset()",
        );
      await assert.rejects(
        product.storeUploadedFile({
          token,
          file: new File(["orphan"], "orphan.txt"),
          traceId: "s3-failed",
        }),
      );
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: "integration-files" }));
      assert.deepEqual(
        listed.Contents.map((item) => item.Key),
        [asset.storageKey],
      );
      const intent = (
        await database.getPool().query("select state from app_upload_intents where state='deleted'")
      ).rows;
      assert.equal(intent.length, 1);
      const { checkInfrastructure } = await import("../src/infrastructure.ts");
      const health = await checkInfrastructure();
      assert.equal(health.database, "ok");
      assert.equal(health.objectStorage, "ok");
    } finally {
      closeS3?.();
      s3?.destroy();
      await closeDatabase?.();
      try {
        docker("rm", "-f", minioName);
      } finally {
        docker("rm", "-f", pgName);
      }
    }
  },
);
