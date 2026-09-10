"use client";

import type { FieldPath, FieldValues, UseFormSetError } from "react-hook-form";
import { z } from "zod";
import { ApiRequestError } from "@/lib/api-client";
import { requestError } from "@/lib/trpc-client";

const validationDetailsSchema = z.object({
  issues: z.array(
    z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
  ),
});

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
