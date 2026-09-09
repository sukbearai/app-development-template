import type { createBrowserRpcClient } from "../../components/trpc-client";

export async function checkRpcTypes(client: ReturnType<typeof createBrowserRpcClient>) {
  const result = await client.users.list.query({ page: 1, search: "admin" });
  const total: number = result.total;
  await client.users.update.mutate({ id: "user-id", displayName: "Updated user" });
  // @ts-expect-error Mutation inputs are inferred from the router's Zod parser.
  await client.users.create.mutate({ account: "missing-password" });
  // @ts-expect-error Unknown procedure names are rejected without SDK generation.
  await client.users.remove.mutate({ id: "user-id" });
  // @ts-expect-error Queries and mutations expose different client methods.
  await client.users.list.mutate({ page: 1 });
  return total;
}
