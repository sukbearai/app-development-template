import Link from "next/link";
import { cookies } from "next/headers";
import { auditPageQuerySchema } from "@pstack/contracts/modules/audit/contracts";
import { requirePermission } from "@pstack/server/modules/identity/service";
import { listAuditPage } from "@pstack/server/modules/audit/service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { PageHeader, Section } from "@/components/ui/page-layout";
import { DirectoryFilters } from "@/components/ui/directory-filters";
import { AuditDirectoryTable } from "@/components/audit/audit-directory-table";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  await requirePermission(token, "admin.read");
  const parsed = auditPageQuerySchema.safeParse(await searchParams);
  if (!parsed.success)
    return (
      <>
        <PageHeader title="审计日志" description="筛选或分页参数无效。" />
        <Link href="/admin/audit">重置筛选</Link>
      </>
    );
  const result = await listAuditPage(token, parsed.data);
  return (
    <>
      <PageHeader
        title="审计日志"
        eyebrow="Audit"
        description="分页查看操作记录；按 Trace、操作者或对象 ID 搜索，按完整动作名称筛选。"
      />
      <Section title="操作记录" description={`${result.total} 条记录。`}>
        <DirectoryFilters
          path="/admin/audit"
          {...parsed.data}
          fields={[
            { name: "action", label: "动作", value: parsed.data.action },
            {
              name: "sort",
              label: "排序",
              value: parsed.data.sort,
              options: [
                { value: "createdAt", label: "时间" },
                { value: "action", label: "动作" },
              ],
            },
          ]}
        />
        <AuditDirectoryTable result={result} />
      </Section>
    </>
  );
}
