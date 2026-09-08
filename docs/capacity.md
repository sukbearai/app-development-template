# Local capacity measurements

Run `pnpm test:capacity` in a checkout without active `.env` files. Node 22.12+, pnpm, Docker, `ps` and `lsof` are required. Install dependencies and run `pnpm hooks:install` first. The command builds the production application, creates an isolated PostgreSQL container and administrator, and measures real HTTP operations. It never accepts a URL or database argument and ignores inherited application and middleware settings.

```sh
pnpm test:capacity --concurrency 4 --requests 24 --upload-bytes 262144
# Equivalent without the package alias:
node scripts/verify-app.mjs --production --capacity --concurrency 4 --requests 24 --upload-bytes 262144
```

`--capacity` requires `--production` and excludes `--ui`. Unknown arguments fail before resources are created.

| Argument | Default | Range |
| --- | --- | --- |
| `--concurrency` | 4 | 1–64 |
| `--requests` | 24 per operation | 1–1,000 |
| `--upload-bytes` | 262,144 | 1–10,485,760 |

Requested upload bytes across the run cannot exceed 1 GiB. HTTP requests have 15-second deadlines, including response bodies, and the complete workload has a five-minute deadline. Interruptions stop new requests and abort active ones. These limits bound local resource use; they are not service thresholds.

Every response is checked against the canonical HTTP operation contract, including metrics and error envelopes. A 200 response with malformed data fails the run.

CI runs the default bounded capacity command after the full verification gate. It checks correctness and resource cleanup without imposing machine-specific latency targets.

The four sequential phases perform administrator logins, authenticated role reads, role creation and multipart uploads. Each phase issues the requested count using the specified concurrency. Login limits are set to the request count plus ten for this isolated fixture. The application uses one replica, a memory rate limiter, local storage and an upload concurrency limit of two. Kafka publication is disabled. This does not exercise Redis, Kafka or S3.

A separate overload probe holds two incomplete upload bodies, observes both occupied admission slots through metrics, and requires a third upload to return `503 UPLOAD_BUSY` with `Retry-After`. It closes those requests and verifies the active count returns to zero. The measured upload phase may finish without overload if storage is fast; the separate probe still verifies rejection deterministically. Other errors, including unrelated 503 responses, fail the run.

Successful roles must exist in PostgreSQL. Each successful upload must have matching local bytes, a file row, a committed upload intent and one durable outbox fact. The probe and persistence checks are outside the four phase timings. No browser, backup restore or Web shutdown scenario runs in capacity mode.

The verifier retains `capacity.json`, `result.json`, `run.log` and production ownership records under `.verification/app/run-*`. Summaries are written after owned server and database cleanup, and cleanup failure fails the run. Uploaded files remain in this evidence directory for inspection. Credentials, session tokens and response bodies are not included in the capacity report. Its random metrics credential is passed only to the owned server and workload.

Per-operation reports retain HTTP-status/outcome counts and at most 20 failure observations with the operation, zero-based request index, duration and failure stage. Diagnostics expose only allowlisted error names and transport codes, including a cause code. Raw errors, URLs, tokens and response bodies are excluded. Request failures stay failures even when other uploads receive `UPLOAD_BUSY`.

Per-operation reports contain issued, successful, upload-busy and failed counts; elapsed time; attempted and successful throughput; and nearest-rank p50/p95/p99 latency in milliseconds. The overall `latencyMs` includes body decoding and rejected or failed requests. `latencyMsByOutcome` reports separate percentiles for `success`, `upload_busy` and `failed`, with null percentiles when no requests have that outcome. Compare successful upload percentiles directly; fast admission rejections can make overall percentiles look better. Metrics are sampled about every 200 ms plus around the overload probe, and report RSS, heap, database pool and active upload peaks. These sampled peaks can miss short spikes. Small request counts produce weak tail estimates. Compare repeated runs on the same machine with the same arguments; record competing machine load separately. No default SLA or production capacity conclusion is attached to these numbers.

The production verification lock serializes cooperating `verify-app.mjs --production` invocations in the same checkout through cleanup. A lock left after a hard kill requires manual ownership inspection before removal. It does not prevent an unrelated `pnpm build` or editor from modifying files. The existing doctor checks the source hash, production artifact hash, process identity, checkout and exclusive loopback listener before and after the workload; observed drift fails verification. Use separate checkouts for parallel runs.

Capacity preflight refuses active dotenv files in the repository root and `apps/web`, including production, test, development and local variants. This prevents workspace and Vite dotenv fallback from injecting external dependencies into the owned fixture. Example files are allowed. Use a clean worktree instead of removing another workflow's environment files.
