import createClient, { type ClientOptions, type Middleware } from "openapi-fetch";
import { apiOperations, parseApiResponse } from "@pstack/contracts/http";
import type { paths } from "./schema.d.ts";

export type { paths, components, operations } from "./schema.d.ts";

const validation: Middleware = {
  async onRequest({ request, schemaPath }) {
    const operation = apiOperations.find(
      (entry) => entry.method === request.method && entry.path === schemaPath,
    );
    if (!operation) throw new Error(`Unknown API operation: ${request.method} ${schemaPath}`);
    if (!("request" in operation)) return;
    const contract = operation.request;
    const body = request.clone();
    const contentType = request.headers.get("content-type")?.split(";", 1)[0];
    if (contentType !== contract.contentType) {
      throw new Error(`Expected ${contract.contentType} for ${operation.operationId}`);
    }
    contract.schema.parse(
      contract.contentType === "multipart/form-data"
        ? Object.fromEntries(await body.formData())
        : await body.json(),
    );
  },
  async onResponse({ request, response, schemaPath }) {
    const operation = apiOperations.find(
      (entry) => entry.method === request.method && entry.path === schemaPath,
    );
    if (!operation) throw new Error(`Unknown API operation: ${request.method} ${schemaPath}`);
    parseApiResponse(operation.operationId, response.status, await response.clone().json());
  },
};

export function createApiClient(options: ClientOptions = {}) {
  const client = createClient<paths>(options);
  client.use(validation);
  return client;
}
