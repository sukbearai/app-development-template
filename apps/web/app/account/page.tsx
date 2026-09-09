import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ApiError } from "@pstack/server/api-response";
import { getCurrentUser } from "@pstack/server/auth-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { ChangePasswordForm } from "@/components/admin/password-actions";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const token = (await cookies()).get(sessionCookieName)?.value;
  let current;
  try {
    current = await getCurrentUser(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login?next=/account");
    throw error;
  }
  return (
    <main className="shell">
      <section className="panel">
        <div className="toolbar">
          <div>
            <h1>个人账号</h1>
            <p className="muted">
              {current.user.displayName} · {current.user.account}
            </p>
          </div>
          <Link className="button secondary" href="/">
            返回首页
          </Link>
        </div>
        <ChangePasswordForm />
      </section>
    </main>
  );
}
