import { cookies } from "next/headers";
import {
  listPermissions,
  listRoles,
  requirePermission,
} from "@pstack/server/modules/identity/service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { EmptyState, PageHeader, Section, StatusBadge } from "@/components/ui/page-layout";

export const dynamic = "force-dynamic";

export default async function AdminPermissionsPage() {
  const cookieStore = await cookies();
  await requirePermission(cookieStore.get(sessionCookieName)?.value, "admin.read");
  const [permissions, roles] = await Promise.all([listPermissions(), listRoles()]);

  return (
    <>
      <PageHeader
        title="权限目录"
        eyebrow="Permission Catalog"
        description="权限是 API 和页面授权的共享边界，应通过迁移和 shared contract 同步维护。"
      />
      <Section
        title="权限清单"
        description={`${permissions.length} 个权限，${roles.length} 个角色引用。`}
      >
        {permissions.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>权限</th>
                  <th>ID</th>
                  <th>使用角色</th>
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission) => {
                  const usedBy = roles.filter((role) => role.permissionIds.includes(permission.id));
                  return (
                    <tr key={permission.id}>
                      <td>{permission.name}</td>
                      <td>
                        <code>{permission.id}</code>
                      </td>
                      <td>
                        {usedBy.length ? (
                          <div className="tag-list">
                            {usedBy.map((role) => (
                              <span className="soft-tag" key={role.id}>
                                {role.name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <StatusBadge tone="warning">未授权</StatusBadge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无权限" description="执行迁移后会显示权限目录。" />
        )}
      </Section>
    </>
  );
}
