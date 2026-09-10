"use client";

import { useEffect } from "react";
import { reportBrowserFailure } from "../../lib/browser-diagnostics";

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
