import { asyncRuntimeHealthSchema, outboxEventSchema } from "@pstack/contracts";
import { auditPageQuerySchema, auditPageSchema } from "@pstack/contracts/admin-pages";
import { listAuditPage } from "./admin-directory-service";
import { readAdminAsyncRuntimeHealth } from "./async-runtime-health-service";
import { listOutboxEvents } from "./product-service";
import { trpc, adminReadProcedure } from "./trpc";
import { authRouter } from "./trpc/routers/auth";
import { rolesRouter } from "./trpc/routers/roles";
import { usersRouter } from "./trpc/routers/users";

export const appRouter = trpc.router({
  auth: authRouter,
  users: usersRouter,
  roles: rolesRouter,
  audit: trpc.router({
    list: adminReadProcedure
      .input(auditPageQuerySchema)
      .output(auditPageSchema)
      .query(({ ctx, input }) => listAuditPage(ctx.token, input)),
  }),
  outbox: trpc.router({
    list: adminReadProcedure.output(outboxEventSchema.array()).query(() => listOutboxEvents()),
  }),
  runtime: trpc.router({
    health: adminReadProcedure
      .output(asyncRuntimeHealthSchema)
      .query(() => readAdminAsyncRuntimeHealth()),
  }),
});
export type AppRouter = typeof appRouter;
