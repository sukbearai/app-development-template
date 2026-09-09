import { mkdir, writeFile } from "node:fs/promises";
import { apiRoutes, buildOpenApiDocument, buildApiMarkdown } from "./api-contracts.mjs";

const docs = new URL("../../../docs/", import.meta.url);
await mkdir(docs, { recursive: true });
await writeFile(
  new URL("openapi.json", docs),
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
);
await writeFile(new URL("api.md", docs), buildApiMarkdown());
console.log(`generated docs/openapi.json and docs/api.md (${apiRoutes.length} operations)`);
