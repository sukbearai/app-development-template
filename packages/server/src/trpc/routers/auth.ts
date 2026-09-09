import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
} from "@pstack/contracts";
import { currentUserResponseSchema, logoutResponseSchema } from "@pstack/contracts/http";
import { changePassword, getCurrentUser, login, logout } from "../../auth-service";
import { assertLoginRateLimit } from "../../rate-limit";
import { clearSessionCookie, setSessionCookie } from "../../request-auth";
import { authenticatedProcedure, publicProcedure, trpc, type TrpcContext } from "../../trpc";

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
