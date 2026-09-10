"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createAppQueryClient } from "@/lib/api-query-policy";
import { createBrowserRpcClient, TRPCProvider } from "@/lib/trpc-client";

export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [trpcClient] = useState(createBrowserRpcClient);
  const [queryClient] = useState(() =>
    createAppQueryClient(() => {
      window.location.replace("/login");
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
