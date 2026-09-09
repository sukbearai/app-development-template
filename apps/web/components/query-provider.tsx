"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createAppQueryClient } from "@/components/api-query-policy";

export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() =>
    createAppQueryClient(() => {
      window.location.replace("/login");
    }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
