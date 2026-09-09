import { listUsers } from "@pstack/server/auth-service";
import { requirePermission } from "@pstack/server/auth-service";
import { adminSummary } from "@pstack/server/product-service";
import { cookies } from "next/headers";
import { sessionCookieName } from "@pstack/server/request-auth";
import { Activity, Archive, ClipboardList, FileUp, UsersRound } from "lucide-react";
import { PageHeader, Section, StatCard, StatGrid, StatusBadge } from "@/components/admin/admin-ui";
import { AdminResourceChart } from "@/components/admin/admin-charts";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const cookieStore = await cookies();
  await requirePermission(cookieStore.get(sessionCookieName)?.value, "admin.read");
  const users = await listUsers();
  const summary = await adminSummary();
  const metrics = [
    { label: "用户", value: summary.users, hint: "RBAC 账号", icon: <UsersRound size={18} /> },
    {
      label: "审计",
      value: summary.auditEvents,
      hint: "操作追踪",
      icon: <ClipboardList size={18} />,
    },
    {
      label: "埋点",
      value: summary.telemetryEvents,
      hint: "前端事件",
      icon: <Activity size={18} />,
    },
    { label: "文件", value: summary.files, hint: "上传资产", icon: <FileUp size={18} /> },
    {
      label: "待发布事件",
      value: summary.outboxPending,
      hint: "Outbox backlog",
      icon: <Archive size={18} />,
    },
  ] as const;
  const enabledUsers = users.filter((user) => user.status === "enabled").length;
  const chartData = [
    { label: "用户", value: summary.users },
    { label: "审计", value: summary.auditEvents },
    { label: "埋点", value: summary.telemetryEvents },
    { label: "文件", value: summary.files },
    { label: "Outbox", value: summary.outboxPending },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Admin Console"
        title="管理端概览"
        description="模板默认提供认证、权限、审计、文件和 outbox 管理骨架，新业务可以在此基础上增加领域页面。"
      />
      <StatGrid>
        {metrics.map((metric) => (
          <StatCard key={metric.label} {...metric} />
        ))}
      </StatGrid>
      <Section title="生产化基线" description="这些能力来自当前模板代码路径，不依赖静态演示数据。">
        <div className="admin-checklist">
          <div>
            <StatusBadge tone="success">已接入</StatusBadge>
            <strong>页面权限</strong>
            <span>管理端 layout 和页面读取都校验 admin.read。</span>
          </div>
          <div>
            <StatusBadge tone="success">已接入</StatusBadge>
            <strong>写接口权限</strong>
            <span>用户、角色和上传写入继续由 API 校验 admin.write / file.upload。</span>
          </div>
          <div>
            <StatusBadge tone={summary.outboxPending > 0 ? "warning" : "success"}>
              {summary.outboxPending > 0 ? "待处理" : "正常"}
            </StatusBadge>
            <strong>Outbox</strong>
            <span>
              {summary.outboxPending > 0
                ? `${summary.outboxPending} 条事件等待发布`
                : "当前没有待发布事件"}
            </span>
          </div>
          <div>
            <StatusBadge tone={enabledUsers > 0 ? "success" : "warning"}>
              {enabledUsers} 个启用账号
            </StatusBadge>
            <strong>账号状态</strong>
            <span>用户列表来自 PostgreSQL-backed repository。</span>
          </div>
        </div>
      </Section>
      <Section
        title="资源分布"
        description="图表依赖与管理端骨架一起可用，数据来自当前后台汇总接口。"
      >
        <AdminResourceChart data={chartData} />
      </Section>
    </>
  );
}
