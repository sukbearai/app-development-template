import { asyncRuntimeHealthSchema } from "@pstack/contracts/modules/runtime/contracts";
import { readAdminAsyncRuntimeHealth } from "./service";
import { trpc, adminReadProcedure } from "../../trpc";

export const runtimeRouter = trpc.router({
  health: adminReadProcedure
    .output(asyncRuntimeHealthSchema)
    .query(() => readAdminAsyncRuntimeHealth()),
});
