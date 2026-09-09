"use client";

import { useEffect } from "react";
import { reportBrowserFailure } from "@/components/browser-diagnostics";

export default function PageError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportBrowserFailure("render");
  }, []);
  return (
    <section className="panel" role="alert">
      <h1>页面暂时无法显示</h1>
      <p>请重试。如果仍然失败，请联系管理员。</p>
      <button className="button primary" type="button" onClick={reset}>
        重新加载
      </button>
    </section>
  );
}
