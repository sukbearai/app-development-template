"use client";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";
import Dashboard from "@uppy/react/dashboard";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { handleApiSessionError } from "../../lib/api-query-policy";
import { useEffect, useState } from "react";
import { createBatchUploader } from "../../lib/uploads/uppy-client";
import { formatBytes } from "../../lib/format";

export function UppyUploadForm({ maxBytes }: { maxBytes: number }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [uppy, setUppy] = useState<ReturnType<typeof createBatchUploader> | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const instance = createBatchUploader(maxBytes, (error) =>
      handleApiSessionError(queryClient, error),
    );
    instance.on("complete", (result) => {
      if (!active) return;
      const failed = result.failed?.length ?? 0;
      const successful = result.successful?.length ?? 0;
      setMessage(
        `已上传 ${successful} 个文件${failed ? `，失败 ${failed} 个。请查看文件错误，并刷新资产列表确认结果。` : "。"}`,
      );
      if (successful) router.refresh();
    });
    instance.on("cancel-all", () => {
      if (active) setMessage("已停止传输，请刷新资产列表确认服务端是否已收到文件。");
    });
    setUppy(instance);
    return () => {
      active = false;
      instance.destroy();
    };
  }, [maxBytes, router, queryClient]);

  if (!uppy) return <p role="status">正在准备批量上传…</p>;
  return (
    <div>
      <p>
        可拖入文件或点击选择，每批最多 20
        个。取消后再次上传会从头发送文件。连接中断时请先刷新列表确认结果，重复上传会创建新的文件记录。
      </p>
      <Dashboard
        uppy={uppy}
        proudlyDisplayPoweredByUppy={false}
        hideProgressDetails={false}
        hidePauseResumeButton
        note={`任意类型，单个文件最大 ${formatBytes(maxBytes)}，禁止空文件。`}
        locale={{
          strings: {
            dropPasteFiles: "拖放文件到这里或%{browseFiles}",
            browseFiles: "选择文件",
            addMoreFiles: "添加文件",
            dashboardTitle: "批量上传文件",
            cancelUpload: "取消上传",
            removeFile: "移除文件",
            uploadComplete: "上传完成",
            retryUpload: "重新上传",
          },
        }}
      />
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
      <button className="button secondary" type="button" onClick={() => router.refresh()}>
        刷新资产列表
      </button>
    </div>
  );
}
