"use client";

import { asyncRuntimeHealthSchema } from "@pstack/contracts";
import { useApiQuery } from "@/components/api-query";
import { ApiRequestError } from "@/components/api-client";
import { CardSkeleton } from "@/components/skeleton";

export function RuntimeHealth() {
  const query = useApiQuery({
    queryKey: ["admin", "runtime-health"],
    url: "/api/admin/async-runtime-health",
    schema: asyncRuntimeHealthSchema,
    staleTime: 10_000,
    refetchInterval: 30_000,
    fallbackMessage: "暂时无法获取任务状态",
  });
  if (query.isPending)
    return (
      <div aria-busy="true">
        <p role="status">正在加载任务状态…</p>
        <CardSkeleton />
      </div>
    );
  return (
    <section aria-label="任务状态">
      {query.isError && (
        <p role="alert">
          {query.error.message}
          {query.error instanceof ApiRequestError && query.error.traceId
            ? `，追踪编号 ${query.error.traceId}`
            : ""}
        </p>
      )}
      {query.data && (
        <p>
          后台状态 {query.data.status} · 待处理 {query.data.tasks.pending} · 运行中{" "}
          {query.data.tasks.running} · 失败 {query.data.tasks.failed}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {query.isFetching ? "正在刷新…" : "刷新任务状态"}
      </button>
    </section>
  );
}
