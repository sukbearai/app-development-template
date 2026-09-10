import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  createUserRequestSchema,
  updateUserRequestSchema,
  resetUserPasswordRequestSchema,
  resetUserPasswordResponseSchema,
  userSchema,
  createRoleRequestSchema,
  updateRoleRequestSchema,
  roleSchema,
  userPageQuerySchema,
  currentUserResponseSchema,
  logoutResponseSchema,
  userDirectorySchema,
} from "@pstack/contracts/modules/identity/contracts";
import { nonEmptyStringSchema } from "@pstack/contracts/primitives";

import {
  changePassword,
  getCurrentUser,
  login,
  logout,
  listUserPage,
  createManagedUser,
  updateManagedUser,
  resetManagedUserPassword,
  listRoles,
  listPermissions,
  createManagedRole,
  updateManagedRole,
} from "./service";
import { assertLoginRateLimit } from "../../rate-limit";
import { clearSessionCookie, setSessionCookie } from "../../request-auth";
import {
  authenticatedProcedure,
  publicProcedure,
  trpc,
  type TrpcContext,
  adminReadProcedure,
  adminWriteProcedure,
} from "../../trpc";

function sessionResponse(context: TrpcContext, response: Response) {
  response.headers.forEach((value, name) => context.responseHeaders.append(name, value));
}

export const authRouter = trpc.router({
  login: publicProcedure
    .input(loginRequestSchema)
    .output(loginResponseSchema)
    .mutation(async ({ ctx, input }) => {
      await assertLoginRateLimit(`login:account:${input.account}`);
      const session = await login(input);
      sessionResponse(ctx, setSessionCookie(new Response(), session.token));
      return session;
    }),
  me: authenticatedProcedure
    .output(currentUserResponseSchema)
    .query(({ ctx }) => getCurrentUser(ctx.token)),
  logout: publicProcedure.output(logoutResponseSchema).mutation(async ({ ctx }) => {
    const result = logoutResponseSchema.parse(await logout(ctx.token));
    sessionResponse(ctx, clearSessionCookie(new Response()));
    return result;
  }),
  changePassword: authenticatedProcedure
    .input(changePasswordRequestSchema)
    .output(changePasswordResponseSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await changePassword(input, ctx.token, ctx.traceId);
      sessionResponse(ctx, clearSessionCookie(new Response()));
      return result;
    }),
});

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

export const rolesRouter = trpc.router({
  list: adminReadProcedure.output(roleSchema.array()).query(() => listRoles()),
  create: adminWriteProcedure
    .input(createRoleRequestSchema)
    .output(roleSchema)
    .mutation(({ ctx, input }) => createManagedRole(input, ctx.token, ctx.traceId)),
  update: adminWriteProcedure
    .input(updateRoleRequestSchema.extend({ id: nonEmptyStringSchema }))
    .output(roleSchema)
    .mutation(({ ctx, input }) => updateManagedRole(input.id, input, ctx.token, ctx.traceId)),
});
