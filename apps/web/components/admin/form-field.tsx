"use client";

import { useId, type InputHTMLAttributes } from "react";
import type {
  FieldError,
  FieldPath,
  FieldValues,
  UseFormRegisterReturn,
  UseFormSetError,
} from "react-hook-form";
import { z } from "zod";
import { ApiRequestError } from "@/components/api-client";
import { requestError } from "@/components/trpc-client";

const validationDetailsSchema = z.object({
  issues: z.array(
    z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
  ),
});

type FormFieldProps = {
  label: string;
  registration: UseFormRegisterReturn;
  error?: FieldError;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name">;

export function FormField({ label, registration, error, ...input }: FormFieldProps) {
  const id = useId();
  return (
    <div className="form-field">
      <label>
        <span>{label}</span>
        <input
          {...input}
          {...registration}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </label>
      {error && (
        <span id={`${id}-error`} className="form-error" role="alert">
          {error.message}
        </span>
      )}
    </div>
  );
}

export function setSubmissionError<T extends FieldValues>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- HTTP error details cross an untrusted boundary and are validated before field assignment.
  error: unknown,
  setError: UseFormSetError<T>,
  fields: FieldPath<T>[],
) {
  if (error instanceof Error) error = requestError(error);
  setError("root", { message: error instanceof Error ? error.message : "提交失败，请重试" });
  if (!(error instanceof ApiRequestError) || error.code !== "VALIDATION_FAILED") return;
  const details = validationDetailsSchema.safeParse(error.details);
  if (!details.success) return;
  let focused = false;
  const assigned = new Set<FieldPath<T>>();
  for (const issue of details.data.issues) {
    const field = fields.find(
      (candidate) => candidate === issue.path.join(".") || candidate === issue.path[0],
    );
    if (!field || assigned.has(field)) continue;
    assigned.add(field);
    setError(field, { type: "server", message: issue.message }, { shouldFocus: !focused });
    focused = true;
  }
}
