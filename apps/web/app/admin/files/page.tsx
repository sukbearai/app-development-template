import Link from "next/link";
import { filePageQuerySchema } from "@pstack/contracts/modules/uploads/contracts";
import { cookies } from "next/headers";
import { listRoles, requirePermission } from "@pstack/server/modules/identity/service";
import { env } from "@pstack/server/env";
import { listFiles } from "@pstack/server/modules/uploads/service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { UploadAssetForm } from "@/components/uploads/upload-asset-form";
import { EmptyState, PageHeader, PermissionNotice, Section } from "@/components/ui/page-layout";
import { formatBytes, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type FilesPageProps = {
  searchParams: Promise<{ cursor?: string | string[]; limit?: string | string[] }>;
};

export default async function AdminFilesPage({ searchParams }: FilesPageProps) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const actor = await requirePermission(token, "admin.read");
  const parsed = filePageQuerySchema.safeParse(await searchParams);
  if (!parsed.success)
    return (
      <>
        <PageHeader title="文件资产" description="分页参数无效，请返回最新文件重试。" />
        <Link href="/admin/files">最新文件</Link>
      </>
    );
  const [roles, result] = await Promise.all([listRoles(), listFiles(token, parsed.data)]);
  const files = result.items;
  const nextSearch = result.nextCursor
    ? new URLSearchParams({
        cursor: JSON.stringify(result.nextCursor),
        limit: String(parsed.data.limit),
      })
    : null;
  const canUpload = roles.some(
    (role) =>
      role.status === "active" &&
      actor.roleIds.includes(role.id) &&
      role.permissionIds.includes("file.upload"),
  );

  return (
    <>
      <PageHeader
        title="文件资产"
        eyebrow="Object Storage"
        description="管理已上传的文件和上传记录。"
      />
      {canUpload ? (
        <Section title="上传文件" description="选择需要保存的文件。">
          <UploadAssetForm maxBytes={env.UPLOAD_MAX_BYTES} />
        </Section>
      ) : (
        <PermissionNotice message="当前账号没有 file.upload 权限。" />
      )}
      <Section title="资产列表" description={`本页 ${files.length} 个文件。`}>
        {files.length ? (
          <div className="table-wrap" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>上传者</th>
                  <th>时间</th>
                  <th>存储键</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td>{file.fileName}</td>
                    <td>{file.mimeType}</td>
                    <td>{formatBytes(file.sizeBytes)}</td>
                    <td>{file.uploadedBy || "-"}</td>
                    <td>{formatDateTime(file.uploadedAt)}</td>
                    <td>
                      <code>{file.storageKey}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无文件" description="上传成功后，文件会显示在这里。" />
        )}
      </Section>
      <nav aria-label="文件分页">
        {parsed.data.cursor && <Link href="/admin/files">最新文件</Link>}
        {nextSearch && <Link href={`/admin/files?${nextSearch}`}>下一页</Link>}
      </nav>
    </>
  );
}
