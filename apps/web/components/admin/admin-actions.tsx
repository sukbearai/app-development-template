"use client";

import { useRouter } from "next/navigation";
import { Check, Plus, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { fileAssetSchema, roleSchema, userSchema, type Permission, type Role, type User } from "@pstack/contracts";
import { requestForm, requestJson } from "@/components/api-client";

function formValues(form: HTMLFormElement) {
  return new FormData(form);
}

function selectedValues(data: FormData, name: string) {
  return data.getAll(name).map((value) => String(value)).filter(Boolean);
}

export function CreateUserForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const ready = useHydrated();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const form = event.currentTarget;
    const data = formValues(form);
    try {
      await requestJson("/api/admin/users", userSchema, {
        method: "POST",
        body: JSON.stringify({
          account: String(data.get("account") || ""),
          displayName: String(data.get("displayName") || ""),
          password: String(data.get("password") || ""),
          status: String(data.get("status") || "enabled"),
          roleIds: selectedValues(data, "roleIds"),
        }),
      });
      form.reset();
      setMessage("用户已创建");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="admin-form compact" method="post" onSubmit={submit}>
      <label>
        <span>账号</span>
        <input name="account" autoComplete="username" required />
      </label>
      <label>
        <span>姓名</span>
        <input name="displayName" required />
      </label>
      <label>
        <span>初始密码</span>
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      <label>
        <span>状态</span>
        <select name="status" defaultValue="enabled">
          <option value="enabled">启用</option>
          <option value="disabled">停用</option>
        </select>
      </label>
      <fieldset className="choice-grid">
        <legend>角色</legend>
        {roles.map((role) => (
          <label key={role.id} className="check-row">
            <input name="roleIds" type="checkbox" value={role.id} />
            <span>{role.name}</span>
          </label>
        ))}
      </fieldset>
      <button className="button primary" type="submit" disabled={!ready || pending}>
        <Plus size={16} />
        创建用户
      </button>
      {message && <p role="status" className="form-message">{message}</p>}
    </form>
  );
}

export function UserStatusButton({ user }: { user: User }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const nextStatus = user.status === "enabled" ? "disabled" : "enabled";

  async function updateStatus() {
    setPending(true);
    setMessage("");
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}`, userSchema, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
    <button className="button secondary table-action" type="button" onClick={updateStatus} disabled={pending}>
      <RefreshCw size={15} />
      {user.status === "enabled" ? "停用" : "启用"}
    </button>
    {message && <p role="alert" className="form-error">{message}</p>}
    </div>
  );
}

export function CreateRoleForm({ permissions }: { permissions: Permission[] }) {
  const router = useRouter();
  const ready = useHydrated();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const form = event.currentTarget;
    const data = formValues(form);
    try {
      await requestJson("/api/admin/roles", roleSchema, {
        method: "POST",
        body: JSON.stringify({
          id: String(data.get("id") || ""),
          name: String(data.get("name") || ""),
          status: String(data.get("status") || "active"),
          permissionIds: selectedValues(data, "permissionIds"),
        }),
      });
      form.reset();
      setMessage("角色已创建");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="admin-form" method="post" onSubmit={submit}>
      <div className="form-grid two">
        <label>
          <span>角色 ID</span>
          <input name="id" placeholder="role_operator" required />
        </label>
        <label>
          <span>角色名称</span>
          <input name="name" required />
        </label>
        <label>
          <span>状态</span>
          <select name="status" defaultValue="active">
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </label>
      </div>
      <fieldset className="choice-grid">
        <legend>权限</legend>
        {permissions.map((permission) => (
          <label key={permission.id} className="check-row">
            <input name="permissionIds" type="checkbox" value={permission.id} />
            <span>{permission.name}</span>
            <small>{permission.id}</small>
          </label>
        ))}
      </fieldset>
      <button className="button primary" type="submit" disabled={!ready || pending}>
        <Plus size={16} />
        创建角色
      </button>
      {message && <p role="status" className="form-message">{message}</p>}
    </form>
  );
}

export function RoleStatusButton({ role }: { role: Role }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const nextStatus = role.status === "active" ? "inactive" : "active";

  async function updateStatus() {
    setPending(true);
    setMessage("");
    try {
      await requestJson(`/api/admin/roles/${encodeURIComponent(role.id)}`, roleSchema, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
    <button className="button secondary table-action" type="button" onClick={updateStatus} disabled={pending}>
      <Check size={15} />
      {role.status === "active" ? "停用" : "启用"}
    </button>
    {message && <p role="alert" className="form-error">{message}</p>}
    </div>
  );
}

export function UploadAssetForm() {
  const router = useRouter();
  const ready = useHydrated();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const form = event.currentTarget;
    const data = formValues(form);
    try {
      const uploaded = await requestForm("/api/uploads", fileAssetSchema, { method: "POST", body: data });
      form.reset();
      setMessage(`已上传 ${uploaded.fileName}`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="admin-form inline" method="post" onSubmit={submit}>
      <label>
        <span>选择文件</span>
        <input name="file" type="file" required />
      </label>
      <button className="button primary" type="submit" disabled={!ready || pending}>
        <Upload size={16} />
        上传
      </button>
      {message && <p role="status" className="form-message">{message}</p>}
    </form>
  );
}
