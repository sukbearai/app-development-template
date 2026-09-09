"use client";

import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import { fileAssetSchema, type FileAsset } from "@pstack/contracts";
import { ApiRequestError, parseApiResponse } from "./api-client";

function uploadError(error: Error): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  if (error.cause instanceof Error) return uploadError(error.cause);
  return new ApiRequestError("连接中断，请刷新资产列表确认上传结果", {
    kind: "network",
  });
}

export function createBatchUploader(maxBytes: number, onError?: (error: ApiRequestError) => void) {
  const uppy = new Uppy<Record<string, never>, FileAsset>({
    autoProceed: false,
    restrictions: {
      maxFileSize: maxBytes,
      minFileSize: 1,
      maxNumberOfFiles: 20,
    },
  });
  let stopping = false;
  function stop(error: ApiRequestError) {
    stopping = true;
    uppy.cancelAll();
    stopping = false;
    onError?.(error);
  }
  uppy.on("upload-error", (_file, error) => {
    const failure = uploadError(error);
    if (failure.status === 401) stop(failure);
    else onError?.(failure);
  });
  uppy.on("upload-stalled", () =>
    stop(
      new ApiRequestError("上传超时，请刷新资产列表确认上传结果", {
        kind: "timeout",
      }),
    ),
  );
  uppy.on("cancel-all", () => {
    if (!stopping) onError?.(new ApiRequestError("上传已取消", { kind: "cancelled" }));
  });
  return uppy.use(XHRUpload, {
    endpoint: "/api/uploads",
    fieldName: "file",
    formData: true,
    bundle: false,
    allowedMetaFields: [],
    limit: 1,
    responseType: "json",
    shouldRetry: () => false,
    onAfterResponse: (xhr) => {
      try {
        parseApiResponse(
          xhr.response,
          xhr.status,
          fileAssetSchema,
          "上传失败",
          xhr.getResponseHeader("retry-after"),
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) stop(error);
        throw error;
      }
    },
    getResponseData: (xhr) =>
      parseApiResponse(
        xhr.response,
        xhr.status,
        fileAssetSchema,
        "上传失败",
        xhr.getResponseHeader("retry-after"),
      ),
  });
}
