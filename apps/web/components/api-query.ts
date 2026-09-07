"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import type { z } from "zod";
import { requestJson } from "@/components/api-client";

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
}: {
  queryKey: QueryKey;
  schema: z.ZodType<T>;
  url: string;
  enabled?: boolean;
  fallbackMessage: string;
  refetchInterval?: number | false;
}) {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => requestJson(url, schema, { signal, fallbackMessage }),
    enabled,
    refetchInterval,
  });
}
