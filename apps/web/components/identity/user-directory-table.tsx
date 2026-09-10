"use client";

import type { Role, User, UserPage } from "@pstack/contracts/modules/identity/contracts";

import type { ColumnDef } from "@tanstack/react-table";
import { PaginatedTable } from "../ui/paginated-table";
import { ResetUserPasswordForm } from "./password-actions";
import { UserStatusButton } from "./identity-actions";
import { StatusBadge } from "../ui/page-layout";
import { formatDateTime } from "../../lib/format";

export function UserDirectoryTable({
  result,
  roles,
  actorId,
  canWrite,
}: {
  result: UserPage;
  roles: Role[];
  actorId: string;
  canWrite: boolean;
}) {
  const roleNames = new Map(roles.map((role) => [role.id, role.name]));
  const columns: ColumnDef<User>[] = [
    {
      accessorKey: "account",
      header: "账号",
      cell: ({ row }) => <code>{row.original.account}</code>,
    },
    { accessorKey: "displayName", header: "姓名" },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <StatusBadge tone={row.original.status === "enabled" ? "success" : "danger"}>
          {row.original.status === "enabled" ? "启用" : "停用"}
        </StatusBadge>
      ),
    },
    {
      id: "roles",
      header: "角色",
      cell: ({ row }) =>
        row.original.roleIds.map((id) => roleNames.get(id) ?? id).join("，") || "-",
    },
    {
      accessorKey: "createdAt",
      header: "创建时间",
      cell: ({ row }) => formatDateTime(row.original.createdAt),
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) =>
        canWrite ? (
          <>
            <UserStatusButton user={row.original} />
            {row.original.id !== actorId && (
              <ResetUserPasswordForm userId={row.original.id} account={row.original.account} />
            )}
          </>
        ) : (
          "-"
        ),
    },
  ];
  return <PaginatedTable {...result} columns={columns} />;
}
