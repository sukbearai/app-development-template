"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createAppQueryClient } from "@/components/api-query-policy";
import { createBrowserRpcClient, TRPCProvider } from "@/components/trpc-client";

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
