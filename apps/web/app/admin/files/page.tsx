import { cookies } from "next/headers";
import { listRoles, requirePermission } from "@pstack/server/auth-service";
import { listFiles } from "@pstack/server/product-service";
import { sessionCookieName } from "@pstack/server/request-auth";
import { UploadAssetForm } from "@/components/admin/admin-actions";
import { EmptyState, PageHeader, PermissionNotice, Section, formatBytes, formatDateTime } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminFilesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const actor = await requirePermission(token, "admin.read");
  const [roles, files] = await Promise.all([listRoles(), listFiles()]);
  const canUpload = roles.some((role) => role.status === "active" && actor.roleIds.includes(role.id) && role.permissionIds.includes("file.upload"));

  return (
    <>
      <PageHeader title="文件资产" eyebrow="Object Storage" description="管理已上传的文件和上传记录。" />
      {canUpload ? (
        <Section title="上传文件" description="选择需要保存的文件。">
          <UploadAssetForm />
        </Section>
      ) : (
        <PermissionNotice message="当前账号没有 file.upload 权限。" />
      )}
      <Section title="资产列表" description={`${files.length} 个文件。`}>
        {files.length ? (
          <div className="table-wrap">
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
                    <td><code>{file.storageKey}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无文件" description="上传成功后，文件会显示在这里。" />
        )}
      </Section>
    </>
  );
}
