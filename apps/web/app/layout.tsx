import type { Metadata } from "next";
import { env } from "@pstack/server/env";
import { AppQueryProvider } from "@/components/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: env.APP_NAME,
  description: "Full-stack application template",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppQueryProvider>{children}</AppQueryProvider>
      </body>
    </html>
  );
}
