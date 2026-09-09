import Link from "next/link";
import { cookies } from "next/headers";
import { userPageQuerySchema } from "@pstack/contracts/admin-pages";
import { listPermissions, listRoles, requirePermission } from "@pstack/server/auth-service";
import { listUserPage } from "@pstack/server/admin-directory-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { CreateUserForm } from "@/components/admin/admin-actions";
import { PageHeader, PermissionNotice, Section } from "@/components/admin/admin-ui";
import { DirectoryFilters } from "@/components/admin/directory-filters";
import { UserDirectoryTable } from "@/components/admin/directory-tables";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const actor = await requirePermission(token, "admin.read");
  const parsed = userPageQuerySchema.safeParse(await searchParams);
  if (!parsed.success)
    return (
      <>
        <PageHeader title="用户管理" description="筛选或分页参数无效。" />
        <Link href="/admin/users">重置筛选</Link>
      </>
    );
  const [result, roles, permissions] = await Promise.all([
    listUserPage(token, parsed.data),
    listRoles(),
    listPermissions(),
  ]);
  const canWrite = roles.some(
    (role) =>
      role.status === "active" &&
      actor.roleIds.includes(role.id) &&
      role.permissionIds.includes("admin.write"),
  );
  return (
    <>
      <PageHeader
        title="用户管理"
        eyebrow="Identity"
        description="管理账号状态和角色归属。按账号或姓名搜索。"
      />
      {canWrite ? (
        <Section title="新建用户" description="为新账号选择角色并设置初始密码。">
          <CreateUserForm roles={roles} />
        </Section>
      ) : (
        <PermissionNotice />
      )}
      <Section
        title="用户列表"
        description={`${result.total} 个账号，${permissions.length} 个权限可授权。`}
      >
        <DirectoryFilters
          path="/admin/users"
          {...parsed.data}
          fields={[
            {
              name: "status",
              label: "状态",
              value: parsed.data.status,
              options: [
                { value: "all", label: "全部" },
                { value: "enabled", label: "启用" },
                { value: "disabled", label: "停用" },
              ],
            },
            {
              name: "sort",
              label: "排序",
              value: parsed.data.sort,
              options: [
                { value: "createdAt", label: "创建时间" },
                { value: "account", label: "账号" },
                { value: "displayName", label: "姓名" },
              ],
            },
          ]}
        />
        <UserDirectoryTable result={result} roles={roles} actorId={actor.id} canWrite={canWrite} />
      </Section>
    </>
  );
}
