import { useQuery } from "@tanstack/react-query";
import { EmptyState, Section, StatusBadge } from "../components/admin/admin-ui";
import { CardSkeleton } from "../components/skeleton";
import { useTRPC } from "../components/trpc-client";

function RoleRequest() {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.roles.list.queryOptions(undefined, { retry: false, trpc: { abortOnUnmount: true } }),
  );
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
  return (
    <Section title="角色请求">
      <RoleRequest />
    </Section>
  );
}
