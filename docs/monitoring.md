# Check runtime conditions

Use `pnpm monitor:check` to read one authenticated JSON snapshot from `GET /api/system/metrics`. The command reports current conditions and exits. Your collector owns the schedule, sustained-condition policy, alert routing, and delivery confirmation.

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

## Configure sustained alerts and verify delivery

1. Start with a collector interval of 30 seconds and retain timestamps plus reason codes.
2. Require pool-waiting, queue-age, and stale-publish-lease conditions to persist for a deployment-specific duration, for example five minutes.
3. Route dead letters, quarantine records, and blocked uploads to the responsible operator using your incident policy.
4. Configure a separate missing-observation alert so a stopped collector cannot appear healthy.
5. Assign recipients in your existing alert service.
6. Send an authorized test alert through that service and record the recipient's acknowledgement.

One check cannot establish a sustained condition. A green local test does not prove scheduled collection or recipient delivery. This command sends no messages and does not install a collector or change alert-service configuration.

## Observe a dependency-stall drill

1. Record a healthy baseline, application instance identities, queue depth, and oldest work ages.
2. Use an approved test environment and disposable data for a drill that pauses a dependency or creates work.
3. Before changing production dependencies, obtain the operator's explicit authorization and recovery window.
4. While the authorized stall is active, collect snapshots and compare the queue ages with configured thresholds.
5. Verify that the collector enforces the intended duration and that the designated recipient receives the alert.
6. After the operator restores the dependency, observe queue recovery and verify the alert's recovery notification.
7. Retain observation times, condition transitions, and delivery acknowledgement without tokens or business payloads.

The monitoring command remains read-only throughout this procedure. Dependency control and work creation belong to the authorized drill operator. Production acceptance requires evidence from the deployed collector, real dependencies, and actual recipients.
