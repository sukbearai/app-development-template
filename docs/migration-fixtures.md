# Build migration compatibility fixtures

Run the builder with Node 22.13+, the repository's pinned pnpm, and Docker:

```bash
node scripts/build-migration-fixtures.mjs \
  --root /absolute/path/to/pstack-x \
  --output .verification/artifacts/migration-fixtures-001
```

Choose a new output directory below the source repository's `.verification/artifacts/`. The builder rejects existing output directories and symlink ancestors. Omit `--root` to export the current directory. The export includes tracked changes and untracked source, excluding ignored files and local environment secrets.

The builder runs a frozen install and installs hooks in its temporary checkout, then builds the `web` and `worker` Dockerfile targets for each variant:

- `base` contains the exported schema and migrations.
- `nullable` adds `app_roles.deployment_note` as nullable text through `pnpm db:generate`.
- `not-null` generates the next migration to make that column required. It first backfills existing rows with `fixture`. Only this newly generated SQL is edited; the prior integrity manifest is restored before the new migration is registered with `migration-check --update`.

Read `result.json` for image tags, immutable local image IDs, source hashes and cleanup status. Each variant directory retains its schema, generated migrations, integrity manifest and per-file source hashes. `run.log` records command output. These artifacts describe local builds; run the compatibility checks separately against the retained images.

The source checkout and its migrations are read-only. The builder removes its own temporary checkout after success or failure. It retains local images with unique tags and never publishes them. After completing compatibility checks, remove those tags with the generated argv file:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [program, ...args] = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (args.length > 2) execFileSync(program, args, { stdio: "inherit" });
' .verification/artifacts/migration-fixtures-001/remove-images.json
```
