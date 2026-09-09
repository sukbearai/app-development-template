import {
  createRoleRequestSchema,
  updateRoleRequestSchema,
  nonEmptyStringSchema,
  roleSchema,
} from "@pstack/contracts";
import { createManagedRole, updateManagedRole, listRoles } from "../../auth-service";
import { trpc, adminReadProcedure, adminWriteProcedure } from "../../trpc";

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
