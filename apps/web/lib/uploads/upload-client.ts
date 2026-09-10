"use client";

import { fileAssetSchema, type FileAsset } from "@pstack/contracts/modules/uploads/contracts";
import { ApiRequestError, parseApiResponse } from "../api-client";

export function validateUpload(file: File, maxBytes: number): string | null {
  if (!file.size) return "不能上传空文件";
  if (file.size > maxBytes) return `文件超过 ${maxBytes.toLocaleString()} 字节的大小限制`;
  return null;
}

export function uploadFile(input: {
  file: File;
  signal: AbortSignal;
  onProgress: (percent: number | null) => void;
}): Promise<FileAsset> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new ApiRequestError("上传已取消", { kind: "cancelled" }));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => {
      xhr.abort();
      reject(new ApiRequestError("上传已取消", { kind: "cancelled" }));
    };
    xhr.open("POST", "/api/uploads");
    xhr.timeout = 120_000;
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) =>
      input.onProgress(
        event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null,
      );
    xhr.onload = () => {
      try {
        resolve(
          parseApiResponse(
            xhr.response,
            xhr.status,
            fileAssetSchema,
            "上传失败",
            xhr.getResponseHeader("retry-after"),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () =>
      reject(
        new ApiRequestError("连接中断，请刷新资产列表确认上传结果", {
          kind: "network",
        }),
      );
    xhr.ontimeout = () =>
      reject(
        new ApiRequestError("上传超时，请刷新资产列表确认上传结果", {
          kind: "timeout",
        }),
      );
    xhr.onabort = () => reject(new ApiRequestError("上传已取消", { kind: "cancelled" }));
    xhr.onloadend = () => input.signal.removeEventListener("abort", abort);
    input.signal.addEventListener("abort", abort, { once: true });
    const body = new FormData();
    body.append("file", input.file);
    try {
      xhr.send(body);
    } catch {
      input.signal.removeEventListener("abort", abort);
      reject(
        new ApiRequestError("连接失败，请刷新资产列表确认上传结果", {
          kind: "network",
        }),
      );
    }
  });
}
