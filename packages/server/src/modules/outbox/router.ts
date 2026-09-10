import { outboxEventSchema } from "@pstack/contracts/modules/outbox/contracts";
import { listOutboxEvents } from "./service";
import { trpc, adminReadProcedure } from "../../trpc";

export const outboxRouter = trpc.router({
  list: adminReadProcedure.output(outboxEventSchema.array()).query(() => listOutboxEvents()),
});
