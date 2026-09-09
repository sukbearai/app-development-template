import {
  createUserRequestSchema,
  updateUserRequestSchema,
  resetUserPasswordRequestSchema,
  resetUserPasswordResponseSchema,
  userSchema,
  nonEmptyStringSchema,
} from "@pstack/contracts";
import { userPageQuerySchema } from "@pstack/contracts/admin-pages";
import { userDirectorySchema } from "@pstack/contracts/http";
import { listUserPage } from "../../admin-directory-service";
import {
  createManagedUser,
  updateManagedUser,
  resetManagedUserPassword,
  listRoles,
  listPermissions,
} from "../../auth-service";
import { trpc, adminReadProcedure, adminWriteProcedure } from "../../trpc";

export const usersRouter = trpc.router({
  list: adminReadProcedure
    .input(userPageQuerySchema)
    .output(userDirectorySchema)
    .query(async ({ ctx, input }) => {
      const result = await listUserPage(ctx.token, input);
      return {
        users: result.items,
        page: result.page,
        limit: result.limit,
        total: result.total,
        roles: await listRoles(),
        permissions: await listPermissions(),
      };
    }),
  create: adminWriteProcedure
    .input(createUserRequestSchema)
    .output(userSchema)
    .mutation(({ ctx, input }) => createManagedUser(input, ctx.token, ctx.traceId)),
  update: adminWriteProcedure
    .input(updateUserRequestSchema.extend({ id: nonEmptyStringSchema }))
    .output(userSchema)
    .mutation(({ ctx, input }) => updateManagedUser(input.id, input, ctx.token, ctx.traceId)),
  resetPassword: adminWriteProcedure
    .input(resetUserPasswordRequestSchema.extend({ id: nonEmptyStringSchema }))
    .output(resetUserPasswordResponseSchema)
    .mutation(({ ctx, input }) =>
      resetManagedUserPassword(input.id, input, ctx.token, ctx.traceId),
    ),
});
