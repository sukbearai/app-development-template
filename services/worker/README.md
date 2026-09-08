# Worker

`pnpm --filter @pstack/worker start` starts the Kafka consumer, PostgreSQL retry scan, and outbox publisher. Set `DATABASE_URL`, `KAFKA_BROKERS`, and `OUTBOX_PUBLISHER=kafka`. The default topics are `app.tasks`, `telemetry.events`, and `files.events`, and `audit.events`.

The shipped domain handler stores an echo receipt for `demo.echo` and a receipt projection for `telemetry.recorded` and `file.uploaded`. These receipts, task transitions, task events, and idempotency completion commit in one PostgreSQL transaction. This is a runnable middleware demonstration, not an external business integration. Additional handlers receive the same `PoolClient`; database effects must use that client. External effects need receiver-owned idempotency and are outside this transaction guarantee.

Outbox delivery is at least once. A crash after Kafka acceptance can publish a duplicate. Expired claims acquire a higher generation, and stale publisher acknowledgements cannot change state. Consumer keys include the consumer group and bind to a canonical payload hash. Completed keys are retained even after `expires_at`; deleting those keys would weaken duplicate protection. Pending, processing, failed and dead-letter envelopes stay in PostgreSQL for recovery and replay. Retention may compact successful or canceled v2 envelopes and receipt results while preserving their keys, hashes and terminal status. Legacy envelopes remain stored, including after successful recovery, because their payload supplies compatibility evidence. `ASYNC_TASK_IDEMPOTENCY_TTL_HOURS` controls the retention eligibility timestamp; it does not authorize deleting duplicate protection. `ASYNC_TASK_DEFAULT_MAX_ATTEMPTS` controls runtime retries when the message does not specify its own limit.

Async message identifiers (`eventId`, `eventType`, `traceId`, `taskId`, and explicit `idempotencyKey`) are limited to 2000 UTF-8 bytes after the existing whitespace trimming. The persisted identity remains `JSON.stringify([consumerGroup, idempotencyKey])`, with the existing `eventType:eventId` default. Its complete serialized value must also fit 2000 UTF-8 bytes, including the group, JSON punctuation, and escaping. This budget leaves room below PostgreSQL B-tree index limits. No keys or hashes are migrated. Previously accepted oversized messages, including historical Kafka redelivery and durable retry envelopes, now enter `INVALID_MESSAGE` quarantine before claim. Their offsets advance only after quarantine is durable; existing stored keys are preserved. Historical oversized durable envelopes are not rewritten or removed. After an `INVALID_MESSAGE` quarantine record commits, recovery scans skip that exact consumer group, topic, partition, and offset so later valid tasks can proceed. Recovery for the quarantined task stays paused; `replay` does not clear its quarantine record. Operators must inspect and resolve those records; this change performs no automatic state migration.

Consumer group configuration is limited to 256 UTF-8 bytes and preserves whitespace as part of its identity. Groups reject NUL and unpaired surrogates. Kafka topics use 1 to 249 ASCII letters, digits, dots, underscores, or hyphens, excluding `.` and `..`; partitions fit a nonnegative signed 32-bit integer and offsets use nonnegative signed 64-bit decimal notation. Metadata is validated before quarantine because it forms that table's unique index. Invalid metadata fails without a quarantine write or offset acknowledgement.

A consumer holds the idempotency row lock while its database handler and receipt commit. This prevents another worker from taking ownership during that transaction, even if the timestamp expires. Handlers must finish in bounded time. The shared pool sets a SQL statement timeout; arbitrary external promises do not inherit it. SIGTERM stops new claims, drains the current handler, disconnects Kafka, and closes the process pool. A forced exit relies on durable lease recovery.

Commands remain available through `pnpm --filter @pstack/worker exec tsx src/index.ts <command>`:

- `health` lists command capabilities. `health --live` checks the runtime heartbeat and process identity. Compose uses the latter.
- `readiness` and `alerts` inspect database backlog, due retries, expired locks, and retained message and recovery quarantine counts. Nonempty quarantine produces critical alerts and a `blocked` diagnostic status without stopping unrelated processing.
- `outbox-once --dry-run` performs a SELECT only, without claims or status changes.
- `outbox-loop` publishes continuously. `async-runtime --iterations 0` prints a plan without opening dependencies.
- `replay --key <idempotency-key>` resets a failed or dead-letter task in the configured consumer group. The runtime scans the durable envelope and executes it without depending on Kafka retention. Successful tasks are not reset.

`WORKER_HEARTBEAT_PATH` must identify a distinct path for each runtime when using `health --live`. Set the same path in the runtime and health command environments. Without it, the runtime writes to a unique temporary path and the health command requires an explicit path. Heartbeat writes are serialized; shutdown drains queued writes and leaves the final state stopped. A running heartbeat is liveness evidence; Kafka delivery and domain execution require the integration checks below.

New payload hashes use `v2:<sha256>` over JSON with object keys sorted by UTF-16 code units at every depth. Arrays keep their order and Unicode text is not normalized. Existing bare SHA-256 hashes are never rewritten. When a legacy envelope remains available, the worker compares its payload and event type with the incoming message. A compacted legacy terminal record is skipped only when the incoming legacy hash matches exactly. Otherwise it is quarantined as `IDEMPOTENCY_UNVERIFIABLE` and does not execute. Unknown hash versions and incomplete stored tasks also fail closed. After `IDEMPOTENCY_UNVERIFIABLE` quarantine commits, durable scans skip that exact consumer group, topic, partition, and offset so later tasks can proceed. `replay` keeps this quarantine in place; operators must inspect the preserved row and resolve the incompatibility.

When a stored record cannot reconstruct a message, recovery records its original database key and full row snapshot in `app_async_recovery_quarantine`. This covers missing envelopes or sources, invalid retry dates, and a source group or identity that differs from the owning row. The original status, payload, hash and lease fields remain unchanged. The scanner locks and rechecks the current row before isolation. If recording isolation fails, the scan fails without skipping that record. Claims and replay refuse an isolated key, including after restart; inspection or repair of its payload does not automatically release it.

Recovery scans bounded pages and cycles past future retries so later due work remains discoverable. Returned messages stay visible until normal processing or message quarantine commits. Inspect recovery quarantine alongside message quarantine when diagnosing pending work. Retain the original snapshot and establish a valid task identity before an explicitly authorized data repair; ordinary replay does not clear either isolation record.

Apply the additive migration that creates `app_async_recovery_quarantine` before starting this Worker version. Stop old consumers and recovery loops during the upgrade. Old Worker versions do not enforce database-record isolation, so rollback must retain a compatible Worker or keep asynchronous execution stopped. This migration creates the table without changing existing task data.

Stop all old consumers and durable recovery loops before starting v2 workers. Do not mix old and v2 worker binaries. Once v2 identities have been written, any rollback must keep a reader compatible with v2 and legacy identities. This release does not upgrade existing database rows or remove quarantine records.

## Verification

Run `pnpm --filter @pstack/worker typecheck` and `pnpm --filter @pstack/worker test:unit`.

`pnpm --filter @pstack/worker test:integration` creates its own PostgreSQL and Kafka containers, applies migrations, runs the suite and removes its containers. It ignores application database configuration.

For a separately owned test environment, `test:integration:external` requires an **empty isolated database** and a disposable Kafka broker. It rejects a database with existing public tables, applies the authoritative template migrations, and creates unique Kafka topics/groups. It never resets an existing database:

```sh
WORKER_TEST_DATABASE_URL=postgres://... \
WORKER_TEST_KAFKA_BROKERS=127.0.0.1:... \
pnpm --filter @pstack/worker test:integration:external
```

`WORKER_TEST_MIGRATIONS` optionally selects the template migration directory for isolated checkout validation. Test coverage includes concurrent claims, hash conflicts, receipt failure rollback, future and overdue retries on the same Kafka offset, stale owners, durable replay, malformed/NUL/unpaired-surrogate quarantine, valid emoji delivery, runtime retry/retention configuration, offset commit failure, a real child SIGKILL after broker acceptance, and SIGTERM drain. Test containers and databases are owned by the caller and must be removed after verification.
