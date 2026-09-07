import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Activity } from "lucide-react";
import { ApiError } from "@pstack/server/api-response";
import { env } from "@pstack/server/env";
import { getCurrentUser } from "@pstack/server/auth-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { LoginForm } from "@/components/admin/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  let hasValidSession = false;
  if (token) {
    try {
      await getCurrentUser(token);
      hasValidSession = true;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }
  if (hasValidSession) redirect("/admin");

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <span aria-hidden><Activity size={22} /></span>
          <div>
            <h1>{env.APP_NAME}</h1>
            <p>管理端登录</p>
          </div>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
