import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
const workspace = path.resolve(import.meta.dirname, "../../../..");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "PostgreSQL identity, atomic events and durable upload reconciliation",
  { timeout: 120000 },
  async (t) => {
    const name = `pstack-server-${randomUUID()}`;
    const storage = await mkdtemp(path.join(os.tmpdir(), "pstack-storage-"));
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=isolated-test-only",
      "-e",
      "POSTGRES_DB=pstack_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bullseye",
    );
    const port = docker("port", name, "5432/tcp").split(":").at(-1);
    process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${port}/pstack_test`;
    process.env.UPLOAD_STORAGE_DIR = storage;
    process.env.NODE_ENV = "test";
    process.env.OUTBOX_MAX_ATTEMPTS = "2";
    const { getPool, closeDatabase, withTransaction } = await import("@pstack/database/client");
    try {
      for (let i = 0; i < 40; i++) {
        try {
          await getPool().query("select 1");
          break;
        } catch {
          await pause(250);
        }
      }
      const migrate = () =>
        execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], {
          cwd: workspace,
          env: process.env,
          encoding: "utf8",
        });
      migrate();
      migrate();
      const query = (sql, args = []) => getPool().query(sql, args);
      assert.equal(Number((await query("select count(*) from app_users")).rows[0].count), 0);
      assert.equal(
        Number((await query("select count(*) from drizzle.drizzle_migrations")).rows[0].count),
        JSON.parse(
          await readFile(
            path.join(workspace, "packages/database/migrations/template/meta/_journal.json"),
            "utf8",
          ),
        ).entries.length,
      );
      const { bootstrapAdministrator } = await import("../../src/bootstrap-admin.ts");
      const auth = await import("../../src/modules/identity/service.ts");
      const product_uploads = await import("../../src/modules/uploads/service.ts"),
        product_telemetry = await import("../../src/modules/telemetry/service.ts");
      const events = await import("../../src/event-service.ts");
      await t.test("persisted pending backlog and age degrade administrator health", async () => {
        const { readAdminAsyncRuntimeHealth } =
          await import("../../src/modules/runtime/service.ts");
        const prefix = `health-${randomUUID()}`;
        try {
          assert.equal((await readAdminAsyncRuntimeHealth()).status, "ok");
          await query(
            "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) SELECT $1 || n, CASE WHEN n <= 100 THEN 'health.one' ELSE 'health.two' END, 'demo.echo', $1, '{}' FROM generate_series(1,200) n",
            [prefix],
          );
          const blocked = await readAdminAsyncRuntimeHealth();
          assert.equal(blocked.status, "blocked");
          assert.ok(
            blocked.alerts.some(
              (alert) =>
                alert.metric === "pending" && alert.value === 200 && alert.severity === "critical",
            ),
          );
          await query("DELETE FROM app_outbox_events WHERE trace_id=$1", [prefix]);
          await query(
            "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload,created_at) VALUES($1,'health.one','demo.echo',$1,'{}',now()-interval '1 hour')",
            [prefix],
          );
          const aged = await readAdminAsyncRuntimeHealth();
          assert.equal(aged.status, "degraded");
          assert.ok(aged.alerts.some((alert) => alert.metric === "oldestPendingAgeMs"));
        } finally {
          await query("DELETE FROM app_outbox_events WHERE trace_id=$1", [prefix]);
        }
        assert.equal((await readAdminAsyncRuntimeHealth()).status, "ok");
      });
      await t.test(
        "retained message and recovery quarantine block health while consumption continues",
        async () => {
          const { readAdminAsyncRuntimeHealth } =
            await import("../../src/modules/runtime/service.ts");
          const { inspectOutboxReadiness } =
            await import("../../../../services/worker/src/outbox-readiness.ts");
          const { createPostgresAsyncTaskStore } =
              await import("../../../../services/worker/src/async-task-store.ts"),
            { processAsyncConsumerMessage } =
              await import("../../../../services/worker/src/async-consumer.ts");
          const consumerGroup = `health-quarantine-${randomUUID()}`;
          const key = JSON.stringify([consumerGroup, "invalid-recovery"]);
          const poison = { topic: "health.poison", partition: 0, offset: "19", value: "{broken" };
          const inspect = async (expected) => {
            for (const health of [
              await readAdminAsyncRuntimeHealth(),
              await inspectOutboxReadiness(),
            ]) {
              assert.equal(health.status, expected.length ? "blocked" : "ok");
              assert.deepEqual(
                health.alerts.map(({ reason, metric, value, threshold, severity }) => ({
                  reason,
                  metric,
                  value,
                  threshold,
                  severity,
                })),
                expected.map(([reason, metric]) => ({
                  reason,
                  metric,
                  value: 1,
                  threshold: 1,
                  severity: "critical",
                })),
              );
              assert.deepEqual(
                health.blockedReasons,
                expected.map(([reason]) => reason),
              );
            }
          };
          const messageAlert = ["async_message_quarantine", "messageQuarantine"];
          const recoveryAlert = ["async_recovery_quarantine", "recoveryQuarantine"];
          try {
            await inspect([]);
            const consumePoison = async () => {
              const result = await processAsyncConsumerMessage(poison, {
                store: createPostgresAsyncTaskStore({ pool: getPool() }),
                consumerGroup,
                workerId: "health-test",
                handler: async () => assert.fail("malformed JSON reached handler"),
                commitOffset: async () => {
                  assert.equal(
                    (
                      await query(
                        "SELECT error_code FROM app_message_quarantine WHERE consumer_group=$1",
                        [consumerGroup],
                      )
                    ).rows[0].error_code,
                    "INVALID_MESSAGE",
                  );
                },
              });
              assert.equal(result.status, "quarantined");
              assert.equal(result.committed, true);
            };
            await consumePoison();
            await inspect([messageAlert]);
            await query(
              "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at) VALUES($1,$2,'invalid-recovery',NULL,'failed',now()+interval '1 day')",
              [key, consumerGroup],
            );
            const original = (
              await query("SELECT to_jsonb(r) AS record FROM app_idempotency_keys r WHERE key=$1", [
                key,
              ])
            ).rows[0].record;
            assert.deepEqual(
              await createPostgresAsyncTaskStore({ pool: getPool() }).dueMessages(consumerGroup),
              [],
            );
            const retained = async () => ({
              message: (
                await query("SELECT * FROM app_message_quarantine WHERE consumer_group=$1", [
                  consumerGroup,
                ])
              ).rows,
              recovery: (
                await query("SELECT * FROM app_async_recovery_quarantine WHERE consumer_group=$1", [
                  consumerGroup,
                ])
              ).rows,
              original: (
                await query(
                  "SELECT to_jsonb(r) AS record FROM app_idempotency_keys r WHERE key=$1",
                  [key],
                )
              ).rows[0].record,
            });
            const before = await retained();
            assert.equal(before.recovery[0].error_code, "INVALID_RECOVERY_RECORD");
            assert.deepEqual(before.recovery[0].original_record, original);
            await inspect([messageAlert, recoveryAlert]);
            await inspect([messageAlert, recoveryAlert]);
            assert.deepEqual(
              await retained(),
              before,
              "health observations must not mutate retained evidence",
            );
            await closeDatabase();
            await inspect([messageAlert, recoveryAlert]);
            assert.deepEqual(
              await retained(),
              before,
              "quarantine must remain visible after database reconnection",
            );
            await consumePoison();
            assert.deepEqual(
              await createPostgresAsyncTaskStore({ pool: getPool() }).dueMessages(consumerGroup),
              [],
            );
            await inspect([messageAlert, recoveryAlert]);
            assert.deepEqual((await retained()).original, original);
            const valid = await processAsyncConsumerMessage(
              {
                ...poison,
                offset: "20",
                value: JSON.stringify({
                  eventId: "valid-health-message",
                  eventType: "demo.echo",
                  traceId: consumerGroup,
                  payload: {},
                }),
              },
              {
                store: createPostgresAsyncTaskStore({ pool: getPool() }),
                consumerGroup,
                workerId: "health-test",
                handler: async () => ({ ok: true }),
              },
            );
            assert.equal(
              valid.status,
              "succeeded",
              "blocked health is diagnostic and must not stop valid consumption",
            );
            await inspect([messageAlert, recoveryAlert]);
          } finally {
            await query("DELETE FROM app_message_quarantine WHERE consumer_group=$1", [
              consumerGroup,
            ]);
            await query("DELETE FROM app_async_recovery_quarantine WHERE consumer_group=$1", [
              consumerGroup,
            ]);
            await query("DELETE FROM app_idempotency_keys WHERE scope=$1", [consumerGroup]);
          }
          await inspect([]);
        },
      );
      await t.test(
        "new outbox events persist configured attempts while workers preserve existing policies",
        async () => {
          const event = await events.createOutboxEvent({
            topic: "app.tasks",
            eventType: "demo.echo",
            payload: {},
            traceId: "retry-policy",
          });
          const legacyId = `legacy-${randomUUID()}`;
          await query(
            "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload,max_attempts) VALUES($1,'app.tasks','demo.echo','retry-policy','{}',5)",
            [legacyId],
          );
          assert.equal(
            (await query("SELECT max_attempts FROM app_outbox_events WHERE id=$1", [event.id]))
              .rows[0].max_attempts,
            2,
          );
          const { processOutboxOnce } = await import("../../../../services/worker/src/outbox.ts");
          const previous = process.env.OUTBOX_MAX_ATTEMPTS;
          process.env.OUTBOX_MAX_ATTEMPTS = "1";
          try {
            for (let attempt = 1; attempt <= 2; attempt++) {
              await query(
                "UPDATE app_outbox_events SET next_attempt_at=now()-interval '1 second' WHERE id=ANY($1::text[])",
                [[event.id, legacyId]],
              );
              await processOutboxOnce({
                pool: getPool(),
                dryRun: false,
                batchSize: 2,
                retryBaseMs: 60000,
                retryMaxMs: 60000,
                producer: {
                  send: async () => {
                    throw new Error("broker unavailable");
                  },
                },
              });
              const rows = (
                await query(
                  "SELECT id,status,attempts,max_attempts FROM app_outbox_events WHERE id=ANY($1::text[])",
                  [[event.id, legacyId]],
                )
              ).rows;
              assert.deepEqual(
                rows.find((row) => row.id === event.id),
                {
                  id: event.id,
                  status: attempt === 2 ? "dead_letter" : "failed",
                  attempts: attempt,
                  max_attempts: 2,
                },
              );
              assert.deepEqual(
                rows.find((row) => row.id === legacyId),
                { id: legacyId, status: "failed", attempts: attempt, max_attempts: 5 },
              );
            }
          } finally {
            process.env.OUTBOX_MAX_ATTEMPTS = previous;
          }
        },
      );
      const credentials = {
        account: "test-admin",
        password: "test-strong-password-abc123",
      };
      const admin = await bootstrapAdministrator(credentials);
      const adminToken = (await auth.login(credentials)).token;
      assert.equal(admin.created, true);
      assert.equal((await bootstrapAdministrator(credentials)).created, false);
      await assert.rejects(
        bootstrapAdministrator({
          ...credentials,
          password: "another-strong-password",
        }),
      );
      await t.test(
        "wrong logout secret cannot revoke; disabled roles grant no permissions",
        async () => {
          const login = await auth.login(credentials);
          await auth.logout(`${login.token.split(".")[0]}.incorrect`);
          assert.equal((await auth.getCurrentUser(login.token)).user.id, admin.id);
          await auth.createManagedRole(
            {
              id: "inactive",
              name: "Inactive",
              status: "inactive",
              permissionIds: ["file.upload"],
            },
            adminToken,
            "integration",
          );
          const user = await auth.createManagedUser(
            {
              account: "regular-user",
              displayName: "Regular",
              password: "regular-strong-pass",
              status: "enabled",
              roleIds: ["inactive"],
            },
            adminToken,
            "integration",
          );
          const session = await auth.login({
            account: user.account,
            password: "regular-strong-pass",
          });
          await assert.rejects(
            auth.requirePermission(session.token, "file.upload"),
            (error) => error.status === 403,
          );
          await auth.updateManagedUser(user.id, { status: "disabled" }, adminToken, "integration");
          await auth.updateManagedUser(user.id, { status: "enabled" }, adminToken, "integration");
          await assert.rejects(auth.getCurrentUser(session.token), (error) => error.status === 401);
          const expired = await auth.login(credentials);
          await query(
            "update app_user_sessions set expires_at=now()-interval '1 second' where id=$1",
            [expired.session.id],
          );
          await assert.rejects(auth.getCurrentUser(expired.token), (error) => error.status === 401);
          await auth.logout(login.token);
          await assert.rejects(auth.getCurrentUser(login.token), (error) => error.status === 401);
        },
      );
      await t.test("last administrator and conflicting role creation stay consistent", async () => {
        await assert.rejects(
          auth.updateManagedUser(admin.id, { status: "disabled" }, adminToken, "integration"),
          (error) => error.code === "LAST_ADMINISTRATOR",
        );
        await assert.rejects(
          auth.updateManagedRole("role_admin", { status: "inactive" }, adminToken, "integration"),
          (error) => error.code === "LAST_ADMINISTRATOR",
        );
        const attempts = await Promise.allSettled(
          [1, 2].map(() =>
            auth.createManagedRole(
              {
                id: "unique-role",
                name: "Unique",
                status: "active",
                permissionIds: [],
              },
              adminToken,
              "integration",
            ),
          ),
        );
        assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      });
      await t.test(
        "writes revalidate revoked permissions and upload credentials after body reading",
        async () => {
          await auth.createManagedRole(
            {
              id: "revocable",
              name: "Revocable",
              status: "active",
              permissionIds: ["admin.write", "file.upload"],
            },
            adminToken,
            "test",
          );
          const actor = await auth.createManagedUser(
            {
              account: "revocable-user",
              displayName: "Revocable",
              password: "revocable-password",
              status: "enabled",
              roleIds: ["revocable"],
            },
            adminToken,
            "test",
          );
          const token = (
            await auth.login({
              account: actor.account,
              password: "revocable-password",
            })
          ).token;
          await auth.requirePermission(token, "admin.write");
          let releaseRead;
          const reading = new Promise((resolve) => {
            releaseRead = resolve;
          });
          let signalRead;
          const started = new Promise((resolve) => {
            signalRead = resolve;
          });
          class PausedFile extends File {
            async arrayBuffer() {
              signalRead();
              await reading;
              return super.arrayBuffer();
            }
          }
          const upload = product_uploads.storeUploadedFile({
            file: new PausedFile(["blocked"], "blocked.txt"),
            actorId: actor.id,
            token,
            traceId: "revoked-upload",
          });
          await started;
          await auth.updateManagedRole("revocable", { status: "inactive" }, adminToken, "test");
          releaseRead();
          await assert.rejects(upload, (error) => error.status === 403);
          const rejected = [
            () =>
              auth.createManagedUser(
                {
                  account: "forbidden",
                  displayName: "Forbidden",
                  password: "forbidden-password",
                  status: "enabled",
                  roleIds: [],
                },
                token,
                "test",
              ),
            () => auth.updateManagedUser(actor.id, { displayName: "Changed" }, token, "test"),
            () =>
              auth.createManagedRole(
                {
                  id: "forbidden-role",
                  name: "Forbidden",
                  status: "active",
                  permissionIds: [],
                },
                token,
                "test",
              ),
            () => auth.updateManagedRole("revocable", { status: "active" }, token, "test"),
          ];
          for (const operation of rejected)
            await assert.rejects(operation(), (error) => error.status === 403);
          assert.equal(
            (await query("select count(*) from app_users where account='forbidden'")).rows[0].count,
            "0",
          );
          assert.equal(
            (await query("select count(*) from app_file_assets where file_name='blocked.txt'"))
              .rows[0].count,
            "0",
          );
          await auth.logout(token);
          await assert.rejects(rejected[0](), (error) => error.status === 401);
          await assert.rejects(
            auth.updateManagedUser(actor.id, { displayName: "Changed" }, undefined),
            (error) => error.status === 401,
          );
        },
      );
      await t.test("caller rollback removes both audit and outbox facts", async () => {
        const traceId = `event-rollback-${randomUUID()}`;
        await assert.rejects(
          withTransaction(async (tx) => {
            const audit = await events.recordAudit(
              {
                action: "integration.rollback",
                targetType: "test",
                targetId: traceId,
                traceId,
              },
              tx,
            );
            const auditRows = await tx.query.appAuditLogs.findMany({
              where: (table, { eq }) => eq(table.id, audit.id),
            });
            const outboxRows = await tx.query.appOutboxEvents.findMany({
              where: (table, { eq }) => eq(table.traceId, traceId),
            });
            assert.equal(auditRows.length, 1);
            assert.equal(outboxRows.length, 1);
            throw new Error("caller rollback");
          }),
          /caller rollback/,
        );
        const remaining = await query(
          "select (select count(*) from app_audit_logs where trace_id=$1) audit, (select count(*) from app_outbox_events where trace_id=$1) outbox",
          [traceId],
        );
        assert.deepEqual(remaining.rows[0], { audit: "0", outbox: "0" });
      });
      await t.test(
        "outbox insertion failure rolls back user, session, telemetry and audit writes",
        async () => {
          const before = (
            await query(
              "select (select count(*) from app_users) users,(select count(*) from app_audit_logs) audit,(select count(*) from app_user_sessions) sessions,(select count(*) from app_telemetry_events) telemetry",
            )
          ).rows[0];
          await query(
            "create function test_reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'test outbox failure'; end $$; create trigger test_fail_outbox before insert on app_outbox_events for each row execute function test_reject_outbox()",
          );
          await assert.rejects(
            auth.createManagedUser(
              {
                account: "rollback-user",
                displayName: "Rollback",
                password: "rollback-password",
                status: "enabled",
                roleIds: [],
              },
              adminToken,
              "integration",
            ),
          );
          await assert.rejects(auth.login(credentials));
          await assert.rejects(
            product_telemetry.recordTelemetry({
              event: "rollback",
              traceId: "integration",
            }),
          );
          const after = (
            await query(
              "select (select count(*) from app_users) users,(select count(*) from app_audit_logs) audit,(select count(*) from app_user_sessions) sessions,(select count(*) from app_telemetry_events) telemetry",
            )
          ).rows[0];
          assert.deepEqual(after, before);
          await query(
            "drop trigger test_fail_outbox on app_outbox_events; drop function test_reject_outbox()",
          );
        },
      );
      await t.test(
        "failed file commit remains tracked and successful refs survive cleanup",
        async () => {
          const good = await product_uploads.storeUploadedFile({
            token: adminToken,
            file: new File(["hello"], "hello.txt"),
            traceId: "upload-ok",
          });
          assert.equal(await readFile(path.join(storage, good.storageKey), "utf8"), "hello");
          assert.equal(await product_uploads.reconcileUploadIntent(good.storageKey), "protected");
          await query(
            "create function test_reject_file() returns trigger language plpgsql as $$ begin raise exception 'test file failure'; end $$; create trigger test_fail_file before insert on app_file_assets for each row execute function test_reject_file()",
          );
          await assert.rejects(
            product_uploads.storeUploadedFile({
              token: adminToken,
              file: new File(["orphan"], "orphan.txt"),
              traceId: "upload-failed",
            }),
          );
          const failed = (await query("select * from app_upload_intents where state='deleted'"))
            .rows;
          assert.equal(failed.length, 1);
          assert.deepEqual(await readdir(storage), [good.storageKey]);
          const before = (await query("select * from app_upload_intents order by id")).rows;
          await product_uploads.reconcileUploads({
            dryRun: true,
            staleBefore: new Date(Date.now() + 1000),
          });
          assert.deepEqual(
            (await query("select * from app_upload_intents order by id")).rows,
            before,
          );
          await query(
            "drop trigger test_fail_file on app_file_assets; drop function test_reject_file()",
          );
        },
      );
      await t.test(
        "HTTP trace IDs remain valid through persistence and consumer execution",
        async () => {
          const { POST } = await import("../../../../apps/web/app/api/telemetry/route.ts");
          const { outboxKafkaMessageValue } =
            await import("../../../../services/worker/src/outbox.ts");
          const { createPostgresAsyncTaskStore } =
              await import("../../../../services/worker/src/async-task-store.ts"),
            { processAsyncConsumerMessage } =
              await import("../../../../services/worker/src/async-consumer.ts");
          const { handleDomainEvent } =
            await import("../../../../services/worker/src/domain-handler.ts");
          const store = createPostgresAsyncTaskStore({ pool: getPool() });
          for (const length of [36, 2000, 2400, 6000]) {
            const incomingTrace = randomBytes(length).toString("base64url").slice(0, length);
            const response = await POST(
              new Request("http://localhost/api/telemetry", {
                method: "POST",
                headers: { "content-type": "application/json", "x-trace-id": incomingTrace },
                body: JSON.stringify({ event: "trace.regression" }),
              }),
            );
            assert.equal(response.status, 201);
            const { traceId, data } = await response.json();
            if (length <= 2000) assert.equal(traceId, incomingTrace);
            else assert.match(traceId, /^trace_[0-9a-f-]{36}$/);
            assert.equal(data.traceId, traceId);
            const row = (
              await query("SELECT * FROM app_outbox_events WHERE trace_id=$1", [traceId])
            ).rows[0];
            const value = outboxKafkaMessageValue({
              id: row.id,
              topic: row.topic,
              eventType: row.event_type,
              traceId: row.trace_id,
              payload: row.payload,
              attempts: row.attempts,
              maxAttempts: row.max_attempts,
            });
            const result = await processAsyncConsumerMessage(
              { topic: row.topic, partition: 0, offset: String(length), value },
              {
                store,
                consumerGroup: "trace-regression",
                workerId: "trace-regression",
                handler: handleDomainEvent,
              },
            );
            assert.equal(result.status, "succeeded");
            assert.equal(
              (
                await query("SELECT count(*)::int n FROM app_async_receipts WHERE task_id=$1", [
                  row.id,
                ])
              ).rows[0].n,
              1,
            );
          }
        },
      );
      await t.test(
        "blank upload names fail before reading bytes or persisting any upload effects",
        async () => {
          const { ok } = await import("../../src/api-response.ts");
          const { withAccessLog } = await import("../../src/logger.ts");
          const before = (
            await query(
              "SELECT (SELECT count(*) FROM app_file_assets) assets, (SELECT count(*) FROM app_upload_intents) intents, (SELECT count(*) FROM app_outbox_events) outbox, (SELECT count(*) FROM app_audit_logs) audit",
            )
          ).rows;
          const filesBefore = await readdir(storage);
          let reads = 0;
          class ObservedFile extends File {
            async arrayBuffer() {
              reads++;
              return super.arrayBuffer();
            }
          }
          for (const fileName of ["", "   ", "\t"]) {
            const response = await withAccessLog(
              new Request("http://localhost/api/uploads", { method: "POST" }),
              "invalid-upload",
              async () =>
                ok(
                  await product_uploads.storeUploadedFile({
                    token: adminToken,
                    file: new ObservedFile(["hello"], fileName),
                    traceId: "invalid-upload",
                  }),
                  "invalid-upload",
                ),
            );
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
          }
          assert.equal(reads, 0);
          assert.deepEqual(
            (
              await query(
                "SELECT (SELECT count(*) FROM app_file_assets) assets, (SELECT count(*) FROM app_upload_intents) intents, (SELECT count(*) FROM app_outbox_events) outbox, (SELECT count(*) FROM app_audit_logs) audit",
              )
            ).rows,
            before,
          );
          assert.deepEqual(await readdir(storage), filesBefore);
          const response = await withAccessLog(
            new Request("http://localhost/api/uploads", { method: "POST" }),
            "valid-upload",
            async () =>
              ok(
                await product_uploads.storeUploadedFile({
                  token: adminToken,
                  file: new File(["hello"], "  valid.txt  "),
                  traceId: "valid-upload",
                }),
                "valid-upload",
              ),
          );
          assert.equal(response.status, 200);
          const { data } = await response.json();
          assert.equal(data.fileName, "valid.txt");
          assert.equal(
            (await query("SELECT file_name FROM app_file_assets WHERE id=$1", [data.id])).rows[0]
              .file_name,
            data.fileName,
          );
        },
      );
    } finally {
      await closeDatabase();
      docker("rm", "-f", name);
      await rm(storage, { recursive: true, force: true });
    }
  },
);
test(
  "Redis authenticates, selects database and atomically sets window expiration",
  { timeout: 60000 },
  async () => {
    const name = `pstack-redis-${randomUUID()}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::6379",
      "redis:5.0.8",
      "redis-server",
      "--requirepass",
      "isolated-redis-test",
    );
    const port = docker("port", name, "6379/tcp").split(":").at(-1);
    const url = `redis://:isolated-redis-test@127.0.0.1:${port}/3`;
    const { redisWindowCount, redisCommand, closeRedis } =
      await import("../../src/redis-client.ts");
    try {
      for (let i = 0; i < 30; i++) {
        try {
          await redisCommand(url, ["PING"]);
          break;
        } catch {
          await pause(100);
        }
      }
      const counts = await Promise.all(
        Array.from({ length: 25 }, () => redisWindowCount(url, "integration-window", 5000)),
      );
      assert.deepEqual(
        counts.map((item) => item.count).sort((a, b) => a - b),
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
      assert.ok(counts.every((item) => item.ttlMs > 0 && item.ttlMs <= 5000));
      assert.equal(await redisCommand(url, ["GET", "integration-window"]), "25");
      assert.equal(
        await redisCommand(url.replace("/3", "/0"), ["GET", "integration-window"]),
        null,
      );
      await redisCommand(url.replace("/3", "/0"), [
        "CLIENT",
        "KILL",
        "TYPE",
        "normal",
        "SKIPME",
        "yes",
      ]);
      await pause(100);
      assert.equal((await redisWindowCount(url, "reconnected-window", 5000)).count, 1);
    } finally {
      await closeRedis();
      docker("rm", "-f", name);
    }
  },
);
