"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { handleApiSessionError } from "../../lib/api-query-policy";
import { Upload, X, ListPlus } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { useHydrated } from "../../lib/hooks/use-hydrated";
import { uploadFile, validateUpload } from "../../lib/uploads/upload-client";
import { formatBytes } from "../../lib/format";

const UppyUploadForm = lazy(() =>
  import("./uppy-upload-form").then((module) => ({
    default: module.UppyUploadForm,
  })),
);

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number | null }
  | { kind: "success" | "error" | "cancelled"; message: string };

export function UploadAssetForm({ maxBytes }: { maxBytes: number }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ready = useHydrated();
  const helpId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const busy = state.kind === "uploading";

  useEffect(
    () => () => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      controller?.abort();
    },
    [],
  );

  function choose(files: FileList | null) {
    if (controllerRef.current) return;
    const selected = files?.item(0) ?? null;
    const error = selected ? validateUpload(selected, maxBytes) : null;
    setFile(error ? null : selected);
    setState(error ? { kind: "error", message: error } : { kind: "idle" });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "uploading", percent: 0 });
    try {
      const uploaded = await uploadFile({
        file,
        signal: controller.signal,
        onProgress: (percent) => {
          if (controllerRef.current === controller) setState({ kind: "uploading", percent });
        },
      });
      if (controllerRef.current !== controller) return;
      setState({ kind: "success", message: `已上传 ${uploaded.fileName}` });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (error) {
      if (error instanceof Error) handleApiSessionError(queryClient, error);
      if (controllerRef.current !== controller) return;
      setState(
        controller.signal.aborted
          ? {
              kind: "cancelled",
              message: "已停止传输。服务端可能已收到文件，请刷新资产列表确认。",
            }
          : {
              kind: "error",
              message: error instanceof Error ? error.message : "上传失败",
            },
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  if (batchMode)
    return (
      <section>
        <button className="button secondary" type="button" onClick={() => setBatchMode(false)}>
          <X size={16} />
          关闭批量队列，返回单文件上传
        </button>
        <Suspense fallback={<p role="status">正在准备批量上传…</p>}>
          <UppyUploadForm maxBytes={maxBytes} />
        </Suspense>
      </section>
    );

  return (
    <form className="admin-form" method="post" onSubmit={submit} aria-busy={busy}>
      <label>
        <span>选择文件</span>
        <input
          ref={inputRef}
          name="file"
          type="file"
          required
          disabled={!ready || busy}
          onChange={(event) => choose(event.target.files)}
          aria-describedby={helpId}
        />
      </label>
      <small id={helpId}>
        单个文件最大 {formatBytes(maxBytes)}。支持任意文件类型，禁止空文件。
      </small>
      {file && (
        <p>
          {file.name} · {formatBytes(file.size)} · {file.type || "未知类型"}
        </p>
      )}
      {state.kind === "uploading" && (
        <div role="status">
          <progress max={100} value={state.percent ?? undefined} aria-label="文件传输进度" />
          <p>
            {state.percent === 100
              ? "文件已发送，正在等待服务器确认…"
              : `正在上传${state.percent === null ? "…" : ` ${state.percent}%`}`}
          </p>
        </div>
      )}
      <div className="section-actions">
        <button
          className="button secondary"
          type="button"
          disabled={!ready || busy}
          onClick={() => setBatchMode(true)}
        >
          <ListPlus size={16} />
          批量上传
        </button>
        <button className="button primary" type="submit" disabled={!ready || !file || busy}>
          <Upload size={16} />
          上传
        </button>
        {busy && (
          <button
            className="button secondary"
            type="button"
            onClick={() => controllerRef.current?.abort()}
          >
            <X size={16} />
            取消上传
          </button>
        )}
      </div>
      {"message" in state && (
        <p
          role={state.kind === "error" ? "alert" : "status"}
          className={state.kind === "error" ? "form-error" : "form-message"}
        >
          {state.message}
        </p>
      )}
      {(state.kind === "cancelled" || state.kind === "error") && (
        <button className="button secondary" type="button" onClick={() => router.refresh()}>
          刷新资产列表
        </button>
      )}
    </form>
  );
}
