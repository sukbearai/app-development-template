import { trpc } from "./trpc";
import { authRouter, usersRouter, rolesRouter } from "./modules/identity/router";
import { auditRouter } from "./modules/audit/router";
import { outboxRouter } from "./modules/outbox/router";
import { runtimeRouter } from "./modules/runtime/router";

export const appRouter = trpc.router({
  auth: authRouter,
  users: usersRouter,
  roles: rolesRouter,
  audit: auditRouter,
  outbox: outboxRouter,
  runtime: runtimeRouter,
});
export type AppRouter = typeof appRouter;
