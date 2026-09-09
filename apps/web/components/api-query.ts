"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { z } from "zod";
import { requestJson } from "@/components/api-client";
import type { AuthenticationPolicy } from "@/components/api-query-policy";

type QueryParamValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryParamValue>;

export function normalizeQueryParams(params: QueryParams) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function queryString(params: QueryParams) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(normalizeQueryParams(params))) {
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export function useApiQuery<T>({
  queryKey,
  schema,
  url,
  enabled = true,
  fallbackMessage,
  refetchInterval,
  staleTime,
  authentication = "required",
}: {
  queryKey: QueryKey;
  schema: z.ZodType<T>;
  url: string;
  enabled?: boolean;
  fallbackMessage: string;
  refetchInterval?: number | false;
  staleTime?: number;
  authentication?: AuthenticationPolicy;
}) {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => requestJson(url, schema, { signal, fallbackMessage }),
    enabled,
    refetchInterval,
    staleTime,
    meta: { authentication },
  });
}

export function useApiMutation<T, TVariables>({
  mutationFn,
  invalidateKeys = [],
  authentication = "required",
  onSuccess,
  onError,
}: {
  mutationFn: (variables: TVariables) => Promise<T>;
  invalidateKeys?: readonly QueryKey[];
  authentication?: AuthenticationPolicy;
  onSuccess?: (data: T, variables: TVariables) => void | Promise<void>;
  onError?: (error: Error, variables: TVariables) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    retry: false,
    meta: { authentication },
    onSuccess: async (data, variables) => {
      await Promise.all(
        invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
      );
      await onSuccess?.(data, variables);
    },
    onError,
  });
}
