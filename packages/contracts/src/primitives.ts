import { z } from "zod";

export const nonEmptyStringSchema = z.string().trim().min(1);

export const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

const pageNumberSchema = z
  .union([z.string().regex(/^\d+$/), z.number()])
  .transform(Number)
  .pipe(z.number().int().min(1).max(10000));

const pageSizeSchema = z
  .union([z.string().regex(/^\d+$/), z.number()])
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

export const searchTextSchema = z.string().trim().max(200).default("");

export const pageQueryFields = {
  page: pageNumberSchema.default(1),
  limit: pageSizeSchema.default(25),
  search: searchTextSchema,
  direction: z.enum(["asc", "desc"]).default("desc"),
};

export const pageInfoSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
