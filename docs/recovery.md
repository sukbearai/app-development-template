# Application recovery

An application bundle contains a PostgreSQL snapshot and the bytes of every committed upload referenced by that snapshot. Version 2 also records a Kafka recovery checkpoint when Kafka is enabled. The checkpoint contains committed partition offsets captured before the database snapshot. It does not contain Kafka message bytes, Redis state or pending uploads.

Kafka recovery replays retained broker records into the restored database. It uses a new permanent Kafka transport group and preserves the original logical consumer group and idempotency keys. The original transport group's offsets are unchanged. This resumes processing against the retained Kafka stream; it is not a strict point-in-time rollback of all systems. External receivers must enforce their own idempotency keys because effects completed after the database snapshot may be delivered again.

## Restore into isolated targets

For Kafka deployments, install migration `0003_bizarre_roughhouse` and the matching Worker before creating a version 2 backup. Configure `OUTBOX_PUBLISHER=kafka`, `KAFKA_BROKERS`, `KAFKA_CONSUMER_GROUP_ID`, `ASYNC_RUNTIME_TOPICS` and the required TLS/SASL credentials for backup and recovery. Keep the logical group and complete topic set unchanged.

1. Keep the replacement application's Web processes, workers, migrations and cleanup jobs stopped. Use a new database and a dedicated storage target accessible only to the recovery operator. Do not point the recovery configuration at the original database or bucket.
2. Run `pnpm app:backup:verify --directory /secure/backups/bundle`. Verification is read-only and checks archive and object integrity. Retain the source bundle unchanged throughout recovery.
3. Set DATABASE_URL to the new empty database. Set UPLOAD_STORAGE_DIR to a new absolute directory for local objects. For S3 objects, create a dedicated empty bucket and configure its endpoint, bucket and credentials. Restore preserves each object's provider; it does not convert local objects to S3. Mixed-provider backups require both targets.
4. Run `pnpm app:backup:restore --directory /secure/backups/bundle --confirm`. For a Kafka checkpoint, add `--recover-kafka`. The tool refuses a nonempty database, nonempty local directory or nonempty S3 bucket. It verifies all bundle checksums before target writes, restores PostgreSQL in a transaction, and compares every restored file and committed intent with the bundle. It copies objects without overwriting keys and reads their bytes back to verify hashes. A database transaction updates only committed upload locations and records a `backup.restore` audit with the source bindings and bundle checksum.
5. Keep all targets isolated on any error. A failed recovery may leave a restored database or some copied objects. The command exits unsuccessfully and does not start services or route traffic. Retry with a new empty database and new storage targets. Remove failed targets only after identifying them as belonging to that failed recovery. The tool does not automatically destroy them.
6. Apply newer migrations with `pnpm db:migrate` against the recovered database. Configure the application with the exact restored storage locations. Inspect noncommitted upload intents before enabling cleanup. Test administrator login, permissions, file metadata and object availability. For Kafka recovery, start one Worker with the original logical group and full topic set. Verify missing events complete and existing receipts do not execute again before enabling traffic.

Pending, writing, cleanup and blocked upload intents keep their original state and storage binding. Their uncertain bytes are not in the bundle, and restoration does not declare those writes deleted. A new target binding prevents cleanup from touching their original storage. Investigate them against the source storage and writer evidence before resolving them. The restore audit records that this review remains outstanding.

## Resume Kafka processing

For a version 2 bundle with a Kafka checkpoint, add `--recover-kafka` to step 4. The command checks the broker before restoring, creates a fresh transport group, initializes every partition from the checkpoint and reads the offsets back. It stores the permanent transport binding in `app_kafka_recovery`; Worker startup reads that binding automatically. Do not change `KAFKA_CONSUMER_GROUP_ID` or manually copy the transport group into it. Subsequent backups capture the bound transport group's current progress. Restarts do not reapply the original checkpoint.

The tool creates `pstack_restore_guard` in the empty target before `pg_restore` starts. Worker startup and application backup refuse a database with this marker. Successful restoration removes it only after objects and Kafka initialization are complete. A crash, failed object copy or partial Kafka initialization leaves the marker. Keep the target isolated and retry with new empty targets. Do not remove the marker to bypass a failed restore.

Recovery requires the same Kafka cluster, the complete partition set and `cleanup.policy=delete`. Retain the required records for the age of the backup and the duration of replay. Missing or reset transport offsets, expired records, compacted topics and changed partition topology cause failure. Runtime checks also stop recovery if retention removes required records after startup. Deleted and recreated topics with the same name are unsupported because the current client cannot verify their lineage. The restored transport supports one consumer; ordinary deployments without a recovery binding retain their existing concurrency behavior.

Version 1 bundles require `--data-only` and cannot initialize Kafka recovery. Version 2 bundles with Kafka disabled support normal non-Kafka restoration with `--confirm`; they cannot initialize Kafka recovery either. Explicit `--data-only` restores database and objects while leaving Worker startup blocked. The lower-level `backup:restore` command remains a database-only tool and does not establish application or Kafka recovery readiness. Use the application bundle workflow for a running Kafka application.

Do not roll a recovered deployment back to a Worker version that ignores the recovery binding or guard. Fence the original deployment before cutting over to the restored database and storage. Keep the logical consumer identity stable throughout replay and future restarts.

## Resolve blocked uploads

A blocked intent requires evidence about its original writer and object store. An expired lease alone does not prove that an S3 PUT has stopped. For `upload_outcome_unknown`, stop the original writer and establish that the remote write has completed or can no longer complete. For `storage_changed`, first restore the exact recorded provider and storage location in an isolated operator configuration. For `cleanup_failed`, establish why deletion failed before retrying.

After collecting that evidence, run:

```sh
pnpm storage:resolve --id upload_intent_id --apply --confirm-writer-stopped --confirm-remote-write-settled
```

Both confirmation flags are operator attestations. The tool cannot prove remote completion on its own. The service rechecks committed file references and the storage binding before allowing cleanup. Never use these flags just to silence a blocked status. A committed reference must remain intact.

## Recovery evidence

Record the bundle checksum, source application version, migration ledger, target database name and storage locations in the incident record. Exclude credentials. Keep the restore audit and application checks with that record. A successful offline verification proves bundle integrity; a successful isolated restore proves database-reference coverage, object content and committed storage rebinding. Production traffic, external Kafka receivers and deployment cutover require their own checks.
