# Server services

This package has no Next.js or vinext imports. HTTP adapters call its public auth and product services. Database, role, session, audit, telemetry and outbox writes share an explicit Drizzle transaction. Disabling a user revokes all sessions; enabling that user does not reactivate them. Only active roles grant permissions. All managed writes require a session token and recheck permissions while holding the same identity transaction lock used by role/user revocation. Uploads check authorization after body reading and again in the final metadata transaction; external object writes do not hold the identity lock. Audit actor identity comes from the validated session. Updates preserve an enabled user with both `admin.read` and `admin.write` permissions.

`admin:bootstrap` initializes an empty user database. It requires `BOOTSTRAP_ADMIN_ACCOUNT` and `BOOTSTRAP_ADMIN_PASSWORD`, never prints the password, and verifies both credentials and privileges for repeated invocations. Existing legacy databases use the separately documented migration and recovery flow in the database package.

`readBoundedFormData` counts actual request bytes before parsing multipart data. Routes must call it instead of `request.formData()`. The bound includes 1 MiB multipart overhead. This remains a bounded in-memory upload endpoint, not a streaming upload product.

Uploads persist an intent before writing a deterministic object key. The upload and reconciliation paths lock the same intent. Metadata, audit, outbox and committed state share one transaction. Local writes use a managed temporary filename with file and directory sync; cleanup removes only that intent's keys. Intents record their storage location, and cleanup refuses a changed root or bucket. `reconcileUploads({dryRun:true})` makes no persistent change. Failed cleanup stays retryable in the intent table; committed file references are protected. Invoke reconciliation periodically from an operations scheduler for crash recovery.

Redis uses the maintained client, URL authentication/database selection and a Lua increment/expiry operation. Memory rate limiting is per process. S3 uses the AWS SDK. Health queries PostgreSQL and checks Redis PING, S3 HeadBucket and Kafka metadata only when those drivers are selected. No ClickHouse analytics writes are implemented.

`withAccessLog` validates response bodies against the endpoint registry, preserves response cookies, maps unknown errors to a generic 500 and logs redacted fields. Cookie write origins use `APP_ORIGIN` when configured; forwarded headers cannot authorize an origin.

HTTP routes let exceptions reach `withAccessLog` instead of converting them with a local catch. This boundary records unexpected failures with the request trace ID before returning a generic error response. Production error diagnostics retain approved error codes, bounded source locations and Error causes. They omit arbitrary error messages, SQL details, parameters and request credentials.

Run `test:unit` for local behavior and `test:integration` for disposable PostgreSQL and Redis service checks. Existing databases are never used by integration tests.

## Password lifecycle

Password characters, including surrounding spaces, are preserved by login, user creation, rotation and bootstrap. Login and current-password verification preserve compatibility with existing longer passwords. New user and API replacement passwords require 8–256 characters; bootstrap and operator recovery require 16–256. Older API-created passwords were trimmed before hashing: enter that stored trimmed value, or replace the password. There is no automatic trimming fallback.

`auth.changePassword` accepts `{currentPassword,newPassword}` and returns `{reauthenticate:true}` through tRPC. It verifies the current password and revokes every session, including the caller's session. `users.resetPassword` accepts `{id,newPassword}` and returns `{updated:true}`. It requires `admin.write` and rejects resetting the caller's own account; use the current-password operation for that. Both writes revalidate the session under the identity transaction lock, reject a changed credential snapshot, and atomically record the password hash, session revocations, audit and outbox event. Passwords and hashes are excluded from those events.

An operator with database credentials can recover an existing enabled administrator with modern scrypt credentials:

```sh
read -rs ADMIN_RECOVERY_PASSWORD
export ADMIN_RECOVERY_PASSWORD
pnpm --filter @pstack/server admin:recover --account admin --confirm
unset ADMIN_RECOVERY_PASSWORD
```

The CLI requires explicit confirmation, accepts the replacement only through `ADMIN_RECOVERY_PASSWORD`, and does not print credentials. Recovery verifies current administrator rights, revokes all sessions, and records `admin.credentials.recovered` with `channel: operator-cli`. This does not enable disabled users or elevate a regular user. Disabled legacy accounts still use the documented legacy recovery procedure.

## Login budgets

`LOGIN_RATE_LIMIT_MAX` bounds attempts per account; `LOGIN_RATE_LIMIT_GLOBAL_MAX` defaults to 200 attempts per window across all accounts. Successful logins consume both budgets until expiry. Invalid JSON and schema failures consume the overall budget. The limiter does not derive identities from caller-controlled forwarded headers. Apply trusted ingress source controls separately when required.

Memory mode retains active buckets when `LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS` is full and rejects new keys until capacity expires. It is suitable for one Web process. Set `WEB_REPLICAS` to the deployed process count; more than one requires `RATE_LIMIT_DRIVER=redis`. All replicas must use the same Redis URL/database and budget settings. Redis counters and expiry are atomic and command failures reject requests instead of falling back to per-process memory.

Upload I/O now runs outside the identity lock, between short begin and final authorization transactions. A writing lease fences late commits. Failed/expired uncertain writes remain blocked, and cleanup cannot delete them without explicit operator evidence. S3 PUT uses one attempt so a retry cannot hide an older in-flight write. `storage:resolve` is an operator procedure after the writer and remote request have settled, not an automatic timeout shortcut.

Local writes sync the file, rename, and sync the directory/ancestors; deletion syncs its directory. Tests exercise actual filesystem calls, not power loss. Cleanup uses bounded keyset pages, excludes terminal and blocked rows from automatic rescanning, and records location changes so they do not starve current-location work.

Existing login/current passwords retain historical length compatibility and exact characters. New passwords are 8–256 characters; bootstrap/operator recovery require 16–256. No whitespace fallback is used for old credentials that were originally trimmed at creation.

## Internal tRPC transport

`trpc-router.ts` owns AppRouter and the domain routers. `trpc-handler.ts` adapts Web Requests, enforces request size, origin and login admission, and preserves cookies and trace headers. Procedures use existing services and Zod parsers. The Web route exports this handler for GET and POST. Browser imports of AppRouter must be type-only. External REST remains in the contracts operation registry.
