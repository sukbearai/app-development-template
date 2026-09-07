# Application recovery

An application bundle contains a PostgreSQL snapshot and the bytes of every committed upload referenced by that snapshot. It does not contain Kafka offsets, Redis state, pending uploads or a distributed snapshot. Kafka delivery remains at least once after recovery. Preserve restored receipt and idempotency records so replay does not repeat completed application mutations. External receivers must continue to enforce their own idempotency keys.

## Restore into isolated targets

1. Keep the replacement application's Web processes, workers, migrations and cleanup jobs stopped. Use a new database and a dedicated storage target accessible only to the recovery operator. Do not point the recovery configuration at the original database or bucket.
2. Run `pnpm app:backup:verify --directory /secure/backups/bundle`. Verification is read-only and checks archive and object integrity. Retain the source bundle unchanged throughout recovery.
3. Set DATABASE_URL to the new empty database. Set UPLOAD_STORAGE_DIR to a new absolute directory for local objects. For S3 objects, create a dedicated empty bucket and configure its endpoint, bucket and credentials. Restore preserves each object's provider; it does not convert local objects to S3. Mixed-provider backups require both targets.
4. Run `pnpm app:backup:restore --directory /secure/backups/bundle --confirm`. The tool refuses a nonempty database, nonempty local directory or nonempty S3 bucket. It verifies all bundle checksums before target writes, restores PostgreSQL in a transaction, and compares every restored file and committed intent with the bundle. It copies objects without overwriting keys and reads their bytes back to verify hashes. A final database transaction updates only committed upload locations and records a `backup.restore` audit with the source bindings and bundle checksum.
5. Keep all targets isolated on any error. A failed recovery may leave a restored database or some copied objects. The command exits unsuccessfully and does not start services or route traffic. Retry with a new empty database and new storage targets. Remove failed targets only after identifying them as belonging to that failed recovery. The tool does not automatically destroy them.
6. Apply newer migrations with `pnpm db:migrate` against the recovered database. Configure the application with the exact restored storage locations. Inspect noncommitted upload intents before enabling cleanup. Test administrator login, permissions, file metadata and object availability. Exercise a worker replay using the recovered receipt records, then enable traffic according to the deployment's admission procedure.

Pending, writing, cleanup and blocked upload intents keep their original state and storage binding. Their uncertain bytes are not in the bundle, and restoration does not declare those writes deleted. A new target binding prevents cleanup from touching their original storage. Investigate them against the source storage and writer evidence before resolving them. The restore audit records that this review remains outstanding.

## Resolve blocked uploads

A blocked intent requires evidence about its original writer and object store. An expired lease alone does not prove that an S3 PUT has stopped. For `upload_outcome_unknown`, stop the original writer and establish that the remote write has completed or can no longer complete. For `storage_changed`, first restore the exact recorded provider and storage location in an isolated operator configuration. For `cleanup_failed`, establish why deletion failed before retrying.

After collecting that evidence, run:

```sh
pnpm storage:resolve --id upload_intent_id --apply --confirm-writer-stopped --confirm-remote-write-settled
```

Both confirmation flags are operator attestations. The tool cannot prove remote completion on its own. The service rechecks committed file references and the storage binding before allowing cleanup. Never use these flags just to silence a blocked status. A committed reference must remain intact.

## Recovery evidence

Record the bundle checksum, source application version, migration ledger, target database name and storage locations in the incident record. Exclude credentials. Keep the restore audit and application checks with that record. A successful offline verification proves bundle integrity; a successful isolated restore proves database-reference coverage, object content and committed storage rebinding. Production traffic, external Kafka receivers and deployment cutover require their own checks.
