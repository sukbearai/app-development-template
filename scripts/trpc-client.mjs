import { createTRPCClient, httpLink } from "@trpc/client";

export function createTestTrpcClient({
  baseUrl,
  headers = {},
  request,
  fetch: transport = globalThis.fetch,
  onResponse,
  timeoutMs = 15_000,
}) {
  return createTRPCClient({
    links: [
      httpLink({
        url: new URL("/api/trpc", baseUrl).href,
        headers,
        fetch: async (url, options) => {
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new DOMException("Request timeout", "TimeoutError")),
            timeoutMs,
          );
          const signal = options?.signal
            ? AbortSignal.any([options.signal, deadline.signal])
            : deadline.signal;
          let rejectAborted;
          const aborted = new Promise((_, reject) => {
            rejectAborted = () => reject(signal.reason);
            signal.addEventListener("abort", rejectAborted, { once: true });
          });
          async function receive() {
            signal.throwIfAborted();
            let response;
            if (request) {
              // Playwright has no per-request AbortSignal. Cancellation rejects the caller;
              // its native timeout bounds the underlying request without disposing the shared context.
              const result = await request.fetch(String(url), {
                method: options?.method,
                headers: Object.fromEntries(new Headers(options?.headers)),
                data: options?.body,
                failOnStatusCode: false,
                timeout: timeoutMs,
              });
              response = new Response(await result.body(), {
                status: result.status(),
                statusText: result.statusText(),
                headers: result.headers(),
              });
            } else {
              response = await transport(url, { ...options, signal });
            }
            await onResponse?.(response);
            // Drain a clone inside the deadline so tRPC only decodes buffered bytes after return.
            await response.clone().arrayBuffer();
            signal.throwIfAborted();
            return response;
          }
          try {
            return await Promise.race([receive(), aborted]);
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", rejectAborted);
          }
        },
      }),
    ],
  });
}
