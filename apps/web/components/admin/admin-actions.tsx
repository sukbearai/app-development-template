"use client";

import { useRouter } from "next/navigation";
import { Check, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { FormField, setSubmissionError } from "@/components/admin/form-field";
import { useHydrated } from "@/components/use-hydrated";
import {
  createUserRequestSchema,
  createRoleRequestSchema,
  roleSchema,
  userSchema,
  type CreateUserRequest,
  type CreateRoleRequest,
  type Permission,
  type Role,
  type User,
} from "@pstack/contracts";
import { useApiMutation } from "@/components/api-query";
import { requestJson } from "@/components/api-client";

export function CreateUserForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const ready = useHydrated();
  const [message, setMessage] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof createUserRequestSchema>, undefined, CreateUserRequest>({
    resolver: zodResolver(createUserRequestSchema),
    defaultValues: { roleIds: [] },
  });

  const create = useApiMutation({
    mutationFn: (data: CreateUserRequest) =>
      requestJson("/api/admin/users", userSchema, { method: "POST", body: JSON.stringify(data) }),
  });

  async function submit(data: CreateUserRequest) {
    setMessage("");
    try {
      await create.mutateAsync(data);
      reset();
      setMessage("用户已创建");
      router.refresh();
    } catch (error) {
      setSubmissionError(error, setError, [
        "account",
        "displayName",
        "password",
        "status",
        "roleIds",
      ]);
    }
  }

  return (
    <form
      className="admin-form compact"
      method="post"
      onSubmit={handleSubmit(submit)}
      noValidate
      aria-busy={isSubmitting}
    >
      <FormField
        label="账号"
        registration={register("account")}
        error={errors.account}
        autoComplete="username"
        required
      />
      <FormField
        label="姓名"
        registration={register("displayName")}
        error={errors.displayName}
        required
      />
      <FormField
        label="初始密码"
        registration={register("password")}
        error={errors.password}
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={256}
        required
      />
      <label>
        <span>状态</span>
        <select {...register("status")} aria-invalid={Boolean(errors.status)}>
          <option value="enabled">启用</option>
          <option value="disabled">停用</option>
        </select>
      </label>
      <fieldset className="choice-grid">
        <legend>角色</legend>
        {roles.map((role) => (
          <label key={role.id} className="check-row">
            <input {...register("roleIds")} type="checkbox" value={role.id} />
            <span>{role.name}</span>
          </label>
        ))}
      </fieldset>
      {errors.roleIds && (
        <p role="alert" className="form-error">
          {errors.roleIds.message}
        </p>
      )}
      <button className="button primary" type="submit" disabled={!ready || isSubmitting}>
        <Plus size={16} />
        创建用户
      </button>
      {errors.root && (
        <p role="alert" className="form-error">
          {errors.root.message}
        </p>
      )}
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
    </form>
  );
}

function StatusButton({
  mutate,
  enabled,
  icon,
}: {
  mutate: () => Promise<User | Role>;
  enabled: boolean;
  icon: React.ReactNode;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const update = useApiMutation({ mutationFn: mutate });

  async function updateStatus() {
    setMessage("");
    try {
      await update.mutateAsync();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新失败");
    }
  }
  return (
    <div>
      <button
        className="button secondary table-action"
        type="button"
        onClick={updateStatus}
        disabled={update.isPending}
      >
        {icon}
        {enabled ? "停用" : "启用"}
      </button>
      {message && (
        <p role="alert" className="form-error">
          {message}
        </p>
      )}
    </div>
  );
}

export function UserStatusButton({ user }: { user: User }) {
  return (
    <StatusButton
      enabled={user.status === "enabled"}
      icon={<RefreshCw size={15} />}
      mutate={() =>
        requestJson(`/api/admin/users/${encodeURIComponent(user.id)}`, userSchema, {
          method: "PATCH",
          body: JSON.stringify({ status: user.status === "enabled" ? "disabled" : "enabled" }),
        })
      }
    />
  );
}

export function CreateRoleForm({ permissions }: { permissions: Permission[] }) {
  const router = useRouter();
  const ready = useHydrated();
  const [message, setMessage] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof createRoleRequestSchema>, undefined, CreateRoleRequest>({
    resolver: zodResolver(createRoleRequestSchema),
    defaultValues: { permissionIds: [] },
  });

  const create = useApiMutation({
    mutationFn: (data: CreateRoleRequest) =>
      requestJson("/api/admin/roles", roleSchema, { method: "POST", body: JSON.stringify(data) }),
  });

  async function submit(data: CreateRoleRequest) {
    setMessage("");
    try {
      await create.mutateAsync(data);
      reset();
      setMessage("角色已创建");
      router.refresh();
    } catch (error) {
      setSubmissionError(error, setError, ["id", "name", "status", "permissionIds"]);
    }
  }

  return (
    <form
      className="admin-form"
      method="post"
      onSubmit={handleSubmit(submit)}
      noValidate
      aria-busy={isSubmitting}
    >
      <div className="form-grid two">
        <FormField
          label="角色 ID"
          registration={register("id")}
          error={errors.id}
          placeholder="role_operator"
          required
        />
        <FormField label="角色名称" registration={register("name")} error={errors.name} required />
        <label>
          <span>状态</span>
          <select {...register("status")} aria-invalid={Boolean(errors.status)}>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </label>
      </div>
      <fieldset className="choice-grid">
        <legend>权限</legend>
        {permissions.map((permission) => (
          <label key={permission.id} className="check-row">
            <input {...register("permissionIds")} type="checkbox" value={permission.id} />
            <span>{permission.name}</span>
            <small>{permission.id}</small>
          </label>
        ))}
      </fieldset>
      {errors.permissionIds && (
        <p role="alert" className="form-error">
          {errors.permissionIds.message}
        </p>
      )}
      <button className="button primary" type="submit" disabled={!ready || isSubmitting}>
        <Plus size={16} />
        创建角色
      </button>
      {errors.root && (
        <p role="alert" className="form-error">
          {errors.root.message}
        </p>
      )}
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
    </form>
  );
}

export function RoleStatusButton({ role }: { role: Role }) {
  return (
    <StatusButton
      enabled={role.status === "active"}
      icon={<Check size={15} />}
      mutate={() =>
        requestJson(`/api/admin/roles/${encodeURIComponent(role.id)}`, roleSchema, {
          method: "PATCH",
          body: JSON.stringify({ status: role.status === "active" ? "inactive" : "active" }),
        })
      }
    />
  );
}
