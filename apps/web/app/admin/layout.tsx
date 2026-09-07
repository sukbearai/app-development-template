import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ApiError } from "@pstack/server/api-response";
import { getCurrentUser } from "@pstack/server/auth-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { AdminShell } from "@/components/admin/admin-shell";
import { PermissionNotice } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  let session;
  try {
    session = await getCurrentUser(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login?next=/admin");
    }
    throw error;
  }

  const permissions = session.permissions.map((permission) => permission.id);
  if (!permissions.includes("admin.read")) {
    return (
      <main className="shell">
        <PermissionNotice />
      </main>
    );
  }

  return (
    <AdminShell
      accountName={session.user.account}
      displayName={session.user.displayName}
      permissions={permissions}
    >
      {children}
    </AdminShell>
  );
}
