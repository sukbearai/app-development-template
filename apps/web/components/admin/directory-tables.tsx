"use client";

import type { AuditEvent, Role, User } from "@pstack/contracts";
import type { AuditPage, UserPage } from "@pstack/contracts/admin-pages";
import type { ColumnDef } from "@tanstack/react-table";
import { PaginatedTable } from "./paginated-table";
import { ResetUserPasswordForm } from "./password-actions";
import { UserStatusButton } from "./admin-actions";
import { StatusBadge, formatDateTime } from "./admin-ui";

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

const auditColumns: ColumnDef<AuditEvent>[] = [
  { accessorKey: "action", header: "动作", cell: ({ row }) => <code>{row.original.action}</code> },
  {
    id: "target",
    header: "对象",
    cell: ({ row }) =>
      row.original.targetType ? `${row.original.targetType}:${row.original.targetId || "-"}` : "-",
  },
  { accessorKey: "actorId", header: "操作者", cell: ({ row }) => row.original.actorId || "-" },
  {
    accessorKey: "traceId",
    header: "Trace",
    cell: ({ row }) => <code>{row.original.traceId}</code>,
  },
  {
    accessorKey: "createdAt",
    header: "时间",
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
];
export function AuditDirectoryTable({ result }: { result: AuditPage }) {
  return <PaginatedTable {...result} columns={auditColumns} />;
}
