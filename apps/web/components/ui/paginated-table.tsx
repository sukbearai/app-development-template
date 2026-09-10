"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { parseAsInteger, useQueryStates } from "nuqs";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useTransition } from "react";
import { useHydrated } from "@/lib/hooks/use-hydrated";

type PaginatedTableProps<T> = {
  items: T[];
  columns: ColumnDef<T>[];
  page: number;
  limit: number;
  total: number;
};

function TableView<T>({ items, columns, page, limit, total }: PaginatedTableProps<T>) {
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [, setQuery] = useQueryStates(
    { page: parseAsInteger.withDefault(1) },
    { shallow: false, history: "push", startTransition },
  );
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
    state: { pagination: { pageIndex: page - 1, pageSize: limit } },
  });
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return (
    <div aria-busy={pending}>
      <div className="table-wrap" tabIndex={0}>
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th scope="col" key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <p aria-live="polite">没有符合条件的记录，请调整筛选条件。</p>}
      <nav aria-label="列表分页" className="section-actions">
        <button
          className="button secondary"
          type="button"
          disabled={!hydrated || pending || page <= 1}
          onClick={() => void setQuery({ page: page - 1 })}
        >
          上一页
        </button>
        <span aria-live="polite">
          第 {page} / {pageCount} 页，共 {total} 条
        </span>
        <button
          className="button secondary"
          type="button"
          disabled={!hydrated || pending || page >= pageCount}
          onClick={() => void setQuery({ page: page + 1 })}
        >
          下一页
        </button>
        {page > pageCount && (
          <button
            className="button secondary"
            type="button"
            disabled={!hydrated || pending}
            onClick={() => void setQuery({ page: 1 })}
          >
            返回第一页
          </button>
        )}
      </nav>
    </div>
  );
}

export function PaginatedTable<T>(props: PaginatedTableProps<T>) {
  return (
    <NuqsAdapter>
      <TableView {...props} />
    </NuqsAdapter>
  );
}
