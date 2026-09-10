import { z } from "zod";

import {
  nonEmptyStringSchema,
  optionalNonEmptyStringSchema,
  isoDateTimeSchema,
} from "../../primitives.ts";

export const fileAssetSchema = z.object({
  id: nonEmptyStringSchema,
  fileName: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  storageKey: nonEmptyStringSchema,
  uploadedBy: optionalNonEmptyStringSchema,
  uploadedAt: isoDateTimeSchema,
});

export const filePageCursorSchema = z
  .object({
    uploadedAt: z.iso
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith("0000-"), "Invalid cursor year"),
    id: z
      .string()
      .min(1)
      .max(256)
      // oxlint-disable-next-line no-control-regex -- PostgreSQL text rejects NUL; lone surrogates also cannot round-trip.
      .regex(/^[^\u0000\uD800-\uDFFF]+$/u, "Invalid cursor identifier"),
  })
  .strict();

export const filePageQuerySchema = z.object({
  limit: z
    .union([z.string().regex(/^\d+$/), z.number()])
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(100),
  cursor: z
    .string()
    .max(1024)
    .transform((value, context) => {
      try {
        return JSON.parse(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid file page cursor" });
        return z.NEVER;
      }
    })
    .pipe(filePageCursorSchema)
    .optional(),
});

export const fileAssetPageSchema = z.object({
  items: z.array(fileAssetSchema),
  nextCursor: filePageCursorSchema.nullable(),
});

export type FilePageQuery = z.infer<typeof filePageQuerySchema>;

export type FileAssetPage = z.infer<typeof fileAssetPageSchema>;

export type FileAsset = z.infer<typeof fileAssetSchema>;

export const uploadRequestSchema = z.object({ file: z.file() });
