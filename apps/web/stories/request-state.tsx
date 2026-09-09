import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { roleSchema } from "@pstack/contracts";
import { EmptyState, Section, StatusBadge } from "../components/admin/admin-ui";
import { CardSkeleton } from "../components/skeleton";
import { useApiQuery } from "../components/api-query";

function RoleRequest() {
  const query = useApiQuery({
    queryKey: ["storybook", "roles"],
    schema: roleSchema.array(),
    url: "/api/admin/roles",
    fallbackMessage: "角色加载失败",
  });
  if (query.isPending)
    return (
      <div role="status" aria-label="正在加载角色">
        <CardSkeleton />
      </div>
    );
  if (query.isError)
    return (
      <div role="alert">
        <p>{query.error.message}</p>
        <button className="button secondary" onClick={() => query.refetch()}>
          重试
        </button>
      </div>
    );
  if (query.data.length === 0) return <EmptyState title="暂无角色" />;
  return (
    <ul>
      {query.data.map((role) => (
        <li key={role.id}>
          {role.name}{" "}
          <StatusBadge tone="success">{role.status === "active" ? "启用" : "停用"}</StatusBadge>
        </li>
      ))}
    </ul>
  );
}

export function RequestState() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Section title="角色请求">
        <RoleRequest />
      </Section>
    </QueryClientProvider>
  );
}
