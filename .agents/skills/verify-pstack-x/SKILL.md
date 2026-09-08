---
name: verify-pstack-x
description: Verify pstack-x through real PostgreSQL, Chromium, HTTP and production serving. Use after changes to authentication, admin pages, uploads or API routes, and when browser evidence is requested.
---

# Verify pstack-x

Read [the feature map](features/README.md). The app lives in `apps/web`; shared contracts, database and server code live in `packages`. Authentication requires a migrated PostgreSQL database and explicitly initialized administrator.

## Isolated checks

Run from the repository root with Node 22.12+, pnpm 10.33.4, Docker and Chromium installed.

```bash
pnpm install --frozen-lockfile
PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:ui
pnpm test:production
node scripts/verify-app.mjs --production --ui
```

Each command creates its own ephemeral PostgreSQL container on a random loopback port, generates a test administrator password, migrates the database, and runs the real application. It closes owned processes and removes that container afterward. It does not use an existing DATABASE_URL. Evidence remains under `.verification/app/run-*`; browser traces, screenshots, source hashes and doctor output remain under `.verification/pstack-x/run-*`.

`test:e2e` exercises API persistence and rejection paths. `test:ui` exercises login, pre-hydration submission rejection, role and user creation, status changes, password reset/rotation, upload, navigation and logout. `test:production` builds and serves the production artifact, then runs API checks before and after database restore. `node scripts/verify-app.mjs --production --ui` also runs the same seven Playwright flows before and after restore. Redis, Kafka, S3 and backup recovery have separate integration tests; passing the browser checks does not prove those services.

## Existing isolated test setup

When a task already owns a disposable database, pass DATABASE_URL, APP_ORIGIN, UI_FLOW_ADMIN_ACCOUNT and UI_FLOW_ADMIN_PASSWORD to `.agents/skills/verify-pstack-x/scripts/run.sh`. The suite writes test users, roles, files and audit events. Do not point it at a production or shared database.

The helper owns its Web process and rejects an existing server at its selected port. `PSTACK_VERIFY_PORT` chooses another free port. vinext also locks `apps/web/.vinext/dev/lock.json`, so two concurrent checks need separate checkouts. Never disable the vinext lock or stop an unrelated process.

[doctor.mjs](scripts/doctor.mjs) verifies the lock owner PID, listening port, checkout and exact hello response before development browser checks. Its standalone development success confirms identity, not ownership permission.

Production checks use the server child owned by `verify-app.mjs`. Each launch writes a distinct ownership record containing its PID, process group, OS start time, checkout, origin, source hash and build hash. Doctor requires the owning harness in its ancestor chain, the child in the application directory, exclusive ownership of the port, and matching source and build hashes. Production mode never reads the development lock or reuses an unrelated server. Missing or stale ownership evidence fails the check.

## Evidence and cleanup

Inspect screenshots and traces along with assertions. An empty tracked diff does not imply a clean repository when files are untracked; source-sha256.json includes untracked source. Check run.log and exit-code.txt on startup failure. Evidence must survive cleanup.

The verification script prints its output directory. For a manual interrupted run, stop only its retained process handle, then check its port with `lsof -nP -iTCP:PORT -sTCP:LISTEN`. Do not delete another process's lock or remove shared Docker volumes.

Update the feature map and browser tests together when adding an entry point. Use the application UI for user flows; a direct API request does not prove form or navigation behavior.
