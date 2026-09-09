# Check runtime conditions

Use `pnpm monitor:check` to read one authenticated JSON snapshot from `GET /api/system/metrics`. The command reports current conditions and exits. For sustained alerts and webhook delivery, run `monitor:tick` with the supplied systemd timer. Each state directory tracks one metrics target and one receiver.

## Connect the check

1. Configure the application's `METRICS_TOKEN` through your secret manager.
2. Give the check the same token through `METRICS_TOKEN` in its environment. Use 32–256 letters, digits, underscores, or hyphens.
3. Set `METRICS_URL` to the full endpoint, for example `https://app.example.com/api/system/metrics`.
4. Run `pnpm monitor:check` in the repository with dependencies installed.

The equivalent direct command is `node scripts/monitor-check.mjs`. The check does not load `.env` files. Keep tokens out of command arguments, shell tracing, and collector logs.

HTTPS endpoints are accepted. HTTP is limited to `localhost`, `127.0.0.1`, and `[::1]`. URL credentials, query strings, fragments, and other endpoint paths are rejected. The request sends a bearer token and rejects every redirect. The response must be HTTP 2xx with `application/json` and satisfy the canonical success envelope `{traceId,data,meta?}`. Its `data` must satisfy `runtimeMetricsSchema` in `packages/contracts/src/runtime-metrics.ts`.

The request deadline covers response headers and body consumption. The body limit is 256 KiB, including streamed bytes. HTTP failures and malformed responses produce fixed reason codes without URLs, credentials, or server error text.

## Set thresholds for the deployment

Set integer environment values before starting the check. Defaults are illustrative. Calibrate queue-age thresholds against your longest legitimate task and delivery recovery budget.

| Environment variable         | Default | Accepted range | Current condition                              |
| ---------------------------- | ------: | -------------: | ---------------------------------------------- |
| `MONITOR_TIMEOUT_MS`         |    5000 |      100–60000 | Request deadline                               |
| `MONITOR_MAX_AGE_MS`         |   60000 |   1000–3600000 | Maximum age of each observation                |
| `MONITOR_POOL_WAITING`       |       1 |      1–1000000 | Database pool waiters                          |
| `MONITOR_OUTBOX_AGE_MS`      |  300000 |   1–2592000000 | Oldest pending outbox age                      |
| `MONITOR_OUTBOX_STALE_LOCKS` |       1 |   1–1000000000 | Outbox records with stale publish leases       |
| `MONITOR_TASK_AGE_MS`        |  900000 |   1–2592000000 | Oldest unfinished task age                     |
| `MONITOR_DEAD_LETTERS`       |       1 |   1–1000000000 | Sum of outbox and task dead letters            |
| `MONITOR_QUARANTINE`         |       1 |   1–1000000000 | Sum of message and recovery quarantine records |
| `MONITOR_BLOCKED_UPLOADS`    |       1 |   1–1000000000 | Blocked upload intents                         |

A queue or count condition matches at or above its threshold. Observations older than `MONITOR_MAX_AGE_MS` fail freshness. Timestamps more than five seconds ahead of the check's clock fail freshness too. Keep clocks synchronized. Database unavailability always reports an alert.

The command accepts no options. Invalid configuration exits with code 2. A healthy observation exits with code 0. An alert or request failure exits with code 1.

## Collect JSON observations

Capture stdout as one JSON document. A healthy result is:

```json
{ "version": 1, "severity": "healthy", "reasons": [] }
```

An observation with blocked uploads is:

```json
{ "version": 1, "severity": "alert", "reasons": ["uploads_blocked"] }
```

Severity is `healthy`, `alert`, or `error`. Condition reasons are `database_pool_waiting`, `outbox_pending_age`, `outbox_stale_locks`, `task_unfinished_age`, `dead_letters`, `quarantine`, `uploads_blocked`, and `database_unavailable`. Freshness reasons are `metrics_stale`, `metrics_clock_ahead`, `database_metrics_stale`, and `database_metrics_clock_ahead`. Error reasons are `invalid_configuration`, `metrics_http_error`, `metrics_invalid_response`, `metrics_timeout`, and `metrics_request_failed`.

For time series, scrape the endpoint JSON directly with an authenticated collector. Read metric fields under the response's `data` property. Map these fields according to their scope:

| JSON field                                    | Meaning                                                            | Aggregation                                     |
| --------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `process.*`                                   | Uptime and memory of the responding Web process                    | Per instance                                    |
| `databasePool.*`                              | Connection pool of the responding Web process                      | Per instance                                    |
| `uploads.active`, `uploads.limit`             | Upload admission in the responding Web process                     | Per instance                                    |
| `uploads.rejectedTotal`                       | Rejected uploads since process start                               | Counter deltas per instance, account for resets |
| `http[]`                                      | Counts and duration totals by registered operation and HTTP status | Counter deltas per instance, account for resets |
| `http[].durationMsMax`                        | Maximum observed duration since process start                      | Per instance maximum, no percentile inference   |
| `database.outbox.*`, `database.tasks.*`       | Shared database status counts and queue ages                       | One series per database                         |
| `database.quarantine.*`, `database.uploads.*` | Shared database quarantine and upload-intent counts                | One series per database                         |
| `observedAt`, `database.observedAt`           | Runtime and database observation timestamps                        | Check each timestamp for freshness              |

The endpoint serves JSON. It does not expose Prometheus text or a Kafka consumer-lag measurement. Outbox age and unfinished task age identify durable work delays. The `database.outbox.staleLocks` count also detects abandoned processing records after a publisher crash, when there may be no pending work. Neither age proves broker lag, and Web process metrics do not measure worker memory or worker connection pools.

Give each Web process a stable collector target. A load-balanced endpoint can switch processes between scrapes and corrupt counter deltas. Do not sum the shared database gauges across Web replicas. Treat `database.status = unavailable` as missing data and a failed dependency observation, never as zero queue depth.

## Install scheduled alert delivery

The host needs Node.js 22.13 or later, Python 3 with `fcntl`, systemd, and a repository checkout with production tool dependencies installed. `monitor:tick` reuses the snapshot check and uses a process-owned OS lock through Python. The short Python helper locks an inherited file descriptor; the Node process retains that descriptor. Closing it or killing the Node process releases the lock. The lock file remains on disk; do not delete it or replace the state directory while a tick runs.

1. Install the checkout and dependencies at `/opt/pstack-x`. Adjust the unit's Node path if Node is installed elsewhere.
2. Create a dedicated account with `sudo useradd --system --home-dir /var/lib/pstack-monitor --shell /usr/sbin/nologin pstack-monitor`.
3. Copy `deploy/monitor/monitor.json` to `/etc/pstack/monitor.json`. Set a stable target ID, the metrics URL, and the webhook URL. Use one Web instance per target. The JSON schema rejects unknown keys and bounds every duration and queue limit.
4. Copy `deploy/monitor/monitor.env.example` to `/etc/pstack/monitor.env`. Supply the application's metrics token and the receiver bearer token from your secret manager. Both accept 32–256 letters, digits, underscores, or hyphens. Set the file owner to root and mode to `0600`. Set JSON ownership to root and mode to `0644`.
5. Copy `deploy/monitor/pstack-monitor.service` and `deploy/monitor/pstack-monitor.timer` to `/etc/systemd/system/`.
6. Run `sudo systemctl daemon-reload` and `sudo systemctl enable --now pstack-monitor.timer`.
7. Inspect `systemctl list-timers pstack-monitor.timer` and `journalctl -u pstack-monitor.service`. Use an authorized alert exercise to verify the receiver's deduplication and the recipient's acknowledgement.

The timer runs every 30 seconds and performs one catch-up tick after downtime. systemd does not start overlapping instances of the same service; the OS lock also rejects concurrent manual invocations. `TimeoutStartSec=100` covers the maximum 60-second metrics request plus at most 30 seconds of webhook requests. State writes and lock acquisition failures exit visibly. The monitor writes only its private state directory and sends notifications only to the configured receiver. It does not alter application data.

The direct commands are:

```sh
node scripts/monitor-tick.mjs --config /etc/pstack/monitor.json
node scripts/monitor-tick.mjs --config /etc/pstack/monitor.json --status
node scripts/monitor-tick.mjs --config /etc/pstack/monitor.json --retry-delivery
```

These commands read secrets from their environment; they do not load `.env` files. Running a manual tick requires the same account, environment and state directory as the service. A successful, healthy tick exits 0. An active or pending condition, pending delivery, or stale heartbeat exits 1. Invalid configuration, corrupt state, queue exhaustion, and lock contention exit 2 with a fixed reason code. A systemd failure during an active alert is expected and remains visible in its journal.

## Sustained conditions and delivery state

The example requires five minutes of consecutive observations before firing and one minute of valid recovery observations before resolving. A gap above `maxObservationGapMs` resets pending firing and recovery durations and opens a `collection_gap` incident immediately. Missed intervals do not count toward either duration. Collection errors share a `collection_error` incident, so alternating HTTP errors and timeouts still count as continued collection failure.

Failed, stale, future-dated, or unavailable database observations cannot resolve metric incidents. They also reset unconfirmed metric conditions. Valid observations must resume before a metric incident can recover. Repeated observations of the same active reason create no additional firing event.

The atomic `state.json` contains incident IDs, ordered events, attempts, and timestamps. It contains no tokens, response bodies, or business data. The state identity binds the target ID, metrics URL and receiver URL. Changing these requires a separate state directory; retain and drain the old queue before retiring it. Do not reset state to make a corrupt file appear healthy. Stop the timer, preserve the file, and recover from a known valid backup or reconcile owed notifications with the operator.

The monitor persists each firing event and its delivery attempt before HTTP. Every request includes `Idempotency-Key` and a JSON body with `version`, `targetId`, `id`, `incidentId`, `reason`, `transition` and `occurredAt` in epoch milliseconds. Transition is `firing` or `resolved`. The receiver must commit its idempotency key and resulting effect together before responding with 2xx. A crash after receiver acceptance can repeat the request with the same key. Recovery never overtakes firing; the queue is FIFO across this target.

The receiver URL requires HTTPS, except loopback HTTP for local verification. Requests reject redirects, consume at most 16 KiB of response bytes, and have a deadline covering headers and body. Non-2xx, timeout, and malformed transport responses retain the event. Retries use capped exponential backoff. `maxAttempts` stops automatic retries, `maxDeliveriesPerTick` bounds work per tick, and `maxQueue` rejects overflow without deleting existing events. Exhausted delivery blocks later events and is reported in status. After fixing the receiver, use `--retry-delivery` to reset attempt counters and drain up to `maxDeliveriesPerTick` events. This action collects no metrics and does not refresh the observation heartbeat. Repeat it as needed to drain a full queue, then resume regular ticks. Do not discard owed notifications.

## Detect a stopped monitor

Run the `--status` command through an independent watchdog. It reads state without collecting metrics or sending messages and reports `lastTickAt`, `heartbeatStale`, active reasons, pending delivery count, oldest pending timestamp and retry exhaustion. The example declares the heartbeat stale after 90 seconds. A machine-readable status response is also written to stdout after every completed tick.

Configure the watchdog on a different host or external monitoring service. Check both whether the command can be reached and whether its heartbeat is fresh. A dead host cannot report its own disappearance. Shipped unit files and local tests do not prove installation, external heartbeat watching, or recipient acknowledgement.

## Export traces with a durable collector queue

`deploy/otel-collector.yaml` is the production configuration for the pinned `images.otelContrib` image in `scripts/toolchain-lock.json`. It exports OTLP over TLS with certificate verification, a 128 MiB memory limiter, bounded batches, two queue consumers and up to 1000 queued requests stored through `file_storage`. Set `OTEL_BACKEND_AUTHORITY` to your backend's host and optional port, without a scheme, path or credentials. The configuration fixes the endpoint scheme to HTTPS. Supply `OTEL_BACKEND_TOKEN` through your secret manager. Set `OTEL_BACKEND_CA_FILE` to a mounted CA bundle for a private CA, or leave it empty to use system trust.

Mount the configuration read-only at `/etc/otelcol/config.yaml` and persistent storage at `/var/lib/otelcol`. The collector's runtime UID must own that directory. Start with `--config=/etc/otelcol/config.yaml`. Keep OTLP port 4318 on the private application network; this receiver does not provide public ingress authentication. Configure the Web process's `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the collector's `/v1/traces` endpoint.

Validate with the exact pinned contrib image before starting it: `docker run --rm` with the same environment and mounts, followed by the pinned image and `validate --config=/etc/otelcol/config.yaml`. `node scripts/test-monitor-collector.mjs` performs that validation and proves TLS export plus persistent queue recovery after a collector SIGKILL against a disposable local receiver. It needs Docker and OpenSSL and sends no external notification. `deploy/otel-collector.debug.yaml` belongs only to the existing local tracing sanitizer test.

Exporter retries stop after five minutes for an individual export. Queue capacity, storage failure and exhausted retries can still lose traces. Monitor collector errors and storage capacity through an independent agent; persistent queues do not imply indefinite retention. Target acceptance includes backend receipt, capacity policy and outage-budget validation.

## Observe a dependency-stall drill

1. Record a healthy baseline, application instance identities, queue depth, and oldest work ages.
2. Use an approved test environment and disposable data for a drill that pauses a dependency or creates work.
3. Before changing production dependencies, obtain the operator's explicit authorization and recovery window.
4. While the authorized stall is active, collect snapshots and compare the queue ages with configured thresholds.
5. Verify that the collector enforces the intended duration and that the designated recipient receives the alert.
6. After the operator restores the dependency, observe queue recovery and verify the alert's recovery notification.
7. Retain observation times, condition transitions, and delivery acknowledgement without tokens or business payloads.

The snapshot check reads application state; the scheduled tick also persists notification state and sends to its configured webhook. Dependency control and work creation belong to the authorized drill operator. Production acceptance requires evidence from the deployed collector, real dependencies, and actual recipients.
