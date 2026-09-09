# TypeScript SDK

`@pstack/sdk` provides an `openapi-fetch` client for the HTTP operations in
`packages/contracts/src/http.ts`. `openapi-typescript` generates its route, request,
and response types from `docs/openapi.json`.

```sh
pnpm sdk:generate
pnpm sdk:check
pnpm test:sdk
pnpm --filter @pstack/sdk typecheck
```

Generation first updates OpenAPI from the Zod operation registry. The check first
verifies the OpenAPI contract, then compares generated SDK types without writing
files. Include `packages/sdk/src/schema.d.ts` whenever contracts change. Do not
edit that file manually.

Add `@pstack/sdk: workspace:*` to a consuming workspace package, then create a
client with an explicit origin. A browser caller can use `window.location.origin`.

```ts
import { createApiClient } from "@pstack/sdk";

const api = createApiClient({ baseUrl: "http://localhost:3000" });
const { data, error, response } = await api.GET("/api/auth/me");
if (error) {
  console.error(response.status, error.error.message);
} else {
  console.log(data.data.user);
}
```

Generated TypeScript types describe the protocol at compile time. The client also
validates request bodies and every response with the existing Zod registry.
Invalid payloads and undocumented status codes reject the request promise. Valid
HTTP error responses remain in `error`; a 401 does not itself throw. The SDK keeps
fetch's default cookie policy. Cross-origin browser clients must configure
`credentials` and the server's allowed origins explicitly. Server clients must
supply their own authentication headers.

Uploads use multipart form data. Pass a serializer so fetch sets the boundary:

```ts
await api.POST("/api/uploads", {
  body: { file: new File(["hello"], "example.txt", { type: "text/plain" }) },
  bodySerializer(body) {
    const form = new FormData();
    form.set("file", body.file);
    return form;
  },
});
```

`File` is the generated type for OpenAPI binary fields. Free-form JSON records
retain the contracts package's Zod-derived type. Undeclared HTTP header values
use `string`, matching the Fetch API. Do not set a multipart
`Content-Type` header yourself. The client validates the serialized form before
sending it.

Only registered JSON operations belong to this SDK. File download streams and
browser page navigation retain their existing interfaces. This workspace package
exports TypeScript source and is private; publishing a standalone npm package
would require a separate build and release setup.
