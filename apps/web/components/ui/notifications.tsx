"use client";

import { Toaster } from "sonner";

export function Notifications() {
  return <Toaster position="top-right" closeButton richColors toastOptions={{ duration: 4000 }} />;
}
