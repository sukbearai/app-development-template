import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsPromises, { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { S3Client, CreateBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test(
  "isolated PostgreSQL and MinIO uploads release identity lock, fence cleanup, paginate mixed locations, and retain duplicate proof",
  { timeout: 120000 },
  async (t) => {
    const suffix = randomUUID(),
      pgName = `pstack-prod-pg-${suffix}`,
      s3Name = `pstack-prod-s3-${suffix}`;
    const storageParent = await mkdtemp(path.join(os.tmpdir(), "pstack-durable-"));
    const directory = path.join(storageParent, "new-parent", "new-root");
    let database, s3, storageClient, proxy;
    let hold;
    try {
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        pgName,
        "-e",
        "POSTGRES_PASSWORD=isolated-test-only",
        "-e",
        "POSTGRES_DB=production_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-bullseye",
      );
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        s3Name,
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
      const port = docker("port", s3Name, "9000/tcp").split(":").at(-1);
      proxy = http.createServer(async (req, res) => {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        const active = req.method === "PUT" && req.url.includes("upload_") ? hold : undefined;
        if (active?.before) {
          active.started.resolve();
          await active.release.promise;
        }
        const upstream = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          async (response) => {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            if (active && !active.before) {
              active.started.resolve();
              await active.release.promise;
            }
            res.writeHead(response.statusCode, response.headers);
            res.end(Buffer.concat(chunks));
          },
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end();
        });
        upstream.end(Buffer.concat(body));
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      Object.assign(process.env, {
        DATABASE_URL: `postgres://postgres:isolated-test-only@127.0.0.1:${docker("port", pgName, "5432/tcp").split(":").at(-1)}/production_test`,
        NODE_ENV: "test",
        UPLOAD_STORAGE_DRIVER: "s3",
        UPLOAD_STORAGE_DIR: directory,
        OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${proxy.address().port}`,
        OBJECT_STORAGE_ACCESS_KEY: "isolated-test-user",
        OBJECT_STORAGE_SECRET_KEY: "isolated-test-password",
        OBJECT_STORAGE_BUCKET: "production-files",
        OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      });
      database = await import("@pstack/database/client");
      for (let n = 0; n < 40; n++) {
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
          accessKeyId: "isolated-test-user",
          secretAccessKey: "isolated-test-password",
        },
      });
      for (let n = 0; n < 40; n++) {
        try {
          await s3.send(new CreateBucketCommand({ Bucket: "production-files" }));
          break;
        } catch (error) {
          if (n === 39) throw error;
          await pause(250);
        }
      }
      const auth = await import("../src/auth-service.ts"),
        product = await import("../src/product-service.ts"),
        storage = await import("../src/storage.ts");
      storageClient = await import("../src/s3-client.ts");
      const repo = await import("@pstack/database/repository");
      const { bootstrapAdministrator } = await import("../src/bootstrap-admin.ts");
      const credentials = {
        account: "production-admin",
        password: "production-strong-password",
      };
      await bootstrapAdministrator(credentials);
      const query = (sql, args = []) => database.getPool().query(sql, args);
      await t.test(
        "new nested storage directories sync every parent; unlink syncs before returning",
        async () => {
          const key = `upload_${randomUUID()}`;
          const operations = [];
          const realOpen = fsPromises.open,
            realRename = fsPromises.rename,
            realRm = fsPromises.rm;
          fsPromises.open = async (...args) => {
            const handle = await realOpen(...args);
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              await sync();
              operations.push(
                args[0] === path.join(directory, `${key}.tmp`)
                  ? "file sync"
                  : `directory sync ${args[0]}`,
              );
            };
            return handle;
          };
          fsPromises.rename = async (...args) => {
            await realRename(...args);
            operations.push("rename");
          };
          fsPromises.rm = async (...args) => {
            await realRm(...args);
            operations.push(`unlink ${args[0]}`);
          };
          syncBuiltinESMExports();
          try {
            await storage.putObject(
              {
                key,
                bytes: Buffer.from("durable bytes"),
                contentType: "text/plain",
              },
              "local",
            );
            const parentSyncs = [];
            for (let current = directory; ; current = path.dirname(current)) {
              parentSyncs.push(`directory sync ${current}`);
              if (path.dirname(current) === current) break;
            }
            assert.deepEqual(operations, [
              "file sync",
              "rename",
              ...parentSyncs,
              `unlink ${path.join(directory, `${key}.tmp`)}`,
            ]);
            assert.equal(await readFile(path.join(directory, key), "utf8"), "durable bytes");
            assert.deepEqual(await readdir(directory), [key]);
            operations.length = 0;
            await storage.deleteObject(key, "local");
            assert.deepEqual(operations, [
              `unlink ${path.join(directory, key)}`,
              `unlink ${path.join(directory, `${key}.tmp`)}`,
              `directory sync ${directory}`,
            ]);
            assert.deepEqual(await readdir(directory), []);
          } finally {
            fsPromises.open = realOpen;
            fsPromises.rename = realRename;
            fsPromises.rm = realRm;
            syncBuiltinESMExports();
          }
        },
      );
      await t.test(
        "logout completes while real S3 response is delayed; final authorization refuses commit",
        async () => {
          const token = (await auth.login(credentials)).token;
          hold = { started: deferred(), release: deferred() };
          const upload = product.storeUploadedFile({
            token,
            file: new File(["slow bytes"], "slow.txt"),
            traceId: "slow",
          });
          const rejection = assert.rejects(upload, (error) => error.status === 401);
          await hold.started.promise;
          const [intent] = (await query("select * from app_upload_intents where state='writing'"))
            .rows;
          assert.equal(await product.reconcileUploadIntent(intent.id), "busy");
          await Promise.race([
            auth.logout(token),
            pause(1500).then(() => {
              throw new Error("logout blocked by upload");
            }),
          ]);
          hold.release.resolve();
          hold = undefined;
          await rejection;
          assert.equal((await query("select count(*) from app_file_assets")).rows[0].count, "0");
          assert.equal(
            (await query("select state from app_upload_intents where id=$1", [intent.id])).rows[0]
              .state,
            "deleted",
          );
          await assert.rejects(
            s3.send(
              new HeadObjectCommand({
                Bucket: "production-files",
                Key: intent.id,
              }),
            ),
          );
        },
      );
      await t.test(
        "lease expiry blocks deletion until operator confirms remote write completion",
        async () => {
          const token = (await auth.login(credentials)).token;
          hold = { started: deferred(), release: deferred() };
          const upload = product.storeUploadedFile({
            token,
            file: new File(["lease bytes"], "lease.txt"),
            traceId: "lease",
          });
          const rejection = assert.rejects(upload, /no longer writable/);
          await hold.started.promise;
          const [intent] = (await query("select * from app_upload_intents where state='writing'"))
            .rows;
          await query(
            "update app_upload_intents set lease_until=now()-interval '1 second' where id=$1",
            [intent.id],
          );
          assert.equal(await product.reconcileUploadIntent(intent.id), "upload_outcome_unknown");
          assert.equal(
            (
              await s3.send(
                new HeadObjectCommand({
                  Bucket: "production-files",
                  Key: intent.id,
                }),
              )
            ).ContentLength,
            11,
          );
          hold.release.resolve();
          hold = undefined;
          await rejection;
          assert.equal(
            (await query("select state from app_upload_intents where id=$1", [intent.id])).rows[0]
              .state,
            "deleted",
          );
          const key = `upload_${randomUUID()}`;
          await storage.putObject(
            { key, bytes: Buffer.from("uncertain"), contentType: "text/plain" },
            "s3",
          );
          await query(
            "insert into app_upload_intents(id,storage_key,provider,storage_location,state,blocked_reason) values($1,$1,'s3',$2,'blocked','upload_outcome_unknown')",
            [key, storage.storageLocation("s3")],
          );
          assert.equal(await product.reconcileUploadIntent(key), "upload_outcome_unknown");
          assert.equal(
            await product.resolveBlockedUpload(key, {
              writerStopped: true,
              remoteWriteSettled: true,
            }),
            "deleted",
          );
        },
      );
      await t.test(
        "a PUT that completes after client abort stays tracked until explicit resolution",
        async () => {
          const token = (await auth.login(credentials)).token;
          hold = { started: deferred(), release: deferred(), before: true };
          const upload = product.storeUploadedFile({
            token,
            file: new File(["late bytes"], "late.txt"),
            traceId: "late",
          });
          const rejection = assert.rejects(upload);
          await hold.started.promise;
          const [intent] = (await query("select * from app_upload_intents where state='writing'"))
            .rows;
          await rejection;
          assert.equal(
            (
              await query("select state,blocked_reason from app_upload_intents where id=$1", [
                intent.id,
              ])
            ).rows[0].blocked_reason,
            "upload_outcome_unknown",
          );
          hold.release.resolve();
          hold = undefined;
          for (let n = 0; n < 40; n++) {
            try {
              assert.equal(
                (
                  await s3.send(
                    new HeadObjectCommand({
                      Bucket: "production-files",
                      Key: intent.id,
                    }),
                  )
                ).ContentLength,
                10,
              );
              break;
            } catch (error) {
              if (n === 39) throw error;
              await pause(100);
            }
          }
          assert.equal(await product.reconcileUploadIntent(intent.id), "upload_outcome_unknown");
          assert.equal(
            await product.resolveBlockedUpload(intent.id, {
              writerStopped: true,
              remoteWriteSettled: true,
            }),
            "deleted",
          );
          await assert.rejects(
            s3.send(
              new HeadObjectCommand({
                Bucket: "production-files",
                Key: intent.id,
              }),
            ),
          );
        },
      );
      await t.test(
        "more than 100 stale mismatched locations do not starve valid cleanup",
        async () => {
          await query(
            "insert into app_upload_intents(id,storage_key,provider,storage_location,updated_at) select 'upload_'||md5(i::text),'upload_'||md5(i::text),'local','/unavailable/previous-location',now()-interval '3 hours' from generate_series(1,105) i",
          );
          const key = `upload_${randomUUID()}`;
          await storage.putObject(
            { key, bytes: Buffer.from("cleanup"), contentType: "text/plain" },
            "local",
          );
          await query(
            "insert into app_upload_intents(id,storage_key,provider,storage_location,updated_at) values($1,$1,'local',$2,now()-interval '2 hours')",
            [key, storage.storageLocation("local")],
          );
          const result = await product.reconcileUploads();
          assert.equal(result.filter((row) => row.state === "storage_changed").length, 105);
          assert.equal(result.find((row) => row.id === key).state, "deleted");
          assert.equal(
            (
              await query(
                "select count(*) from app_upload_intents where state='blocked' and blocked_reason='storage_changed'",
              )
            ).rows[0].count,
            "105",
          );
          assert.deepEqual(await product.reconcileUploads(), []);
        },
      );
      await t.test(
        "bounded retention preserves permanent hashes, task rows and unexpired keys",
        async () => {
          await query(
            "insert into app_tasks(id,task_type,status,trace_id,updated_at) values('terminal','test','succeeded','t',now()-interval '90 days'),('retry','test','dead_letter','t',now()-interval '90 days')",
          );
          await query(
            "insert into app_task_events(id,task_id,trace_id,event_type,created_at) values('old-terminal','terminal','t','done',now()-interval '90 days'),('old-retry','retry','t','failed',now()-interval '90 days')",
          );
          const v2Hash = `v2:${"a".repeat(64)}`;
          const legacyHash = "b".repeat(64);
          await query(
            "insert into app_idempotency_keys(key,scope,request_hash,response_data,status,created_at,expires_at) values('compact','scope',$1,'{\"large\":true}','succeeded',now()-interval '90 days',now()-interval '1 day'),('unexpired','scope',$1,'{\"large\":true}','succeeded',now()-interval '90 days',now()+interval '1 day'),('legacy','scope',$2,'{\"large\":true}','succeeded',now()-interval '90 days',now()-interval '1 day'),('unknown','scope','v3:unknown','{\"large\":true}','succeeded',now()-interval '90 days',now()-interval '1 day'),('malformed-v2','scope','v2:bad','{\"large\":true}','succeeded',now()-interval '90 days',now()-interval '1 day')",
            [v2Hash, legacyHash],
          );
          await query(
            "insert into app_async_receipts(idempotency_key,task_id,consumer_group,event_type,payload_hash,result,created_at) values('compact','terminal','group','test',$1,'{\"large\":true}',now()-interval '90 days')",
            [v2Hash],
          );
          await query(
            "insert into app_telemetry_events(id,event,trace_id,occurred_at) select 'old-tel-'||i,'old','t',now()-interval '90 days' from generate_series(1,3) i",
          );
          const options = {
            before: new Date(Date.now() - 30 * 86400000),
            batchSize: 2,
            dryRun: true,
          };
          const preview = await repo.runRetention(options);
          assert.equal(preview.telemetry, 2);
          assert.equal(preview.idempotency, 1);
          assert.equal(preview.taskEvents, 1);
          assert.deepEqual(await repo.runRetention({ ...options, dryRun: false }), preview);
          const [receipt] = (
            await query("select * from app_async_receipts where idempotency_key='compact'")
          ).rows;
          assert.equal(receipt.payload_hash, v2Hash);
          assert.deepEqual(receipt.result, {});
          assert.equal(
            (await query("select response_data from app_idempotency_keys where key='compact'"))
              .rows[0].response_data,
            null,
          );
          assert.notEqual(
            (await query("select response_data from app_idempotency_keys where key='unexpired'"))
              .rows[0].response_data,
            null,
          );
          const retained = (
            await query(
              "select key,request_hash,response_data from app_idempotency_keys where key in ('legacy','unknown','malformed-v2') order by key",
            )
          ).rows;
          assert.equal(retained.length, 3);
          assert.equal(retained.find((row) => row.key === "legacy").request_hash, legacyHash);
          for (const row of retained) assert.deepEqual(row.response_data, { large: true });
          assert.equal(
            (await query("select count(*) from app_task_events where id='old-retry'")).rows[0]
              .count,
            "1",
          );
          assert.equal((await repo.runRetention({ ...options, dryRun: false })).telemetry, 1);
        },
      );
      await t.test("health returns aggregated buckets with real counts", async () => {
        const rows = await repo.getAsyncRuntimeHealthRows();
        assert.equal(rows.tasks.find((row) => row.status === "succeeded").count, 1);
        assert.equal(rows.tasks.length, 2);
        assert.ok(
          rows.outboxEvents.length <
            (await query("select count(*) from app_outbox_events")).rows[0].count,
        );
      });
    } finally {
      hold?.release.resolve();
      storageClient?.closeS3();
      s3?.destroy();
      proxy?.closeAllConnections();
      if (proxy) await new Promise((resolve) => proxy.close(resolve));
      await database?.closeDatabase();
      try {
        docker("rm", "-f", s3Name);
      } finally {
        docker("rm", "-f", pgName);
        await rm(storageParent, { recursive: true, force: true });
      }
    }
  },
);
