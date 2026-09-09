import { createApiClient } from "../src/index.ts";

const client = createApiClient({ baseUrl: "http://localhost:3000" });

export async function checkOperationTypes() {
  const hello = await client.GET("/api/hello");
  const message: "Hello from vinext" | undefined = hello.data?.message;
  await client.PATCH("/api/admin/users/{id}", {
    params: { path: { id: "user-id" } },
    body: { displayName: "User" },
  });
  // @ts-expect-error The operation registry does not expose this route.
  await client.GET("/api/missing");
  // @ts-expect-error Login requires a password.
  await client.POST("/api/auth/login", { body: { account: "admin" } });
  // @ts-expect-error The dynamic user route requires path parameters.
  await client.PATCH("/api/admin/users/{id}", { body: { displayName: "User" } });
  return message;
}
