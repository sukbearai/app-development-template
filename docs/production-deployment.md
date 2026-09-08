# Deploy behind an HTTPS ingress

Use this procedure after selecting your deployment host, ingress, and durable services. The repository's Compose file starts local dependencies; it does not provision a production ingress or a highly available database.

## Prepare the effective environment

1. Start from [one Web replica with local storage](../deploy/production/local.env.example) or [multiple replicas with S3, Redis, and Kafka](../deploy/production/replicas.env.example).
2. Replace every placeholder with a provisioned address or credential. Generate a separate `METRICS_TOKEN` with `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep that token separate from user sessions and business service credentials.
3. Supply the intended variables to the process or secret manager. Commands load root `.env.local`, then `.env`, without replacing process variables. Remove development fallbacks from the deployment workspace before checking it.
4. Set `APP_ORIGIN` to the public HTTPS origin. If you set `SESSION_COOKIE_SECURE`, use `true`. Without an override, the application derives the secure cookie flag from the HTTPS origin.
5. For local uploads, mount durable storage at the absolute `UPLOAD_STORAGE_DIR` and grant the application user write access. For S3, create the bucket and configure its HTTPS endpoint and credentials.
6. For multiple Web replicas, configure `RATE_LIMIT_DRIVER=redis` and a shared `REDIS_URL`. Use S3 or mount the same durable local storage on every replica and set `UPLOAD_STORAGE_SHARED=true`.

`UPLOAD_STORAGE_SHARED=true` is your declaration. The flag does not inspect mounts or prove that hosts share a filesystem. Verify cross-replica file access and restart persistence before admitting traffic.

If you enable Kafka, set `OUTBOX_PUBLISHER=kafka` on the Worker. Set `ASYNC_RUNTIME_PUBLISHER=kafka` on Web when Web only reports the Worker plan. Configure `SSL` or `SASL_SSL` and mount any private CA or client certificate files read-only. The preflight uses the Kafka package's parser, which reads those files but does not connect to brokers.

## Run the deployment preflight

Run `pnpm production:check` in the intended environment. The equivalent command is `pnpm config:check --deployment`.

The explicit deployment mode runs even when `NODE_ENV` is unset. It rejects invalid schema values, an HTTP origin, insecure cookie overrides, missing deployment credentials, known template credentials, incompatible replica storage, and invalid selected middleware configuration. Errors contain a variable name, stable code, and fixed explanation without input values. Unknown or repeated command arguments fail.

Set `METRICS_TOKEN` to 32 through 256 ASCII base64url characters without whitespace. Ordinary local runs allow an omitted or empty token, which disables metrics access. Deployment preflight requires a nonempty token.

Keep the container or service stop grace longer than `WEB_SHUTDOWN_TIMEOUT_MS`. If you declare `WEB_STOP_GRACE_PERIOD`, the preflight checks this relationship. Start with the examples' 30000 ms drain deadline and 40 s grace, and configure the actual process manager to use those values.

A successful preflight establishes static configuration validity. It does not check database connectivity, certificates served by remote endpoints, mounted storage, source-based abuse protection, backups, or recovery objectives. Ordinary `pnpm config:check` retains the local production policy and accepts loopback HTTP configurations.

## Prepare services and start the application

1. Terminate public TLS at your trusted ingress. Restrict direct access to the application listener and configure source-based abuse protection at that ingress. The application does not trust arbitrary forwarded IP headers.
2. Verify database, Redis, S3, and selected Kafka access from the application runtime identity. Confirm remote TLS trust and credential permissions there.
3. Run `pnpm db:migrate` against the intended database. For an older application database, follow the explicit legacy upgrade procedure in [database operations](../packages/database/README.md).
4. Initialize the administrator with explicit `BOOTSTRAP_ADMIN_ACCOUNT` and `BOOTSTRAP_ADMIN_PASSWORD` using `pnpm admin:bootstrap`.
5. Build and start the Web image, then start the Worker if selected. Keep the migration job separate and require its successful exit before admitting requests.
6. Check readiness and perform a login, permitted mutation, and upload through the public ingress. Verify file metadata through each replica and verify bytes through the configured storage. Repeat after a restart. The template has no file download API.
7. Stop a replica under admitted traffic and verify that it finishes within the configured grace. Check durable state before retrying interrupted mutations or uploads.

## Record operational acceptance

Protect `GET /api/system/metrics` with the dedicated bearer token and restrict scraper access at the ingress. Read [operations](operations.md) for health, backlog, quarantine, and recovery procedures. Process, HTTP, connection-pool, and upload metrics describe one Web process. Collect each replica and account for restarts when calculating counter changes. Database aggregates describe shared durable state; do not sum those repeated observations across replicas.

Start `UPLOAD_MAX_CONCURRENT` at 2 and increase it only after measuring your workload and memory budget. The limit accepts no more than that many uploads per Web process; overload returns HTTP 503 with `UPLOAD_BUSY` and `Retry-After`. File copies and allocator retention mean that concurrency multiplied by `UPLOAD_MAX_BYTES` is not an RSS guarantee.

Run the isolated production capacity check with `pnpm test:capacity` before choosing a larger limit. Record its machine, build, request distribution, error counts, upload rejection rate, latency, and peak memory. Local capacity evidence does not establish production cluster capacity or Worker throughput.

Before enabling production traffic, rehearse restore into an isolated target and record your measured recovery point and recovery time against the required RPO and RTO. Exercise stalled delivery and consumption separately, verify that alerts reach an operator, and retain evidence of cross-replica storage and restart persistence. A static preflight or green CI does not replace these checks.
