"use client";

import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { loginResponseSchema } from "@pstack/contracts";
import { requestJson } from "@/components/api-client";

function nextPath() {
  const url = new URL(window.location.href);
  const next = url.searchParams.get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/admin";
  const target = new URL(next, url.origin);
  return target.origin === url.origin ? `${target.pathname}${target.search}${target.hash}` : "/admin";
}

export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      await requestJson("/api/auth/login", loginResponseSchema, {
        method: "POST",
        body: JSON.stringify({
          account: String(data.get("account") || ""),
          password: String(data.get("password") || ""),
        }),
      });
      router.replace(nextPath());
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label>
        <span>账号</span>
        <input name="account" autoComplete="username" required />
      </label>
      <label>
        <span>密码</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="button primary wide" type="submit" disabled={pending}>
        <LogIn size={16} />
        登录管理端
      </button>
      {message && <p role="alert" className="form-error">{message}</p>}
    </form>
  );
}
