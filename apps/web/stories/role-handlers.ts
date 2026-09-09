import { createRoleRequestSchema, roleSchema, type Role } from "@pstack/contracts";
import { delay, http, HttpResponse } from "msw";

export const sampleRole = roleSchema.parse({
  id: "role_operator",
  name: "运维人员",
  permissionIds: ["admin.read"],
  status: "active",
});

export function roleListHandler(roles: Role[], latency: number | "infinite" = 0) {
  return http.get("/api/admin/roles", async () => {
    await delay(latency);
    return HttpResponse.json({ traceId: "storybook-roles", data: roles });
  });
}

export function createRoleHandler(latency: number | "infinite" = 0) {
  return http.post("/api/admin/roles", async ({ request }) => {
    const input = createRoleRequestSchema.parse(await request.json());
    await delay(latency);
    return HttpResponse.json(
      { traceId: "storybook-create-role", data: roleSchema.parse(input) },
      { status: 201 },
    );
  });
}

export function unavailableResponse() {
  return HttpResponse.json(
    {
      traceId: "storybook-unavailable",
      error: { code: "SERVICE_UNAVAILABLE", message: "角色服务暂时不可用，请稍后重试。" },
    },
    { status: 503 },
  );
}
