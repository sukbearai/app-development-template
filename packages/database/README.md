# Database ownership

`client.ts` owns the process pool and Drizzle database. Web service writes use `withTransaction`; every repository write requires its transaction argument. Worker operations use connections from this same pool.

Process environment wins over root `.env.local`, which wins over root `.env`. `.env.example` is documentation and is never loaded. `DATABASE_URL` is mandatory for connection commands.

- `pnpm --filter @pstack/database db:generate` generates SQL and snapshots from schema and adds new integrity hashes. Previously recorded SQL and snapshot hashes cannot change.
- `pnpm --filter @pstack/database migration:check` verifies SQL, snapshots and the journal without connecting.
- `pnpm --filter @pstack/database db:migrate` checks the ledger, serializes migrators with a PostgreSQL advisory lock, applies generated changes and verifies live columns.
- `pnpm --filter @pstack/database db:integration` inspects the selected database without writing.
- `pnpm --filter @pstack/database test:integration` creates and destroys its own isolated Docker database.

The ledger is `drizzle.drizzle_migrations` with `id`, `hash`, `created_at`. Backups must include both public data and this schema. The live schema check covers column names, SQL types, nullability, defaults, primary/unique keys, foreign keys and actions, validated CHECK expressions, and index columns/order/uniqueness/method/predicate. Before writing migrations it checks the snapshot for the currently applied version. SQL expression comparison preserves literal case and grouping, and normalizes only supported equivalent forms; unfamiliar expressions fail conservatively. It is not a general SQL semantic-equivalence prover.

## New databases

Only `migrations/template` runs by default. It contains no known password and creates no account. Initialize the first administrator with `pnpm --filter @pstack/server admin:bootstrap` and explicit `BOOTSTRAP_ADMIN_ACCOUNT` and `BOOTSTRAP_ADMIN_PASSWORD` environment values. Passwords must contain at least 16 characters. The command never prints passwords; repeating the same enabled administrator and password is a no-op.

## Existing reference-template databases

The three original migrations and metadata are retained byte-for-byte. They are historical input to isolated compatibility tests, not the new-install path. Never run the new baseline over an existing legacy ledger.

Back up the existing database, verify the backup, then explicitly run `pnpm --filter @pstack/database db:migrate:legacy`. The command accepts only the complete original checksummed three-entry history. It appends the incremental upgrade receipt and keeps all original ledger entries. Later generated migrations use the same ledger. Accounts with `plain:` password hashes are disabled and their sessions revoked.

For a disabled legacy administrator with a `plain:` hash, set a strong `BOOTSTRAP_ADMIN_PASSWORD` and invoke `pnpm --filter @pstack/server admin:bootstrap --recover-legacy`. This explicit recovery changes only the named disabled legacy administrator, verifies administrator permissions, revokes previous sessions and records audit/outbox events atomically. Ordinary bootstrap cannot reset an existing account. Existing modern-password accounts are never reset by this option.

Compatibility tests run only on disposable databases; they do not authorize changing an existing deployment.
