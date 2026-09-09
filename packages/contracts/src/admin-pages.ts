import { z } from "zod";
import { auditEventSchema, userSchema } from "./schemas.ts";

const pageNumberSchema = z
  .union([z.string().regex(/^\d+$/), z.number()])
  .transform(Number)
  .pipe(z.number().int().min(1).max(10000));
const pageSizeSchema = z
  .union([z.string().regex(/^\d+$/), z.number()])
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));
const searchTextSchema = z.string().trim().max(200).default("");
const pageQueryFields = {
  page: pageNumberSchema.default(1),
  limit: pageSizeSchema.default(25),
  search: searchTextSchema,
  direction: z.enum(["asc", "desc"]).default("desc"),
};
export const userPageQuerySchema = z.object({
  ...pageQueryFields,
  status: z.enum(["all", "enabled", "disabled"]).default("all"),
  sort: z.enum(["createdAt", "account", "displayName"]).default("createdAt"),
});
export const auditPageQuerySchema = z.object({
  ...pageQueryFields,
  action: searchTextSchema,
  sort: z.enum(["createdAt", "action"]).default("createdAt"),
});
export const pageInfoSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
export const userPageSchema = pageInfoSchema.extend({ items: z.array(userSchema) });
export const auditPageSchema = pageInfoSchema.extend({ items: z.array(auditEventSchema) });
export type UserPageQuery = z.infer<typeof userPageQuerySchema>;
export type AuditPageQuery = z.infer<typeof auditPageQuerySchema>;
export type UserPage = z.infer<typeof userPageSchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;

export function readPageSearchParams(params: URLSearchParams) {
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}
