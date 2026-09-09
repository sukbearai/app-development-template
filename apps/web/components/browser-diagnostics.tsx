"use client";

import { useEffect } from "react";

let lastReportedAt = 0;

export function reportBrowserFailure(kind: "render" | "script" | "promise") {
  const now = Date.now();
  if (now - lastReportedAt < 10_000) return;
  lastReportedAt = now;
  void fetch("/api/telemetry", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "browser.error", payload: { kind } }),
    signal: AbortSignal.timeout(5000),
    keepalive: true,
  }).catch(() => undefined);
}

export function BrowserDiagnostics() {
  useEffect(() => {
    const onError = () => reportBrowserFailure("script");
    const onRejection = () => reportBrowserFailure("promise");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
