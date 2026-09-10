import { auditPageQuerySchema, auditPageSchema } from "@pstack/contracts/modules/audit/contracts";
import { listAuditPage } from "./service";
import { trpc, adminReadProcedure } from "../../trpc";

export const auditRouter = trpc.router({
  list: adminReadProcedure
    .input(auditPageQuerySchema)
    .output(auditPageSchema)
    .query(({ ctx, input }) => listAuditPage(ctx.token, input)),
});
