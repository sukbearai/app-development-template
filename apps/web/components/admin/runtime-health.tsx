"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC, requestError } from "@/components/trpc-client";
import { ApiRequestError } from "@/components/api-client";
import { CardSkeleton } from "@/components/skeleton";

export function RuntimeHealth() {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.runtime.health.queryOptions(undefined, {
      staleTime: 10_000,
      refetchInterval: 30_000,
      trpc: { abortOnUnmount: true },
    }),
  );
  const error = query.error ? requestError(query.error) : null;
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
          {error?.message}
          {error instanceof ApiRequestError && error.traceId ? `，追踪编号 ${error.traceId}` : ""}
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
