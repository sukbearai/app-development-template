"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changePasswordResponseSchema, resetUserPasswordResponseSchema } from "@pstack/contracts";
import { requestJson } from "@/components/api-client";
import { useHydrated } from "@/components/use-hydrated";

export function ChangePasswordForm() {
  const ready = useHydrated();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== data.get("confirmation")) {
      setMessage("两次输入的新密码不一致");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      await requestJson("/api/auth/password", changePasswordResponseSchema, {
        method: "POST",
        body: JSON.stringify({ currentPassword: String(data.get("currentPassword") || ""), newPassword }),
      });
      form.reset();
      router.replace("/login?passwordChanged=1");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改密码失败");
    } finally { setPending(false); }
  }
  return (
    <form className="admin-form" method="post" onSubmit={submit}>
      <label><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
      <label><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></label>
      <label><span>确认新密码</span><input name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></label>
      <p className="muted">修改后，所有设备需要重新登录。</p>
      <button className="button primary" type="submit" disabled={!ready || pending}>修改密码</button>
      {message && <p role="alert" className="form-error">{message}</p>}
    </form>
  );
}

export function ResetUserPasswordForm({ userId, account }: { userId: string; account: string }) {
  const ready = useHydrated();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage("");
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(userId)}/password`, resetUserPasswordResponseSchema, {
        method: "POST", body: JSON.stringify({ newPassword: String(data.get("newPassword") || "") }),
      });
      form.reset();
      setMessage("密码已重置，原有会话已撤销");
    } catch (error) { setMessage(error instanceof Error ? error.message : "重置密码失败"); }
    finally { setPending(false); }
  }
  return (
    <div>
      <button className="button secondary table-action" type="button" disabled={!ready} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>重置密码</button>
      {expanded && <form className="admin-form" method="post" onSubmit={submit}>
        <label><span>{account} 的新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></label>
        <p className="muted">此操作会撤销该用户的全部会话。</p>
        <button className="button secondary" type="submit" disabled={!ready || pending}>确认重置密码</button>
        {message && <p role="status" className="form-message">{message}</p>}
      </form>}
    </div>
  );
}
