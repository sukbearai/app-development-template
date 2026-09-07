import { cookies } from "next/headers";
import { requirePermission } from "@pstack/server/auth-service";
import { listAuditEvents } from "@pstack/server/product-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { EmptyState, PageHeader, Section, formatDateTime } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const cookieStore = await cookies();
  await requirePermission(cookieStore.get(sessionCookieName)?.value, "admin.read");
  const events = await listAuditEvents();

  return (
    <>
      <PageHeader title="审计日志" eyebrow="Audit" description="展示最近 100 条后台、登录和文件操作记录，用于追踪人和对象的关系。" />
      <Section title="操作记录" description={`${events.length} 条记录。`}>
        {events.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>动作</th>
                  <th>对象</th>
                  <th>操作者</th>
                  <th>Trace</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td><code>{event.action}</code></td>
                    <td>{event.targetType ? `${event.targetType}:${event.targetId || "-"}` : "-"}</td>
                    <td>{event.actorId || "-"}</td>
                    <td><code>{event.traceId}</code></td>
                    <td>{formatDateTime(event.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无审计记录" description="用户登录、管理写入或文件上传后会产生审计记录。" />
        )}
      </Section>
    </>
  );
}
