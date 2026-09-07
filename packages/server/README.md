# Server services

This package has no Next.js or vinext imports. HTTP adapters call its public auth and product services. Database, role, session, audit, telemetry and outbox writes share an explicit Drizzle transaction. Disabling a user revokes all sessions; enabling that user does not reactivate them. Only active roles grant permissions. All managed writes require a session token and recheck permissions while holding the same identity transaction lock used by role/user revocation. Uploads recheck after body reading and keep that lock through metadata commit. Audit actor identity comes from the validated session. Updates preserve an enabled user with both `admin.read` and `admin.write` permissions.

`admin:bootstrap` initializes an empty user database. It requires `BOOTSTRAP_ADMIN_ACCOUNT` and `BOOTSTRAP_ADMIN_PASSWORD`, never prints the password, and verifies both credentials and privileges for repeated invocations. Existing legacy databases use the separately documented migration and recovery flow in the database package.

`readBoundedFormData` counts actual request bytes before parsing multipart data. Routes must call it instead of `request.formData()`. The bound includes 1 MiB multipart overhead. This remains a bounded in-memory upload endpoint, not a streaming upload product.

Uploads persist an intent before writing a deterministic object key. The upload and reconciliation paths lock the same intent. Metadata, audit, outbox and committed state share one transaction. Local writes use a managed temporary filename; cleanup removes only that intent's keys. Intents record their storage location, and cleanup refuses a changed root or bucket. `reconcileUploads({dryRun:true})` makes no persistent change. Failed cleanup stays retryable in the intent table; committed file references are protected. Invoke reconciliation periodically from an operations scheduler for crash recovery.

Redis uses the maintained client, URL authentication/database selection and a Lua increment/expiry operation. Memory rate limiting is per process. S3 uses the AWS SDK. Health queries PostgreSQL and checks Redis PING, S3 HeadBucket and Kafka metadata only when those drivers are selected. No ClickHouse analytics writes are implemented.

`withAccessLog` validates response bodies against the endpoint registry, preserves response cookies, maps unknown errors to a generic 500 and logs redacted fields. Cookie write origins use `APP_ORIGIN` when configured; forwarded headers cannot authorize an origin.

Run `test:unit` for local behavior and `test:integration` for disposable PostgreSQL and Redis service checks. Existing databases are never used by integration tests.
