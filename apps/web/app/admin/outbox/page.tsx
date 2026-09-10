import { cookies } from "next/headers";
import { requirePermission } from "@pstack/server/modules/identity/service";
import { listOutboxEvents } from "@pstack/server/modules/outbox/service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { RuntimeHealth } from "@/components/runtime/runtime-health";
import { EmptyState, PageHeader, Section, StatusBadge } from "@/components/ui/page-layout";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

function outboxTone(status: string) {
  if (status === "published") return "success" as const;
  if (status === "failed" || status === "dead_letter") return "danger" as const;
  if (status === "processing") return "info" as const;
  return "warning" as const;
}

export default async function AdminOutboxPage() {
  const cookieStore = await cookies();
  await requirePermission(cookieStore.get(sessionCookieName)?.value, "admin.read");
  const events = await listOutboxEvents();

  return (
    <>
      <PageHeader
        title="Outbox 事件"
        eyebrow="Async Runtime"
        description="事件先写入 PostgreSQL，再由 worker 发布到 Kafka 或执行 dry-run。"
      />
      <RuntimeHealth />
      <Section title="事件队列" description={`${events.length} 条最近事件。`}>
        {events.length ? (
          <div className="table-wrap" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>事件</th>
                  <th>Topic</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>下次处理</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <code>{event.eventType}</code>
                    </td>
                    <td>{event.topic}</td>
                    <td>
                      <StatusBadge tone={outboxTone(event.status)}>{event.status}</StatusBadge>
                    </td>
                    <td>
                      {event.attempts}/{event.maxAttempts}
                    </td>
                    <td>{formatDateTime(event.nextAttemptAt)}</td>
                    <td>
                      <code>{event.traceId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无事件" description="上传、埋点或业务事件写入后会进入 outbox。" />
        )}
      </Section>
    </>
  );
}
