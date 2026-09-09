import { readCapacityResponse } from "./capacity-diagnostics.mjs";
import { createTestTrpcClient } from "./trpc-client.mjs";

export async function issueCapacityTrpc({ baseUrl, operation, token, input, signal }) {
  signal.throwIfAborted();
  let received;
  const client = createTestTrpcClient({
    baseUrl,
    headers: operation === "login" ? {} : { authorization: `Bearer ${token}` },
    fetch: (url, options) =>
      fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      }),
    onResponse: async (response) => {
      received = await readCapacityResponse(response.clone());
    },
  });
  try {
    if (operation === "login") await client.auth.login.mutate(input);
    else if (operation === "read") await client.roles.list.query();
    else if (operation === "write") await client.roles.create.mutate(input);
    else throw new Error("Unsupported capacity procedure");
  } catch (error) {
    if (!received) throw error.cause ?? error;
  }
  return received;
}
