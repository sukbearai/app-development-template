import type { Metadata } from "next";
import { env } from "@pstack/server/env";
import { AppQueryProvider } from "@/components/query-provider";
import { BrowserDiagnostics } from "@/components/browser-diagnostics";
import { Notifications } from "@/components/notifications";
import "./globals.css";

export const metadata: Metadata = {
  title: env.APP_NAME,
  description: "Full-stack application template",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppQueryProvider>
          <BrowserDiagnostics />
          {children}
          <Notifications />
        </AppQueryProvider>
      </body>
    </html>
  );
}
