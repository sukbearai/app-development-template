import { cookies } from "next/headers";
import { listRoles, listPermissions, requirePermission } from "@pstack/server/auth-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { CreateRoleForm, RoleStatusButton } from "@/components/admin/admin-actions";
import { EmptyState, PageHeader, PermissionNotice, Section, StatusBadge } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const actor = await requirePermission(token, "admin.read");
  const [roles, permissions] = await Promise.all([listRoles(), listPermissions()]);
  const canWrite = roles.some((role) => role.status === "active" && actor.roleIds.includes(role.id) && role.permissionIds.includes("admin.write"));
  const permissionName = new Map(permissions.map((permission) => [permission.id, permission.name]));

  return (
    <>
      <PageHeader title="角色管理" eyebrow="RBAC" description="角色定义权限集合，用户通过角色获得后台访问和写操作能力。" />
      {canWrite ? (
        <Section title="新建角色" description="为角色选择可用权限。">
          <CreateRoleForm permissions={permissions} />
        </Section>
      ) : (
        <PermissionNotice />
      )}
      <Section title="角色列表" description={`${roles.length} 个角色。`}>
        {roles.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>ID</th>
                  <th>状态</th>
                  <th>权限</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>{role.name}</td>
                    <td><code>{role.id}</code></td>
                    <td>
                      <StatusBadge tone={role.status === "active" ? "success" : "danger"}>
                        {role.status === "active" ? "启用" : "停用"}
                      </StatusBadge>
                    </td>
                    <td>
                      <div className="tag-list">
                        {role.permissionIds.map((id) => (
                          <span className="soft-tag" key={id}>{permissionName.get(id) || id}</span>
                        ))}
                      </div>
                    </td>
                    <td>{canWrite ? <RoleStatusButton role={role} /> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无角色" description="执行迁移或创建角色后会显示角色。" />
        )}
      </Section>
    </>
  );
}
