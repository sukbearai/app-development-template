"use client";

import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import {
  loginRequestSchema,
  type LoginRequest,
} from "@pstack/contracts/modules/identity/contracts";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc-client";
import { FormField } from "@/components/ui/form-field";
import { setSubmissionError } from "@/lib/form-errors";

function nextPath() {
  const url = new URL(window.location.href);
  const next = url.searchParams.get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return "/admin";
  const target = new URL(next, url.origin);
  return target.origin === url.origin
    ? `${target.pathname}${target.search}${target.hash}`
    : "/admin";
}

export function LoginForm() {
  const router = useRouter();
  const ready = useHydrated();
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
  });
  const { register, handleSubmit, setError, formState } = form;
  const message = formState.errors.root?.message;
  const trpc = useTRPC();
  const login = useMutation(
    trpc.auth.login.mutationOptions({ meta: { authentication: "public" } }),
  );

  async function submit(data: LoginRequest) {
    try {
      await login.mutateAsync(data);
      router.replace(nextPath());
      router.refresh();
    } catch (error) {
      setSubmissionError(error, setError, ["account", "password"]);
    }
  }

  return (
    <form
      className="login-form"
      method="post"
      onSubmit={handleSubmit(submit)}
      noValidate
      aria-describedby={message ? "login-error" : undefined}
    >
      <FormField
        label="账号"
        registration={register("account")}
        autoComplete="username"
        error={formState.errors.account}
        required
      />
      <FormField
        label="密码"
        registration={register("password")}
        type="password"
        autoComplete="current-password"
        error={formState.errors.password}
        required
      />
      <button
        className="button primary wide"
        type="submit"
        disabled={!ready || formState.isSubmitting}
        aria-busy={formState.isSubmitting}
      >
        <LogIn size={16} />
        登录管理端
      </button>
      <noscript>
        <p className="form-error">请启用 JavaScript 后登录。</p>
      </noscript>
      {message && (
        <p id="login-error" role="alert" className="form-error">
          {message}
        </p>
      )}
    </form>
  );
}
