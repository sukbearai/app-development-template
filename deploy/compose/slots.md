# Deploy through two application slots

Use `deploy/targets/slots.example.json` with `pnpm release:apply --target /absolute/target.json --root /verified/bundle --manifest release.json`. Version 2 targets manage two application projects and one stable Nginx container. Version 1 targets retain their existing deployment behavior.

Provision PostgreSQL, Kafka, Redis, storage and the external Docker network before the first application deployment. The slot file references that network and an existing external upload volume. Set `PSTACK_UPLOAD_VOLUME` to the volume name, and configure the infrastructure service addresses in the production environment. Slot cleanup removes application containers only. It never deletes networks, volumes or databases.

Set `RATE_LIMIT_DRIVER=redis`. For uploads use S3, or set `UPLOAD_STORAGE_SHARED=true` with the existing shared volume. The executor supplies `WEB_REPLICAS` as twice the target Web count because both slots overlap during updates. Size PostgreSQL connection limits for this overlap, including workers and migration connections. Do not set a fixed `WORKER_ID`; worker processes need distinct ownership identities. Both generations use the same Kafka consumer group.

The proxy binds the configured port on `127.0.0.1`. Point the host's HTTPS ingress to that port. Application containers publish no host ports. The proxy preserves Host and the target HTTPS scheme. Its generation endpoint lets the executor distinguish a completed switch from an interrupted state write. The configured public readiness URL must reach this proxy without caching or rewriting its generation header.

A deployment verifies each candidate replica before switching traffic. Nginx reloads its route gracefully, and the executor waits until the previous Nginx workers exit before removing retired application containers. A drain timeout leaves the candidate serving and records resumable cleanup. Run `pnpm release:resume` with the same target and manifest to continue. A pending operation rejects a different release. `release:status` reports the observed route and retained state.

Database schema state is separate from the active application. A compatible application rollback keeps the newer schema. Changed migration histories require the exact signed compatibility proof, including the previous application's behavior on the migrated database. An unknown migration job outcome requires investigation; resume does not blindly repeat the migration. This deployment path does not support destructive schema changes without compatibility evidence.

The stable proxy and both slots run on one Docker host. The deployment test verifies request continuity on that host; it does not establish host failover or production capacity. The existing signed release verification remains in force for deployment, resume and restoration.

Run `node scripts/test-deployment-slots.mjs` for the disposable Docker runtime test. It tests routing, replicas, interruptions and data retention with a Node HTTP fixture. Use the release rollback drill for real application and migration compatibility evidence.
