import { createApiClient } from "../src/index.ts";

const client = createApiClient({ baseUrl: "http://localhost:3000" });

export async function checkOperationTypes() {
  const hello = await client.GET("/api/hello");
  const message: "Hello from vinext" | undefined = hello.data?.message;
  const telemetry = await client.POST("/api/telemetry", {
    body: { event: "page.view", payload: {} },
  });
  const occurredAt: string | undefined = telemetry.data?.data.occurredAt;
  // @ts-expect-error The operation registry does not expose this route.
  await client.GET("/api/missing");
  // @ts-expect-error Internal authentication is only available through tRPC.
  await client.POST("/api/auth/login", { body: { account: "admin", password: "password" } });
  // @ts-expect-error Internal user updates are only available through tRPC.
  await client.PATCH("/api/admin/users/{id}", {
    params: { path: { id: "user-id" } },
    body: { displayName: "User" },
  });
  // @ts-expect-error Telemetry requires an event name.
  await client.POST("/api/telemetry", { body: { payload: {} } });
  // @ts-expect-error File uploads require a File rather than a path string.
  await client.POST("/api/uploads", { body: { file: "proof.txt" } });
  return { message, occurredAt };
}
