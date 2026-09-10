"use client";

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
