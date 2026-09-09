# Execute a verified release

`release:plan` still prints immutable image references without changing containers. Execution supports one explicitly configured Docker Compose project on a local Unix Docker socket. Install Node.js, Python 3, Docker Compose and the GitHub CLI on the deployment host. Python acquires an advisory lock on a file descriptor held by Node; process exit releases the lock. Store state on a local filesystem.

Copy `deploy/targets/local-compose.example.json` to a host-owned target file. Set the repository, Docker context and exact socket endpoint, absolute Compose and environment paths, platform and public `/api/system/health` URL. Use the repository Compose file followed by `release-images.yml`. The target files are trusted executable deployment configuration and must be writable only by the deployment operator. Never place credentials in the target JSON. Keep the environment file private.

Provision PostgreSQL, Kafka, storage, ingress and their backups separately. The executor changes only the selected application services and a retained migration job. It neither provisions dependencies nor bootstraps an administrator. First installation therefore needs its dependency services and production configuration before execution. Administrator bootstrap remains an explicit subsequent operation.

Download the complete release bundle into one directory, preserving its relative paths, including tested archives, verification reports, registry manifests, security reports and the detached `release.json.sigstore.json` signature. The executor verifies the published GitHub asset and tag, exact image identities, current scan policy and the repository's release workflow signature. No CLI switch disables trust verification. Large bundles require enough disk space for a private retained copy.

```sh
pnpm release:plan --root /srv/releases/v1.0.0 --manifest artifacts/release/release.json --repo YOUR_ORGANIZATION/YOUR_REPOSITORY
pnpm release:apply --root /srv/releases/v1.0.0 --manifest artifacts/release/release.json --target /etc/pstack/target.json
pnpm release:status --target /etc/pstack/target.json --json
pnpm release:resume --root /srv/releases/v1.0.0 --manifest artifacts/release/release.json --target /etc/pstack/target.json
```

The executor hashes the target, Compose files, environment file and Docker daemon identity. It verifies Compose project labels, selected services, immutable image references, configuration IDs and platform. An existing application project without committed state is rejected. A missing established state file, malformed state, changed target input or unknown live image also fails closed. Environment rotation and topology changes need a reviewed state migration procedure; this version has no automatic rebind or adoption command. Preserve state together with the deployment configuration during backup and recovery.

A deployment persists `prepared`, `migrating`, `applying`, `checking` and `committed` stages. Upgrades stop the previous application with Compose's configured grace periods before migration. The migration uses the exact Web image and retains a named container labelled with the operation ID. Resume inspects that container and accepts only exit zero. If the job disappeared after launch intent was recorded, the operation reports `MIGRATION_OUTCOME_UNKNOWN` and refuses automated retry. Preserve the job and investigate PostgreSQL's migration ledger before any manual recovery. The executor never downgrades a database or deletes application volumes.

Acceptance requires exact running image IDs, healthy selected containers, an `ok` JSON response from the configured health URL and the worker's live health command when selected. This checks application and dependency readiness. It does not replace authenticated business acceptance, target TLS review, capacity, HA or restore verification. `status` inspects local state and live containers without network signature checks and returns `trustVerified: false`; it cannot renew release trust.

Repeated application of the committed release repeats live readiness checks. A pending operation permits only `resume` with its exact original manifest. A failed initial installation stays available for inspection. State and receipts are private, and command output contains fixed failure codes rather than expanded Compose environments.

# Prove and perform a rollback

Automated upgrades require equal migration-ledger hashes, equal worker recovery protocols and a pairwise rollback proof in the new release. Version ordering or equal schema alone cannot populate `rollbackVersions`.

Before publishing a candidate, run its real application drill against a verified published predecessor. The candidate checkout must be clean and match the candidate archive evidence. Supply a fresh empty output directory inside that checkout.

```sh
node scripts/release-rollback-proof.mjs \
  --root /srv/build/pstack \
  --candidate artifacts/candidate/candidate.json \
  --evidence artifacts/verification/index.json \
  --previous-root /srv/releases/v1.0.0 \
  --previous artifacts/release/release.json \
  --repo YOUR_ORGANIZATION/YOUR_REPOSITORY \
  --context default \
  --output artifacts/rollback/v1.0.1
```

`--previous-root` selects the downloaded predecessor bundle directory and defaults to `--root`. Keep the old bundle separate when both releases use the same relative filenames. The command verifies its original manifest and referenced bytes in that directory; it does not rewrite signed paths. Candidate inputs and proof output stay under `--root`.

The drill creates its own PostgreSQL, Kafka and upload volumes. It starts predecessor, candidate and predecessor again, creates authenticated roles and uploads, checks that later processes can read earlier data, and checks recovery and duplicate delivery through Kafka and PostgreSQL. It records exact candidate and predecessor source/image identities. Only successful behavior and cleanup produce `rollback-proof.json`. Pass that proof and the predecessor manifest to release manifest creation. A first release has no predecessor proof and an empty rollback list.

```sh
pnpm release:rollback --root /srv/releases/v1.0.0 --manifest artifacts/release/release.json --target /etc/pstack/target.json
```

Explicit rollback checks the committed release's proof against the exact requested predecessor and skips migration. An upgrade that fails during application replacement or readiness automatically restores the predecessor only while the stored proof and both release policies remain valid. A successful restoration retains the candidate operation as `failed`, sets `restored: true`, keeps the predecessor as current and exits nonzero. A failed restoration preserves the operation for `resume`; it does not claim success or change the database schema.

# Verification commands

```sh
node --test scripts/tests/deployment-executor.test.mjs scripts/tests/rollback-proof.test.mjs
node scripts/test-deployment-compose.mjs
```

The second command creates a disposable Compose project with a pinned Node fixture image. It checks real container creation, retained migration evidence, persistent volume contents, idempotent application and convergence after stopping a service. It uses a programmatic trust fixture and does not authorize rollback versions. The application drill above is the producer of pairwise compatibility evidence. GitHub publication/signing and execution on the actual deployment host remain separate acceptance steps.
