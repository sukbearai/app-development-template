import { z } from "zod";

import {
  nonEmptyStringSchema,
  isoDateTimeSchema,
  pageQueryFields,
  pageInfoSchema,
} from "../../primitives.ts";

export const userSchema = z.object({
  id: nonEmptyStringSchema,
  account: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  status: z.enum(["enabled", "disabled"]),
  roleIds: z.array(nonEmptyStringSchema),
  createdAt: isoDateTimeSchema,
});

export const roleSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  permissionIds: z.array(nonEmptyStringSchema),
  status: z.enum(["active", "inactive"]),
});

export const permissionSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});

export const authSessionSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
});

export const passwordSchema = z.string().min(1);

export const newPasswordSchema = passwordSchema.min(8).max(256);

export const changePasswordRequestSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: newPasswordSchema,
});

export const resetUserPasswordRequestSchema = z.object({ newPassword: newPasswordSchema });

export const changePasswordResponseSchema = z.object({ reauthenticate: z.literal(true) });

export const resetUserPasswordResponseSchema = z.object({ updated: z.literal(true) });

export const loginRequestSchema = z.object({
  account: nonEmptyStringSchema,
  password: passwordSchema,
});

export const loginResponseSchema = z.object({
  token: nonEmptyStringSchema,
  session: authSessionSchema,
  user: userSchema,
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
});

export const createUserRequestSchema = z.object({
  account: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  password: newPasswordSchema,
  roleIds: z.array(nonEmptyStringSchema).default([]),
  status: z.enum(["enabled", "disabled"]).default("enabled"),
});

export const updateUserRequestSchema = z.object({
  displayName: nonEmptyStringSchema.optional(),
  roleIds: z.array(nonEmptyStringSchema).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const createRoleRequestSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  permissionIds: z.array(nonEmptyStringSchema).default([]),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const updateRoleRequestSchema = z.object({
  name: nonEmptyStringSchema.optional(),
  permissionIds: z.array(nonEmptyStringSchema).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type User = z.infer<typeof userSchema>;

export type Role = z.infer<typeof roleSchema>;

export type Permission = z.infer<typeof permissionSchema>;

export type AuthSession = z.infer<typeof authSessionSchema>;

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export type ResetUserPasswordRequest = z.infer<typeof resetUserPasswordRequestSchema>;

export const userPageQuerySchema = z.object({
  ...pageQueryFields,
  status: z.enum(["all", "enabled", "disabled"]).default("all"),
  sort: z.enum(["createdAt", "account", "displayName"]).default("createdAt"),
});

export const userPageSchema = pageInfoSchema.extend({ items: z.array(userSchema) });

export type UserPageQuery = z.infer<typeof userPageQuerySchema>;

export type UserPage = z.infer<typeof userPageSchema>;

export const currentUserResponseSchema = loginResponseSchema.omit({ token: true });

export const userDirectorySchema = pageInfoSchema.extend({
  users: z.array(userSchema),
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
});

export const logoutResponseSchema = z.object({ ok: z.literal(true) });
