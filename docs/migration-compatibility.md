# Migration compatibility and application rollback

The deployment executor keeps the active application release separate from the database schema release. Rolling an application back preserves the newer schema and never runs an older migration. Each later deployment checks its requested application against that retained schema release before changing containers.

A changed migration ledger requires a version 2 pairwise rollback proof. The proof binds both releases' source and image identities, both raw migration integrity files and their SHA-256 hashes, and the PostgreSQL migration rows observed before and after the candidate image's real `db:migrate` command. Historical SQL and snapshot hashes must remain unchanged, and the candidate journal must preserve the predecessor journal as a prefix. Version 1 proofs remain valid only for identical ledgers.

The producer starts the predecessor on its own disposable PostgreSQL and Kafka services and writes authenticated role and upload data. While that application stays running, it executes the candidate migration. It continuously writes through the predecessor during migration with a two-second request deadline and requires zero failed writes. It verifies that both predecessor containers retain their IDs, start times and restart counts. It then exercises the migrated database without restarting those containers. Both applications and workers run together and read each other's data. It also stops the predecessor workers and requires the candidate worker alone to process a new event. Finally, it stops the candidate, verifies the predecessor again, and checks durable worker recovery and duplicate delivery without downgrading the database. A successful migration alone does not authorize rollback.

Create a release proof with `scripts/release-rollback-proof.mjs` and the verified candidate artifacts and published predecessor described in [deployment execution](deployment-execution.md). The signed release manifest retains a content-hashed reference to the proof, which in turn references the matching runtime report. The runtime validates those references, identities, outcomes and migration history. Handwritten rollback version lists and acceptance-only image reports cannot replace that chain.

For local verification before publication, run the actual images through the same drill:

```sh
node scripts/test-migration-compatibility.mjs \
  --previous-web previous-web:local \
  --previous-worker previous-worker:local \
  --candidate-web candidate-web:local \
  --candidate-worker candidate-worker:local \
  --context orbstack \
  --output /tmp/migration-compatibility.json
```

The command resolves immutable image IDs and owns its temporary containers, volumes and network. A failed compatibility check exits nonzero and preserves its stage, image IDs, migration outcome when available, and cleanup result. This report demonstrates the local images' behavior; it is not a signed release proof.

Build reproducible local images with the [migration fixture builder](migration-fixtures.md). Use an additive nullable-column migration as a positive case. For a negative case, add a required column without a default while backfilling existing rows in the new migration. Migration can then succeed, but an old application's insert fails. Generate these migrations only in disposable fixture checkouts; never modify applied migrations in an application repository.

The runtime proof covers the exercised operations and stored records. New application features need representative compatibility checks in this drill. Use staged expand/contract migrations when a schema change would otherwise invalidate the intended rollback window.
