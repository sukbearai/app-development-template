# Operations

Node 22.12 or newer and pnpm 10.33.4 are required. Install dependencies with `pnpm install --frozen-lockfile`.
Run `pnpm template:init --name my-project` to rename the root package and create `.env` without overwriting an existing file. Workspace package names stay stable. The initializer does not copy maintenance history, credentials or previous project state.

## Local services

`pnpm local:init` creates root `.env` from the development example. Set ports and credentials there. Explicit process variables take precedence over root `.env.local`, which takes precedence over root `.env`. `.env.example` is never loaded by database or backup commands. An explicit empty database URL causes failure.

`pnpm local:up` starts PostgreSQL. `pnpm local:up -- app` builds and starts the production vinext application after the migration job completes. Add `redis`, `kafka`, `storage` or `analytics` for optional dependencies. `worker` enables the app and Kafka profiles and starts the durable receipt/demo worker. Storage initializes the configured MinIO bucket. Set `UPLOAD_STORAGE_DRIVER=s3` when selecting the storage profile for application uploads. ClickHouse is an available service; this template has no analytics ingestion pipeline.

The local CLI derives the container DATABASE_URL from POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB and encodes reserved characters. Direct Docker Compose callers must explicitly set COMPOSE_DATABASE_URL to an encoded URL using the container host `postgres:5432`. Host commands continue to use DATABASE_URL.

Default host ports are Web 3100, PostgreSQL 55432, Redis 56379, Kafka 59092, MinIO 59000/59001 and ClickHouse 58123. Published ports bind to loopback. Change them before starting a second checkout. Kafka advertises `kafka:9092` to containers and `localhost:59092` to host clients, following KAFKA_PORT when changed.

`pnpm local:status`, `pnpm local:logs` and `pnpm local:down` operate only on the project derived from this checkout's absolute path. Down preserves volumes. No command stops unrelated Compose projects or removes all Docker resources. Moving a checkout changes its project name; stop the old checkout before moving it.

For host development, run `pnpm db:migrate`, initialize an administrator with `BOOTSTRAP_ADMIN_ACCOUNT` and `BOOTSTRAP_ADMIN_PASSWORD` using `pnpm admin:bootstrap`, then run `pnpm dev`. Migration generation and execution belong to `packages/database`. Never invoke a second migration owner in the Web package.

## Images

`docker build --target web -t my-project-web .` builds the vinext production artifact and starts it with `vinext start`. The worker target starts the workspace entrypoint with tsx, so the image retains the required TypeScript runtime and workspace sources. Both targets run as the Node user. The migration service reuses the Web image and exits before Web starts.

The Compose configuration is for isolated development. Production TLS, secret distribution, managed database policy, image registry promotion and replica coordination remain deployment decisions for the consuming project.

## Database backups

`pnpm backup:create --output backups/new-backup` requires a new output directory and explicit DATABASE_URL. It exports a repeatable-read PostgreSQL snapshot, reads the database migration ledger, and dumps both `public` and `drizzle` using that same snapshot. The manifest contains the actual ledger rows, latest database migration timestamp, database version, ledger hash, structural schema hash and archive SHA-256. It does not infer the applied schema version from local migration files.

`pnpm backup:verify --file backups/new-backup/BKP-....dump` requires a complete manifest, matching size and SHA-256, and a readable pg_restore listing containing application data and the migration ledger. Missing checksums fail verification.

Restore into a new empty database with an explicitly supplied target DATABASE_URL:

```sh
DATABASE_URL=postgres://app:password@localhost:55432/restored_app pnpm backup:restore --file backups/new-backup/BKP-....dump --confirm
```

Restore verifies the backup first, refuses nonempty target schemas, and uses a single PostgreSQL transaction with exit-on-error. It omits the archive entry that recreates the default public schema and never drops existing objects. A conflicting object created after the precheck aborts the transaction. It then compares the restored ledger and structural schema hash. Run `pnpm db:migrate` against the restored database to apply newer template migrations. Switch application traffic only after application checks pass. The tool does not overwrite an existing application database.

Install matching PostgreSQL client tools or set `POSTGRES_TOOLS=docker` and `POSTGRES_TOOL_IMAGE=postgres:17-alpine`. Docker tools use host networking for loopback databases on Linux. On Docker Desktop they map loopback to `host.docker.internal`; remote hostnames remain unchanged. Passwords are passed in process environment, not command arguments. Backup archives contain sensitive application data and need access-controlled storage. This backup covers PostgreSQL, not uploaded objects, Kafka offsets or a distributed snapshot.

## Verification

`pnpm test:tools` checks environment precedence, destructive-operation guards, project ownership and gate routing. `pnpm test:backup` starts its own uniquely named ephemeral PostgreSQL container on a dynamically assigned loopback port and performs a real dump/verify/restore round trip, including conflict rollback. It ignores configured DATABASE_URL and removes only its own container in cleanup. BACKUP_TEST_POSTGRES_IMAGE selects the test image and defaults to postgres:17-bullseye.

`pnpm pr:verify` runs type checks, contracts, migration integrity, tool tests, unit/integration tests and a production build for every path, including unknown paths and a clean checkout. Web-related changes add browser tests. `--full` always adds database integration API, browser and production-serving checks, even when the tree is clean. Missing tools or unavailable services fail the gate. `artifacts/pr-verify/summary.json` records passed, failed and unexecuted gates.

CI provisions PostgreSQL, installs Chromium, migrates and bootstraps the isolated database, runs the full gate, exercises backup/restore, validates all Compose profiles, and runs `pnpm test:containers`. That command builds both Docker targets, starts isolated PostgreSQL/Kafka plus Web/worker images, and verifies real API requests, event receipts and worker shutdown. It removes its own containers, network and tags and retains evidence.

## Application backup and recovery

Use `pnpm app:backup:create --output backups/new-application-bundle` to include PostgreSQL and the uploaded objects referenced by its snapshot. Set DATABASE_URL and an absolute UPLOAD_STORAGE_DIR explicitly. For S3 references, also supply OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY. The command refuses a source location that differs from the committed upload intent. A database containing both local and S3 references requires both configurations.

`pnpm app:backup:verify --directory backups/new-application-bundle` checks the completion marker, both manifests, the database archive, and the length and SHA-256 of every included object. It does not start PostgreSQL or prove that the object list covers the archived database; restore performs that comparison against the actual restored rows.

The bundle copies only committed file references visible in the same exported PostgreSQL snapshot as the dump. This relies on the application's immutable committed keys and its rule that cleanup never deletes a referenced object. Keep external bucket lifecycle deletion, overwrite jobs and manual storage edits disabled while creating the backup. Missing objects, legacy unbound intents and source binding mismatches fail the command. A failed bundle must not be published. The tool syncs copied files and directory entries, then publishes the manifest and COMPLETE marker through synced temporary files and rename. Only a bundle with a valid COMPLETE marker can pass verification. The bundle contains sensitive data and must be stored in access-controlled backup storage.

See [Recovery](recovery.md) for restoration, worker replay and blocked upload handling. `pnpm test:app-backup` owns disposable PostgreSQL and MinIO containers plus temporary local storage. It restores both object providers, checks content and the new committed bindings, verifies the recovery audit, and exercises missing/corrupt objects, occupied targets and database-reference mismatch refusal. It does not use the configured application database or existing buckets.

## History retention

Choose the retention age according to the application's audit obligations and recovery window. No retention age or destructive schedule is enabled by default. Preview one bounded batch with `pnpm history:prune --days 90 --batch-size 100`. The command requires an explicit age in days, defaults to dry-run and prints the cutoff and eligible counts. Use `--apply` only after reviewing that policy and the preview. Batch size is 1 to 1000 per history table; rerun or schedule bounded invocations instead of one unbounded transaction.

The retention operation removes eligible completed task history, published outbox payloads, telemetry and audit events older than the cutoff. It compacts completed request envelopes with valid `v2:` identity hashes and eligible receipt results while retaining their idempotency keys and identity hashes. Legacy request envelopes stay available for payload comparison; they are not automatically rehashed or compacted. Active tasks, retryable work, dead letters and permanent deduplication identities remain available. Database backups made before pruning retain the older records under the backup retention policy. Manage backup expiry separately from application history.
