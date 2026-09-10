"use client";

import type { AuditEvent, AuditPage } from "@pstack/contracts/modules/audit/contracts";

import type { ColumnDef } from "@tanstack/react-table";
import { PaginatedTable } from "../ui/paginated-table";
import { formatDateTime } from "../../lib/format";

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
