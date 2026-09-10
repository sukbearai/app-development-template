"use client";

import { useId, type InputHTMLAttributes } from "react";
import type { FieldError, UseFormRegisterReturn } from "react-hook-form";

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
