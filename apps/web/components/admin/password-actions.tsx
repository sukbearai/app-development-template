"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  changePasswordRequestSchema,
  resetUserPasswordRequestSchema,
  type ResetUserPasswordRequest,
} from "@pstack/contracts";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/components/trpc-client";
import { FormField, setSubmissionError } from "@/components/admin/form-field";
import { useHydrated } from "@/components/use-hydrated";

const confirmedPasswordSchema = changePasswordRequestSchema
  .extend({ confirmation: changePasswordRequestSchema.shape.newPassword })
  .refine((value) => value.newPassword === value.confirmation, {
    path: ["confirmation"],
    message: "两次输入的新密码不一致",
  });

export function ChangePasswordForm() {
  const ready = useHydrated();
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof confirmedPasswordSchema>>({
    resolver: zodResolver(confirmedPasswordSchema),
  });
  const trpc = useTRPC();
  const changePassword = useMutation(trpc.auth.changePassword.mutationOptions());
  async function submit(data: z.infer<typeof confirmedPasswordSchema>) {
    try {
      await changePassword.mutateAsync(changePasswordRequestSchema.parse(data));
      reset();
      router.replace("/login?passwordChanged=1");
      router.refresh();
    } catch (error) {
      setSubmissionError(error, setError, ["currentPassword", "newPassword", "confirmation"]);
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
      <FormField
        label="当前密码"
        registration={register("currentPassword")}
        error={errors.currentPassword}
        type="password"
        autoComplete="current-password"
        required
      />
      <FormField
        label="新密码"
        registration={register("newPassword")}
        error={errors.newPassword}
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={256}
        required
      />
      <FormField
        label="确认新密码"
        registration={register("confirmation")}
        error={errors.confirmation}
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={256}
        required
      />
      <p className="muted">修改后，所有设备需要重新登录。</p>
      <button className="button primary" type="submit" disabled={!ready || isSubmitting}>
        修改密码
      </button>
      {errors.root && (
        <p role="alert" className="form-error">
          {errors.root.message}
        </p>
      )}
    </form>
  );
}

export function ResetUserPasswordForm({ userId, account }: { userId: string; account: string }) {
  const ready = useHydrated();
  const formId = `reset-password-${userId}`;
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ResetUserPasswordRequest>({
    resolver: zodResolver(resetUserPasswordRequestSchema),
  });
  const trpc = useTRPC();
  const resetPassword = useMutation(trpc.users.resetPassword.mutationOptions());
  async function submit(data: ResetUserPasswordRequest) {
    setMessage("");
    try {
      await resetPassword.mutateAsync({ id: userId, ...data });
      reset();
      setMessage("密码已重置，原有会话已撤销");
    } catch (error) {
      setSubmissionError(error, setError, ["newPassword"]);
    }
  }
  return (
    <div>
      <button
        className="button secondary table-action"
        type="button"
        disabled={!ready || isSubmitting}
        aria-expanded={expanded}
        aria-controls={formId}
        onClick={() => setExpanded(!expanded)}
      >
        重置密码
      </button>
      {expanded && (
        <form
          id={formId}
          className="admin-form"
          method="post"
          onSubmit={handleSubmit(submit)}
          noValidate
          aria-busy={isSubmitting}
        >
          <FormField
            label={`${account} 的新密码`}
            registration={register("newPassword")}
            error={errors.newPassword}
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            required
          />
          <p className="muted">此操作会撤销该用户的全部会话。</p>
          <button className="button secondary" type="submit" disabled={!ready || isSubmitting}>
            确认重置密码
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
      )}
    </div>
  );
}
