# Local infrastructure

Run `pnpm local:init`, then `pnpm local:up`. PostgreSQL is the core service.
Add profiles with `pnpm local:up -- app redis kafka storage analytics worker`.
The worker profile enables app and Kafka automatically. `pnpm local:down` preserves named volumes.

See [operations](../../docs/operations.md) for configuration, ports, images and restore procedures.
