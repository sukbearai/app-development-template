import { cookies } from "next/headers";
import { listPermissions, listRoles, listUsers, requirePermission } from "@pstack/server/auth-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { CreateUserForm, UserStatusButton } from "@/components/admin/admin-actions";
import { EmptyState, PageHeader, PermissionNotice, Section, StatusBadge, formatDateTime } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const actor = await requirePermission(token, "admin.read");
  const [users, roles, permissions] = await Promise.all([listUsers(), listRoles(), listPermissions()]);
  const canWrite = actor ? roles.some((role) => role.status === "active" && actor.roleIds.includes(role.id) && role.permissionIds.includes("admin.write")) : false;
  const roleName = new Map(roles.map((role) => [role.id, role.name]));

  return (
    <>
      <PageHeader title="用户管理" eyebrow="Identity" description="管理账号状态和角色归属。" />
      {canWrite ? (
        <Section title="新建用户" description="为新账号选择角色并设置初始密码。">
          <CreateUserForm roles={roles} />
        </Section>
      ) : (
        <PermissionNotice />
      )}
      <Section title="用户列表" description={`${users.length} 个账号，${permissions.length} 个权限可授权。`}>
        {users.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>姓名</th>
                  <th>状态</th>
                  <th>角色</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td><code>{user.account}</code></td>
                    <td>{user.displayName}</td>
                    <td>
                      <StatusBadge tone={user.status === "enabled" ? "success" : "danger"}>
                        {user.status === "enabled" ? "启用" : "停用"}
                      </StatusBadge>
                    </td>
                    <td>{user.roleIds.map((id) => roleName.get(id) || id).join("，") || "-"}</td>
                    <td>{formatDateTime(user.createdAt)}</td>
                    <td>{canWrite ? <UserStatusButton user={user} /> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无用户" description="执行迁移或创建账号后会显示用户。" />
        )}
      </Section>
    </>
  );
}
