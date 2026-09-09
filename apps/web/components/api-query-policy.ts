import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./api-client";

export type AuthenticationPolicy = "required" | "public";

const sessionHandlers = new WeakMap<QueryClient, () => void>();

export function handleApiSessionError(
  client: QueryClient,
  error: Error,
  authentication: AuthenticationPolicy = "required",
) {
  if (authentication === "public" || !(error instanceof ApiRequestError) || error.status !== 401)
    return;
  const onSessionExpired = sessionHandlers.get(client);
  if (!onSessionExpired) return;
  sessionHandlers.delete(client);
  client.clear();
  onSessionExpired();
}

function validRetryDelay(delay: number) {
  return Number.isFinite(delay) && delay >= 0 && delay <= 60_000;
}

export function retryApiQuery(failureCount: number, error: Error) {
  if (failureCount >= 2 || !(error instanceof ApiRequestError)) return false;
  if (error.kind === "network" || error.kind === "timeout") return true;
  if (error.kind !== "http") return false;
  if (error.retryAfterMs !== undefined && !validRetryDelay(error.retryAfterMs)) return false;
  if (error.status === 429 || error.status === 503) return error.retryAfterMs !== undefined;
  return error.status === 502 || error.status === 504;
}

export function apiQueryRetryDelay(attempt: number, error: Error) {
  if (
    error instanceof ApiRequestError &&
    error.retryAfterMs !== undefined &&
    validRetryDelay(error.retryAfterMs)
  )
    return error.retryAfterMs;
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function createAppQueryClient(onSessionExpired: () => void) {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) =>
        handleApiSessionError(
          client,
          error,
          query.meta?.authentication === "public" ? "public" : "required",
        ),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) =>
        handleApiSessionError(
          client,
          error,
          mutation.meta?.authentication === "public" ? "public" : "required",
        ),
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: retryApiQuery,
        retryDelay: apiQueryRetryDelay,
      },
      mutations: { retry: false },
    },
  });
  sessionHandlers.set(client, onSessionExpired);
  return client;
}
