import { createRoleRequestSchema, roleSchema, type Role } from "@pstack/contracts";
import { delay, http, HttpResponse } from "msw";

export const sampleRole = roleSchema.parse({
  id: "role_operator",
  name: "运维人员",
  permissionIds: ["admin.read"],
  status: "active",
});

export function roleListHandler(roles: Role[], latency: number | "infinite" = 0) {
  return http.get("/api/trpc/roles.list", async () => {
    await delay(latency);
    return HttpResponse.json({ result: { data: roles } });
  });
}

export function createRoleHandler(latency: number | "infinite" = 0) {
  return http.post("/api/trpc/roles.create", async ({ request }) => {
    const input = createRoleRequestSchema.parse(await request.json());
    await delay(latency);
    return HttpResponse.json({ result: { data: roleSchema.parse(input) } }, { status: 200 });
  });
}

export function unavailableResponse() {
  return HttpResponse.json(
    {
      error: {
        code: -32603,
        message: "角色服务暂时不可用，请稍后重试。",
        data: {
          code: "SERVICE_UNAVAILABLE",
          httpStatus: 503,
          businessCode: "SERVICE_UNAVAILABLE",
          traceId: "storybook-unavailable",
          details: {},
        },
      },
    },
    { status: 503 },
  );
}
