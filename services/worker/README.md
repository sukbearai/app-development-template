# Worker

`pnpm --filter @pstack/worker start` starts the Kafka consumer, PostgreSQL retry scan, and outbox publisher. Set `DATABASE_URL`, `KAFKA_BROKERS`, and `OUTBOX_PUBLISHER=kafka`. The default topics are `app.tasks`, `telemetry.events`, and `files.events`, and `audit.events`.

The shipped domain handler stores an echo receipt for `demo.echo` and a receipt projection for `telemetry.recorded` and `file.uploaded`. These receipts, task transitions, task events, and idempotency completion commit in one PostgreSQL transaction. This is a runnable middleware demonstration, not an external business integration. Additional handlers receive the same `PoolClient`; database effects must use that client. External effects need receiver-owned idempotency and are outside this transaction guarantee.

Outbox delivery is at least once. A crash after Kafka acceptance can publish a duplicate. Expired claims acquire a higher generation, and stale publisher acknowledgements cannot change state. Consumer keys include the consumer group and bind to a canonical payload hash. Completed keys are retained even after `expires_at`; deleting those keys would weaken duplicate protection. The complete envelope stays in PostgreSQL for recovery and replay.

A consumer holds the idempotency row lock while its database handler and receipt commit. This prevents another worker from taking ownership during that transaction, even if the timestamp expires. Handlers must finish in bounded time. The shared pool sets a SQL statement timeout; arbitrary external promises do not inherit it. SIGTERM stops new claims, drains the current handler, disconnects Kafka, and closes the process pool. A forced exit relies on durable lease recovery.

Commands remain available through `pnpm --filter @pstack/worker exec tsx src/index.ts <command>`:

- `health` lists command capabilities. `health --live` checks the runtime heartbeat and process identity. Compose uses the latter.
- `readiness` and `alerts` inspect database backlog, due retries, and expired locks.
- `outbox-once --dry-run` performs a SELECT only, without claims or status changes.
- `outbox-loop` publishes continuously. `async-runtime --iterations 0` prints a plan without opening dependencies.
- `replay --key <idempotency-key>` resets a failed or dead-letter task in the configured consumer group. The runtime scans the durable envelope and executes it without depending on Kafka retention. Successful tasks are not reset.

`WORKER_HEARTBEAT_PATH` defaults to `/tmp/pstack-worker-heartbeat.json`. Use a distinct path for each local runtime. A running heartbeat is liveness evidence; Kafka delivery and domain execution require the integration checks below.

## Verification

Run `pnpm --filter @pstack/worker typecheck` and `pnpm --filter @pstack/worker test:unit`.

`pnpm --filter @pstack/worker test:integration` creates its own PostgreSQL and Kafka containers, applies migrations, runs the suite and removes its containers. It ignores application database configuration.

For a separately owned test environment, `test:integration:external` requires an **empty isolated database** and a disposable Kafka broker. It rejects a database with existing public tables, applies the authoritative template migrations, and creates unique Kafka topics/groups. It never resets an existing database:

```sh
WORKER_TEST_DATABASE_URL=postgres://... \
WORKER_TEST_KAFKA_BROKERS=127.0.0.1:... \
pnpm --filter @pstack/worker test:integration:external
```

`WORKER_TEST_MIGRATIONS` optionally selects the template migration directory for isolated checkout validation. Test coverage includes concurrent claims, hash conflicts, receipt failure rollback, future and overdue retries on the same Kafka offset, stale owners, durable replay, malformed/NUL quarantine, offset commit failure, a real child SIGKILL after broker acceptance, and SIGTERM drain. Test containers and databases are owned by the caller and must be removed after verification.
